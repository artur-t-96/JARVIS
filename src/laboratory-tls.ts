import "reflect-metadata";
import {
  X509CertificateGenerator,
  BasicConstraintsExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  SubjectKeyIdentifierExtension,
  AuthorityKeyIdentifierExtension,
  SubjectAlternativeNameExtension,
  ExtendedKeyUsageExtension,
  ExtendedKeyUsage,
} from "@peculiar/x509";
import {
  createHash,
  randomBytes,
  X509Certificate,
  createPrivateKey,
} from "node:crypto";
import { createServer, get, type Server } from "node:https";
import { createSecureContext, type TLSSocket } from "node:tls";
import type { DatabaseSync } from "node:sqlite";
import { type JsonObject } from "./contracts.js";
import { LaboratoryKeyring } from "./laboratory-keyring.js";

export type CertificateFailure = "expired" | "wrong_name" | "untrusted";
export interface CertificateMetadata extends JsonObject {
  fingerprint: string;
  issuer: string;
  subject: string;
  validFrom: string;
  validTo: string;
}
export interface TlsObservation extends JsonObject {
  authorized: boolean;
  serverName: string;
  errorCode: string | null;
  peerFingerprint: string | null;
  trustedCaFingerprint: string;
  configuredCertificate: CertificateMetadata;
}
interface Material {
  cert: string;
  encryptedKey: string;
}
interface SavedMaterial {
  cert_pem: string;
  encrypted_key: string;
  version: number;
}
const algorithm = { name: "ECDSA", namedCurve: "P-256" },
  signingAlgorithm = { name: "ECDSA", hash: "SHA-256" };
const day = 86_400_000;
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const nameFor = (tenant: string) =>
  `t-${digest(tenant).slice(0, 40)}.jarvis.invalid`;
const metadata = (pem: string): CertificateMetadata => {
  const cert = new X509Certificate(pem);
  return {
    fingerprint: digest(cert.raw),
    subject: cert.subject,
    issuer: cert.issuer,
    validFrom: new Date(cert.validFrom).toISOString(),
    validTo: new Date(cert.validTo).toISOString(),
  };
};

/** Only this fixture owns the listener, names, CA and certificates. It has no URL input. */
export class LaboratoryTls {
  private readonly server: Server;
  private port = 0;
  private readonly token = randomBytes(32).toString("hex");
  private readonly initializing = new Map<string, Promise<void>>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly keyring: LaboratoryKeyring,
  ) {
    this.server = createServer(
      {
        minVersion: "TLSv1.2",
        handshakeTimeout: 3000,
        SNICallback: (name, callback) => {
          try {
            const row = this.db
              .prepare(
                "SELECT tenant_id,cert_pem,encrypted_key FROM laboratory_tls_state WHERE server_name=?",
              )
              .get(name) as (SavedMaterial & { tenant_id: string }) | undefined;
            if (!row) throw new Error("Unknown laboratory name");
            const key = this.keyring.open(
              row.encrypted_key,
              row.tenant_id + ":leaf:" + digest(row.cert_pem),
            );
            callback(
              null,
              createSecureContext({
                cert: row.cert_pem,
                key: createPrivateKey({
                  key,
                  format: "der",
                  type: "pkcs8",
                }).export({ type: "pkcs8", format: "pem" }),
                minVersion: "TLSv1.2",
              }),
            );
          } catch {
            callback(new Error("Laboratory certificate unavailable"));
          }
        },
      },
      (req, res) => {
        let tenant: string;
        try {
          tenant = decodeURIComponent((req.url ?? "").slice("/health/".length));
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        const socket = req.socket as TLSSocket;
        if (
          req.method !== "GET" ||
          !req.url?.startsWith("/health/") ||
          req.headers.authorization !== `Bearer ${this.token}` ||
          socket.servername !== nameFor(tenant)
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        const state = this.state(tenant);
        if (!state.certificate) {
          res.writeHead(503);
          res.end();
          return;
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            fixture: "jarvis-local-tls",
            version: state.version,
            fingerprint: state.certificate.fingerprint,
          }),
        );
      },
    );
    // Failed handshakes are an expected test result; never emit raw certificate/key errors.
    this.server.on("tlsClientError", () => {});
    this.server.requestTimeout = 3000;
    this.server.headersTimeout = 3000;
    this.server.maxConnections = 32;
  }
  static migrate(db: DatabaseSync) {
    db.exec(`CREATE TABLE laboratory_tls_ca(tenant_id TEXT PRIMARY KEY,cert_pem TEXT NOT NULL,encrypted_key TEXT NOT NULL);
      CREATE TABLE laboratory_tls_state(tenant_id TEXT PRIMARY KEY,server_name TEXT NOT NULL UNIQUE,cert_pem TEXT NOT NULL,encrypted_key TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=0));`);
  }
  get listening() {
    return this.server.listening;
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw Error("TLS fixture unavailable");
    this.port = address.port;
  }
  private async ca(
    tenant: string,
    temporary = false,
  ): Promise<{ cert: string; key: CryptoKey }> {
    const saved =
      !temporary &&
      (this.db
        .prepare("SELECT * FROM laboratory_tls_ca WHERE tenant_id=?")
        .get(tenant) as
        false | { cert_pem: string; encrypted_key: string } | undefined);
    if (saved) {
      const bytes = this.keyring.open(
        saved.encrypted_key,
        tenant + ":ca:" + digest(saved.cert_pem),
      );
      const key = await crypto.subtle.importKey(
        "pkcs8",
        new Uint8Array(bytes),
        algorithm,
        true,
        ["sign"],
      );
      return { cert: saved.cert_pem, key };
    }
    const pair = (await crypto.subtle.generateKey(algorithm, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const now = Date.now(),
      cert = await X509CertificateGenerator.createSelfSigned({
        name: `CN=JARVIS laboratory ${digest(tenant).slice(0, 16)}${temporary ? " untrusted" : ""}`,
        keys: pair,
        signingAlgorithm,
        notBefore: new Date(now - day),
        notAfter: new Date(now + 3650 * day),
        extensions: [
          new BasicConstraintsExtension(true, 0, true),
          new KeyUsagesExtension(
            KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign,
            true,
          ),
          await SubjectKeyIdentifierExtension.create(pair.publicKey),
        ],
      });
    const pem = cert.toString("pem");
    if (!temporary) {
      const encrypted = this.keyring.seal(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
        tenant + ":ca:" + digest(pem),
        this.db.prepare("SELECT count(*) n FROM laboratory_tls_ca").get()!.n ===
          0,
      );
      this.db
        .prepare("INSERT INTO laboratory_tls_ca VALUES(?,?,?)")
        .run(tenant, pem, encrypted);
    }
    return { cert: pem, key: pair.privateKey };
  }
  async ensure(tenant: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM laboratory_tls_state WHERE tenant_id=?")
        .get(tenant)
    )
      return;
    let pending = this.initializing.get(tenant);
    if (!pending) {
      pending = (async () => {
        const material = await this.prepare(tenant, "expired");
        this.db
          .prepare("INSERT INTO laboratory_tls_state VALUES(?,?,?,?,0)")
          .run(tenant, nameFor(tenant), material.cert, material.encryptedKey);
      })();
      this.initializing.set(tenant, pending);
    }
    try {
      await pending;
    } finally {
      this.initializing.delete(tenant);
    }
  }
  async prepare(
    tenant: string,
    mode: CertificateFailure | "valid",
  ): Promise<Material> {
    const trusted = await this.ca(tenant),
      issuer = mode === "untrusted" ? await this.ca(tenant, true) : trusted;
    const pair = (await crypto.subtle.generateKey(algorithm, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const now = Date.now(),
      name =
        mode === "wrong_name" ? `wrong.${nameFor(tenant)}` : nameFor(tenant);
    const cert = await X509CertificateGenerator.create({
      subject: `CN=${name}`,
      issuer: new X509Certificate(issuer.cert).subject,
      publicKey: pair.publicKey,
      signingKey: issuer.key,
      signingAlgorithm,
      notBefore: new Date(now - (mode === "expired" ? 2 * day : 60000)),
      notAfter: new Date(now + (mode === "expired" ? -day : 30 * day)),
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]),
        new SubjectAlternativeNameExtension([{ type: "dns", value: name }]),
        await SubjectKeyIdentifierExtension.create(pair.publicKey),
        await AuthorityKeyIdentifierExtension.create(
          new X509Certificate(issuer.cert).publicKey.export({
            type: "spki",
            format: "der",
          }),
        ),
      ],
    });
    const pem = cert.toString("pem");
    return {
      cert: pem,
      encryptedKey: this.keyring.seal(
        await crypto.subtle.exportKey("pkcs8", pair.privateKey),
        tenant + ":leaf:" + digest(pem),
      ),
    };
  }
  state(tenant: string) {
    const row = this.db
      .prepare("SELECT * FROM laboratory_tls_state WHERE tenant_id=?")
      .get(tenant) as SavedMaterial | undefined;
    const ca = this.db
      .prepare("SELECT cert_pem FROM laboratory_tls_ca WHERE tenant_id=?")
      .get(tenant) as { cert_pem: string } | undefined;
    if (!row || !ca)
      return {
        healthy: false,
        version: 0,
        certificate: null,
        keyAvailable: false,
        serverName: nameFor(tenant),
        trustedCaFingerprint: null,
      };
    const cert = new X509Certificate(row.cert_pem),
      issuer = new X509Certificate(ca.cert_pem),
      certificate = metadata(row.cert_pem),
      now = Date.now();
    let keyAvailable = false;
    try {
      this.keyring.open(
        row.encrypted_key,
        tenant + ":leaf:" + digest(row.cert_pem),
      );
      keyAvailable = true;
    } catch {
      /* A restored database cannot prove readiness without its separate key. */
    }
    return {
      healthy:
        keyAvailable &&
        cert.verify(issuer.publicKey) &&
        Date.parse(issuer.validFrom) <= now &&
        Date.parse(issuer.validTo) > now &&
        !!cert.checkHost(nameFor(tenant)) &&
        Date.parse(certificate.validFrom) <= now &&
        Date.parse(certificate.validTo) > now,
      version: row.version,
      certificate,
      keyAvailable,
      serverName: nameFor(tenant),
      trustedCaFingerprint: metadata(ca.cert_pem).fingerprint,
    };
  }
  apply(tenant: string, version: number, material: Material) {
    this.db
      .prepare(
        "UPDATE laboratory_tls_state SET cert_pem=?,encrypted_key=?,version=? WHERE tenant_id=?",
      )
      .run(material.cert, material.encryptedKey, version, tenant);
    return metadata(material.cert);
  }
  async inspect(
    tenant: string,
    signal: AbortSignal,
  ): Promise<{
    healthy: boolean;
    version: number;
    httpStatus: number | null;
    tls: TlsObservation;
  }> {
    signal.throwIfAborted();
    await this.ensure(tenant);
    signal.throwIfAborted();
    const state = this.state(tenant);
    if (!state.certificate || !state.trustedCaFingerprint)
      throw Error("Certificate fixture missing");
    const ca = this.db
      .prepare("SELECT cert_pem FROM laboratory_tls_ca WHERE tenant_id=?")
      .get(tenant) as { cert_pem: string };
    const base: TlsObservation = {
      authorized: false,
      serverName: state.serverName,
      errorCode: null,
      peerFingerprint: null,
      trustedCaFingerprint: state.trustedCaFingerprint,
      configuredCertificate: state.certificate,
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: {
        healthy: boolean;
        version: number;
        httpStatus: number | null;
        tls: TlsObservation;
      }) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      const request = get(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: "/health/" + encodeURIComponent(tenant),
          servername: state.serverName,
          ca: ca.cert_pem,
          rejectUnauthorized: true,
          agent: false,
          minVersion: "TLSv1.2",
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        },
        (response) => {
          const socket = response.socket as TLSSocket,
            peer = socket.getPeerX509Certificate(),
            peerFingerprint = peer ? digest(peer.raw) : null;
          let text = "";
          const incomplete = () =>
            finish({
              healthy: false,
              version: state.version,
              httpStatus: response.statusCode ?? null,
              tls: { ...base, errorCode: "RESULT_MISMATCH" },
            });
          response.once("aborted", incomplete);
          response.once("error", incomplete);
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += String(chunk);
            if (text.length > 4096)
              request.destroy(new Error("Response too large"));
          });
          response.on("end", () => {
            try {
              const body = JSON.parse(text);
              const healthy =
                socket.authorized &&
                response.statusCode === 200 &&
                body.fixture === "jarvis-local-tls" &&
                body.version === state.version &&
                body.fingerprint === peerFingerprint &&
                peerFingerprint === state.certificate!.fingerprint;
              finish({
                healthy,
                version: state.version,
                httpStatus: response.statusCode ?? null,
                tls: {
                  ...base,
                  authorized: socket.authorized,
                  peerFingerprint,
                  errorCode: healthy ? null : "RESULT_MISMATCH",
                },
              });
            } catch {
              finish({
                healthy: false,
                version: state.version,
                httpStatus: response.statusCode ?? null,
                tls: { ...base, errorCode: "RESULT_MISMATCH" },
              });
            }
          });
        },
      );
      request.on("error", (cause) => {
        if (signal.aborted) {
          if (!settled) {
            settled = true;
            reject(signal.reason);
          }
          return;
        }
        const code = (cause as NodeJS.ErrnoException).code;
        const known = [
          "CERT_HAS_EXPIRED",
          "CERT_NOT_YET_VALID",
          "ERR_TLS_CERT_ALTNAME_INVALID",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "SELF_SIGNED_CERT_IN_CHAIN",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
        ];
        finish({
          healthy: false,
          version: state.version,
          httpStatus: null,
          tls: {
            ...base,
            errorCode: !state.keyAvailable
              ? "LAB_TLS_KEY_UNAVAILABLE"
              : known.includes(code ?? "")
                ? code!
                : "TLS_UNAVAILABLE",
          },
        });
      });
    });
  }
  async close() {
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}
