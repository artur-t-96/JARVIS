import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  LaboratoryTls,
  type CertificateFailure,
  type TlsObservation,
} from "./laboratory-tls.js";
import { LaboratoryKeyring } from "./laboratory-keyring.js";
import { z } from "zod";
import { hash } from "./engine.js";
import { migrateDatabase } from "./migrations.js";
import {
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  type JsonObject,
  type Verification,
  DomainError,
} from "./contracts.js";
import {
  laboratoryCaseInputSchema,
  laboratoryFreshnessMs,
  laboratoryTarget,
  laboratoryTlsTarget,
  laboratoryDefinition,
  type LaboratoryTarget,
  type LaboratoryCasePolicy,
  type LaboratoryProofSource,
  type StepEvidenceReader,
} from "./laboratory-contract.js";

type Observation = JsonObject & {
  id: string;
  fixture: LaboratoryTarget;
  healthy: boolean;
  version: number;
  httpStatus: number | null;
  observedAt: string;
  environment: "jarvis-laboratory";
  check: "http" | "tls" | "unreachable";
  tls?: TlsObservation;
};
interface StoredObservation {
  observation: Observation;
  runId: string;
  stepId: string;
  operationKey: string;
  toolId: string;
  toolVersion: string;
  actorId: string | null;
  approvedBy: string | null;
  caseId: string | null;
  scopeRevision: number | null;
  scopeHash: string | null;
  inputHash: string;
  input: JsonObject;
  outputHash: string;
  verificationHash: string;
}
const observationEvidence = (observation: Observation) => ({
  source: `jarvis-laboratory/${observation.fixture === laboratoryTlsTarget ? "tls" : "http"}`,
  summary: `HTTP ${observation.httpStatus}`,
  observedAt: observation.observedAt,
  data: observation,
});

/** A real HTTP fixture owned entirely by this JARVIS installation, never another application. */
export class LocalLaboratory {
  private db: DatabaseSync;
  private server: Server;
  private readonly tls: LaboratoryTls;
  private token = randomBytes(32).toString("hex");
  private origin = "";
  private casePolicy?: LaboratoryCasePolicy;
  private outcome?: StepEvidenceReader;
  constructor(
    path: string,
    private options: { clock?: () => number } = {},
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    migrateDatabase(this.db, {
      namespace: "laboratory",
      migrations: [
        {
          version: 1,
          name: "isolated service fixture and effect ledger",
          up: (db) =>
            db.exec(
              "CREATE TABLE IF NOT EXISTS laboratory_state(tenant_id TEXT PRIMARY KEY,healthy INTEGER NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS laboratory_effects(tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(tenant_id,operation_key));",
            ),
        },
        {
          version: 2,
          name: "Immutable observations and scoped case test provenance",
          up: (db) =>
            db.exec(`
            CREATE TABLE laboratory_observations(
              tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT,
              record_json TEXT NOT NULL,record_hash TEXT NOT NULL,
              PRIMARY KEY(tenant_id,id));
            CREATE INDEX laboratory_case_observations ON laboratory_observations(tenant_id,case_id);
          `),
        },
        {
          version: 3,
          name: "Private certificate fixture and wrapped signing keys",
          up: LaboratoryTls.migrate,
        },
      ],
    });
    this.tls = new LaboratoryTls(
      this.db,
      new LaboratoryKeyring(join(dirname(path), "laboratory-wrapping.key")),
    );
    this.server = createServer((req, res) => {
      if (
        req.headers.authorization !== `Bearer ${this.token}` ||
        req.method !== "GET"
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let tenant: string;
      try {
        tenant = decodeURIComponent((req.url ?? "").replace(/^\/health\//, ""));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const row = this.state(tenant);
      res.writeHead(row.healthy ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          fixture: "jarvis-local-service",
          healthy: row.healthy,
          version: row.version,
        }),
      );
    });
  }
  setCasePolicy(policy: LaboratoryCasePolicy) {
    this.casePolicy = policy;
  }
  setOutcomeReader(reader: StepEvidenceReader) {
    this.outcome = reader;
  }
  private now() {
    return new Date(this.options.clock?.() ?? Date.now()).toISOString();
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Lab failed");
    this.origin = `http://127.0.0.1:${address.port}`;
    await this.tls.start();
  }
  private state(tenantId: string, target: LaboratoryTarget = laboratoryTarget) {
    if (target === laboratoryTlsTarget) return this.tls.state(tenantId);
    const r = this.db
      .prepare("SELECT * FROM laboratory_state WHERE tenant_id=?")
      .get(tenantId) as { healthy: number; version: number } | undefined;
    return {
      healthy: Boolean(r?.healthy),
      version: r?.version ?? 0,
      certificate: null,
      keyAvailable: true,
    };
  }
  private async inspect(
    ctx: ToolContext,
    target: LaboratoryTarget = laboratoryTarget,
  ): Promise<Observation> {
    ctx.signal.throwIfAborted();
    const base = {
      id: randomUUID(),
      fixture: target,
      environment: "jarvis-laboratory" as const,
    };
    if (target === laboratoryTlsTarget) {
      const observed = await this.tls.inspect(ctx.tenantId, ctx.signal);
      return { ...base, ...observed, observedAt: this.now(), check: "tls" };
    }
    try {
      const response = await fetch(
        `${this.origin}/health/${encodeURIComponent(ctx.tenantId)}`,
        {
          redirect: "error",
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(3000)]),
          headers: { authorization: `Bearer ${this.token}` },
        },
      );
      const body = z
        .object({
          fixture: z.literal("jarvis-local-service"),
          healthy: z.boolean(),
          version: z.number().int().nonnegative(),
        })
        .parse(await response.json());
      if (response.status !== (body.healthy ? 200 : 503))
        throw new Error("Inconsistent lab health");
      return {
        ...base,
        ...body,
        httpStatus: response.status,
        observedAt: this.now(),
        check: "http",
      };
    } catch {
      ctx.signal.throwIfAborted();
      return {
        ...base,
        healthy: false,
        version: this.state(ctx.tenantId).version,
        httpStatus: null,
        observedAt: this.now(),
        check: "unreachable",
      };
    }
  }
  private record(
    ctx: ToolContext,
    input: JsonObject,
    result: ToolResult,
    verification: Verification,
    observation: Observation,
    toolId: string,
    toolVersion: string,
  ) {
    const record: StoredObservation = {
      observation,
      runId: ctx.runId,
      stepId: ctx.stepId,
      operationKey: ctx.operationKey,
      toolId,
      toolVersion,
      actorId: ctx.actorId ?? null,
      approvedBy: ctx.approvedBy ?? null,
      caseId:
        toolId === laboratoryDefinition(observation.fixture).procedureId
          ? String(input.caseId)
          : null,
      scopeRevision:
        toolId === laboratoryDefinition(observation.fixture).procedureId
          ? Number(input.scopeRevision)
          : null,
      scopeHash:
        toolId === laboratoryDefinition(observation.fixture).procedureId
          ? String(input.scopeHash)
          : null,
      input,
      inputHash: hash(input),
      outputHash: hash(result),
      verificationHash: hash(verification),
    };
    this.db
      .prepare("INSERT INTO laboratory_observations VALUES(?,?,?,?,?)")
      .run(
        ctx.tenantId,
        observation.id,
        record.caseId,
        JSON.stringify(record),
        hash(record),
      );
  }
  private readObservation(tenant: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT record_json,record_hash FROM laboratory_observations WHERE tenant_id=? AND id=?",
      )
      .get(tenant, id) as
      { record_json: string; record_hash: string } | undefined;
    if (!row)
      throw new DomainError(
        "LAB_OBSERVATION_NOT_FOUND",
        "Brak obserwacji w tej firmie.",
        404,
      );
    const record = JSON.parse(row.record_json) as StoredObservation;
    if (
      record.observation.id !== id ||
      hash(record) !== row.record_hash ||
      hash(record.input) !== record.inputHash
    )
      throw new DomainError(
        "LAB_OBSERVATION_INVALID",
        "Niespójny zapis obserwacji laboratorium.",
        409,
      );
    return { record, hash: row.record_hash };
  }
  private verified(tenant: string, record: StoredObservation) {
    const outcome = this.outcome?.(tenant, record.runId, record.stepId);
    return !!outcome?.succeeded && this.matchesOutcome(tenant, record);
  }
  private matchesOutcome(tenant: string, record: StoredObservation) {
    const outcome = this.outcome?.(tenant, record.runId, record.stepId);
    return (
      !!outcome &&
      outcome.toolId === record.toolId &&
      outcome.requestedBy === record.actorId &&
      outcome.approvedBy === record.approvedBy &&
      outcome.operationKey === record.operationKey &&
      outcome.toolVersion === record.toolVersion &&
      outcome.inputHash === record.inputHash &&
      outcome.outputHash === record.outputHash &&
      outcome.evidenceHashes.includes(
        hash(observationEvidence(record.observation)),
      ) &&
      outcome.verificationHash === record.verificationHash
    );
  }
  private fresh(observation: Observation, now: string) {
    const age = Date.parse(now) - Date.parse(observation.observedAt);
    return (
      age >= 0 &&
      age <= laboratoryFreshnessMs &&
      (observation.fixture === laboratoryTlsTarget
        ? this.tls.listening
        : this.server.listening)
    );
  }
  view(
    tenant: string,
    now = this.now(),
    target: LaboratoryTarget = laboratoryTarget,
  ) {
    const row = this.db
      .prepare(
        "SELECT id FROM laboratory_observations WHERE tenant_id=? AND json_extract(record_json,'$.observation.fixture')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(tenant, target) as { id: string } | undefined;
    const saved = row ? this.readObservation(tenant, row.id) : undefined;
    const current = this.state(tenant, target);
    return {
      ...laboratoryDefinition(target),
      freshnessSeconds: laboratoryFreshnessMs / 1000,
      observed: saved
        ? {
            ...saved.record.observation,
            hash: saved.hash,
            runId: saved.record.runId,
            current:
              this.fresh(saved.record.observation, now) &&
              current.version === saved.record.observation.version &&
              (target !== laboratoryTlsTarget ||
                (current.keyAvailable &&
                  current.certificate?.fingerprint ===
                    saved.record.observation.tls?.configuredCertificate
                      .fingerprint)),
            verified: this.verified(tenant, saved.record),
          }
        : null,
    };
  }
  diagnosis(
    tenant: string,
    id: string,
    expectedHash: string,
    now: string,
    target: LaboratoryTarget = laboratoryTarget,
  ): JsonObject {
    const saved = this.readObservation(tenant, id),
      observation = saved.record.observation;
    if (
      observation.fixture !== target ||
      saved.hash !== expectedHash ||
      !this.verified(tenant, saved.record) ||
      !this.fresh(observation, now) ||
      this.state(tenant, target).version !== observation.version ||
      observation.healthy
    )
      throw new DomainError(
        "LAB_DIAGNOSIS_STALE",
        "Sprawa wymaga aktualnej, zweryfikowanej obserwacji awarii tej usługi.",
        409,
      );
    return {
      ...observation,
      hash: saved.hash,
      runId: saved.record.runId,
      stepId: saved.record.stepId,
    };
  }
  proof(
    tenant: string,
    id: string,
    caseId: string,
    revision: number,
    now: string,
  ): LaboratoryProofSource {
    const saved = this.readObservation(tenant, id),
      r = saved.record,
      observation = r.observation;
    const effect = this.db
      .prepare(
        "SELECT input_hash,result_json FROM laboratory_effects WHERE tenant_id=? AND operation_key=?",
      )
      .get(tenant, r.operationKey) as
      { input_hash: string; result_json: string } | undefined;
    if (
      r.toolId !== laboratoryDefinition(observation.fixture).procedureId ||
      r.toolVersion !== "1" ||
      r.caseId !== caseId ||
      r.scopeRevision !== revision ||
      !r.approvedBy ||
      !r.actorId ||
      !effect ||
      effect.input_hash !== hash({ healthy: true, input: r.input }) ||
      hash(JSON.parse(effect.result_json)) !== r.outputHash ||
      !this.verified(tenant, r)
    )
      throw new DomainError(
        "LAB_PROOF_UNVERIFIED",
        "Dowód nie potwierdza zatwierdzonej naprawy i zakończonej weryfikacji tej sprawy.",
        409,
      );
    const state = this.state(tenant, observation.fixture),
      last = this.view(tenant, now, observation.fixture).observed;
    const current =
      this.fresh(observation, now) &&
      observation.healthy &&
      observation.httpStatus === 200 &&
      state.healthy &&
      state.version === observation.version &&
      !!last?.healthy &&
      last.version === state.version &&
      (observation.fixture !== laboratoryTlsTarget ||
        (observation.tls?.authorized === true &&
          observation.tls.peerFingerprint === state.certificate?.fingerprint));
    return {
      title: `Test ${laboratoryDefinition(observation.fixture).protocol} po naprawie · ${observation.observedAt}`,
      version: 1,
      revision,
      hash: saved.hash,
      identity: {
        ...observation,
        caseId,
        scopeRevision: revision,
        scopeHash: r.scopeHash,
        procedureId: r.toolId,
        procedureVersion: r.toolVersion,
        runId: r.runId,
        stepId: r.stepId,
        requestedBy: r.actorId,
        approvedBy: r.approvedBy,
        current,
      },
    };
  }
  proofs(tenant: string, caseId: string, revision: number, now: string) {
    const rows = this.db
      .prepare(
        "SELECT id FROM laboratory_observations WHERE tenant_id=? AND case_id=? ORDER BY rowid DESC LIMIT 20",
      )
      .all(tenant, caseId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      try {
        return [{ id, ...this.proof(tenant, id, caseId, revision, now) }];
      } catch {
        return [];
      }
    });
  }
  testHistory(tenant: string, caseId: string) {
    const rows = this.db
      .prepare(
        "SELECT id FROM laboratory_observations WHERE tenant_id=? AND case_id=? ORDER BY rowid DESC LIMIT 20",
      )
      .all(tenant, caseId) as { id: string }[];
    return rows.map(({ id }) => {
      const r = this.readObservation(tenant, id).record;
      return {
        id,
        runId: r.runId,
        scopeRevision: r.scopeRevision,
        observedAt: r.observation.observedAt,
        httpStatus: r.observation.httpStatus,
        tlsErrorCode: r.observation.tls?.errorCode ?? null,
        result: this.verified(tenant, r)
          ? "positive"
          : this.matchesOutcome(tenant, r)
            ? "negative"
            : "unconfirmed",
      };
    });
  }
  private effect(ctx: ToolContext, input: unknown) {
    const r = this.db
      .prepare(
        "SELECT * FROM laboratory_effects WHERE tenant_id=? AND operation_key=?",
      )
      .get(ctx.tenantId, ctx.operationKey) as
      { input_hash: string; result_json: string } | undefined;
    if (r && r.input_hash !== hash(input))
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Konflikt operacji laboratorium.",
        409,
      );
    return r ? (JSON.parse(r.result_json) as ToolResult) : undefined;
  }
  tools(): ToolDefinition[] {
    const inspect = (target: LaboratoryTarget): ToolDefinition => ({
      id: laboratoryDefinition(target).inspectTool,
      scope: "it",
      version: "1",
      description:
        target === laboratoryTlsTarget
          ? "Sprawdź certyfikat i HTTPS własnego laboratorium JARVIS"
          : "Sprawdź HTTP własnego laboratorium JARVIS",
      effect: "read",
      recovery: "idempotent",
      inputSchema: z.object({}).strict(),
      execute: async (ctx) => ({ data: await this.inspect(ctx, target) }),
      verify: async (ctx, input, result) => {
        const verification: Verification = {
          ok: result.data.fixture === target,
          summary:
            "Odczytano faktyczny wynik połączenia z lokalną usługą testową.",
          evidence: [
            {
              source: `jarvis-laboratory/${target === laboratoryTlsTarget ? "tls" : "http"}`,
              summary: `HTTP ${result.data.httpStatus}`,
              observedAt: String(result.data.observedAt),
              data: result.data,
            },
          ],
        };
        this.record(
          ctx,
          input,
          result,
          verification,
          result.data as Observation,
          laboratoryDefinition(target).inspectTool,
          "1",
        );
        return verification;
      },
    });
    const change = (
      healthy: boolean,
      forCase = false,
      target: LaboratoryTarget = laboratoryTarget,
    ): ToolDefinition => ({
      id: forCase
        ? laboratoryDefinition(target).procedureId
        : healthy
          ? "lab.repair"
          : laboratoryDefinition(target).failureTool,
      scope: "it",
      version: forCase || target === laboratoryTlsTarget ? "1" : "2",
      ...(forCase
        ? {
            requiredScopes: ["cases"],
            canAccess: (principal, input) =>
              this.casePolicy?.canAccess(principal, input) ?? false,
          }
        : {}),
      description:
        target === laboratoryTlsTarget
          ? forCase
            ? "Odnów certyfikat w zatwierdzonym zakresie sprawy IT"
            : "Wprowadź kontrolowany błąd certyfikatu własnego laboratorium"
          : forCase
            ? "Napraw własną usługę w zatwierdzonym zakresie sprawy IT"
            : healthy
              ? "Przywróć usługę w laboratorium JARVIS"
              : "Wprowadź kontrolowaną awarię własnego laboratorium",
      effect: "write",
      recovery: "idempotent",
      inputSchema: forCase
        ? laboratoryCaseInputSchema.refine(
            (input) => input.targetId === target,
            "Wrong laboratory target",
          )
        : target === laboratoryTlsTarget
          ? z
              .object({
                expectedVersion: z.number().int().nonnegative(),
                expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
                failure: z.enum(["expired", "wrong_name", "untrusted"]),
              })
              .strict()
          : z
              .object({ expectedVersion: z.number().int().nonnegative() })
              .strict(),
      execute: async (ctx, input) => {
        ctx.signal.throwIfAborted();
        if (forCase) this.authorizeCase(ctx, input);
        const cached = this.effect(ctx, { healthy, input });
        if (cached) return cached;
        if (target === laboratoryTlsTarget) {
          const state = this.state(ctx.tenantId, target);
          if (
            state.version !== input.expectedVersion ||
            state.certificate?.fingerprint !== input.expectedFingerprint
          )
            throw new DomainError(
              "LAB_CERTIFICATE_CHANGED",
              "Certyfikat zmienił się. Odczytaj go i przygotuj nowy plan.",
              409,
            );
        }
        const material =
          target === laboratoryTlsTarget
            ? await this.tls.prepare(
                ctx.tenantId,
                healthy ? "valid" : (input.failure as CertificateFailure),
              )
            : undefined;
        ctx.signal.throwIfAborted();
        if (forCase) this.authorizeCase(ctx, input);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const existing = this.effect(ctx, { healthy, input });
          if (existing) {
            this.db.exec("COMMIT");
            return existing;
          }
          if (forCase) {
            const observed = this.view(
              ctx.tenantId,
              this.now(),
              target,
            ).observed;
            if (
              !observed?.current ||
              !observed.verified ||
              observed.version !== input.expectedVersion
            )
              throw new DomainError(
                "LAB_OBSERVATION_STALE",
                "Przed naprawą odczytaj aktualny stan usługi i przygotuj nowy plan.",
                409,
              );
          }
          const current = this.state(ctx.tenantId, target);
          if (current.version !== input.expectedVersion)
            throw new DomainError(
              "VERSION_CONFLICT",
              "Stan laboratorium zmienił się. Sprawdź go ponownie.",
              409,
            );
          if (
            target === laboratoryTlsTarget &&
            current.certificate?.fingerprint !== input.expectedFingerprint
          )
            throw new DomainError(
              "LAB_CERTIFICATE_CHANGED",
              "Certyfikat zmienił się. Przygotuj nowy plan z aktualnym odciskiem.",
              409,
            );
          const version = current.version + 1;
          const certificate = material
            ? this.tls.apply(ctx.tenantId, version, material)
            : null;
          if (!material)
            this.db
              .prepare(
                "INSERT INTO laboratory_state VALUES(?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET healthy=excluded.healthy,version=excluded.version",
              )
              .run(ctx.tenantId, healthy ? 1 : 0, version);
          const result = {
            data: {
              fixture: target,
              healthy,
              version,
              environment: "jarvis-laboratory",
              ...(certificate ? { certificate } : {}),
              ...(forCase
                ? {
                    caseId: input.caseId!,
                    scopeRevision: input.scopeRevision!,
                    scopeHash: input.scopeHash!,
                  }
                : {}),
            },
          };
          this.db
            .prepare("INSERT INTO laboratory_effects VALUES(?,?,?,?)")
            .run(
              ctx.tenantId,
              ctx.operationKey,
              hash({ healthy, input }),
              JSON.stringify(result),
            );
          this.db.exec("COMMIT");
          return result;
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      },
      reconcile: async (ctx, input) => {
        if (forCase) this.authorizeCase(ctx, input, "reconcile");
        const result = this.effect(ctx, { healthy, input });
        return result
          ? { status: "applied", result }
          : { status: "not_applied" };
      },
      verify: async (ctx, input, result) => {
        if (forCase) this.authorizeCase(ctx, input);
        const observed = await this.inspect(ctx, target);
        const verification: Verification = {
          ok:
            (observed.check === "http" || observed.check === "tls") &&
            observed.healthy === healthy &&
            observed.version === result.data.version &&
            (target !== laboratoryTlsTarget ||
              (observed.tls?.configuredCertificate.fingerprint ===
                (result.data.certificate as JsonObject)?.fingerprint &&
                (healthy
                  ? observed.tls?.authorized === true
                  : input.failure === "expired"
                    ? observed.tls?.errorCode === "CERT_HAS_EXPIRED"
                    : input.failure === "wrong_name"
                      ? observed.tls?.errorCode ===
                        "ERR_TLS_CERT_ALTNAME_INVALID"
                      : observed.tls?.errorCode ===
                        "UNABLE_TO_VERIFY_LEAF_SIGNATURE"))),
          summary: "Niezależny test HTTP lokalnej usługi po operacji.",
          evidence: [
            {
              source: `jarvis-laboratory/${target === laboratoryTlsTarget ? "tls" : "http"}`,
              summary: `HTTP ${observed.httpStatus}`,
              observedAt: observed.observedAt,
              data: observed,
            },
          ],
        };
        this.record(
          ctx,
          input,
          result,
          verification,
          observed,
          forCase
            ? laboratoryDefinition(target).procedureId
            : healthy
              ? "lab.repair"
              : laboratoryDefinition(target).failureTool,
          forCase || target === laboratoryTlsTarget ? "1" : "2",
        );
        return verification;
      },
    });
    return [
      inspect(laboratoryTarget),
      inspect(laboratoryTlsTarget),
      change(false, false, laboratoryTlsTarget),
      change(true),
      change(false),
      ...(this.casePolicy
        ? [change(true, true), change(true, true, laboratoryTlsTarget)]
        : []),
    ];
  }
  private authorizeCase(
    ctx: ToolContext,
    input: JsonObject,
    purpose: "execute" | "reconcile" = "execute",
  ) {
    if (!this.casePolicy || !ctx.actorId || !ctx.approvedBy)
      throw new DomainError(
        "LAB_CASE_AUTHORITY_REQUIRED",
        "Naprawa sprawy wymaga operatora i zgody aktywnego konta.",
        403,
      );
    this.casePolicy.authorize(ctx, input, purpose);
  }
  async close() {
    await this.tls.close();
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
    this.db.close();
  }
}
