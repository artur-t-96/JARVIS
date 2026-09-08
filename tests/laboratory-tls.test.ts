import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, renameSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LaboratoryTls } from "../src/laboratory-tls.js";
import { LaboratoryKeyring } from "../src/laboratory-keyring.js";
import { itCaseFixture } from "./helpers/it-case-fixture.js";
import { laboratoryTlsTarget } from "../src/laboratory-contract.js";

test("actual TLS rejects expired, wrong-name and untrusted certificates and accepts its own chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-tls-check-")),
    db = new DatabaseSync(join(dir, "tls.sqlite"));
  LaboratoryTls.migrate(db);
  const keyring = new LaboratoryKeyring(join(dir, "wrapping.key"));
  let tls = new LaboratoryTls(db, keyring);
  await tls.start();
  const signal = new AbortController().signal;
  try {
    const expired = await tls.inspect("alpha", signal);
    assert.equal(expired.healthy, false);
    assert.equal(expired.tls.errorCode, "CERT_HAS_EXPIRED");
    assert.equal(expired.tls.peerFingerprint, null);
    for (const [mode, error] of [
      ["wrong_name", "ERR_TLS_CERT_ALTNAME_INVALID"],
      ["untrusted", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
      ["valid", null],
    ] as const) {
      const material = await tls.prepare("alpha", mode);
      tls.apply("alpha", tls.state("alpha").version + 1, material);
      const result = await tls.inspect("alpha", signal);
      assert.equal(result.healthy, mode === "valid", JSON.stringify(result));
      assert.equal(result.tls.authorized, mode === "valid");
      assert.equal(result.tls.errorCode, error);
    }
    const good = await tls.inspect("alpha", signal),
      other = await tls.inspect("beta", signal);
    assert.notEqual(
      good.tls.trustedCaFingerprint,
      other.tls.trustedCaFingerprint,
    );
    assert.notEqual(good.tls.serverName, other.tls.serverName);
    assert.equal(other.healthy, false);
    await tls.close();
    tls = new LaboratoryTls(db, keyring);
    await tls.start();
    const restored = await tls.inspect("alpha", signal);
    assert.equal(restored.healthy, true);
    assert.equal(restored.tls.peerFingerprint, good.tls.peerFingerprint);
    assert.equal(restored.version, good.version);
    const rows = db.prepare("SELECT * FROM laboratory_tls_state").all();
    assert.doesNotMatch(JSON.stringify(rows), /BEGIN .*PRIVATE KEY/);
    assert.doesNotMatch(
      readFileSync(join(dir, "tls.sqlite")).toString("latin1"),
      /BEGIN .*PRIVATE KEY/,
    );
  } finally {
    await tls.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing installation key fails closed and cannot generate a replacement for stored certificates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-tls-key-")),
    db = new DatabaseSync(join(dir, "tls.sqlite"));
  LaboratoryTls.migrate(db);
  const keyPath = join(dir, "wrapping.key"),
    tls = new LaboratoryTls(db, new LaboratoryKeyring(keyPath));
  await tls.start();
  try {
    await tls.ensure("alpha");
    tls.apply("alpha", 1, await tls.prepare("alpha", "valid"));
    const before = tls.state("alpha");
    renameSync(keyPath, keyPath + ".separate");
    const result = await tls.inspect("alpha", new AbortController().signal);
    assert.equal(result.healthy, false);
    assert.equal(result.tls.errorCode, "LAB_TLS_KEY_UNAVAILABLE");
    await assert.rejects(
      () => tls.prepare("alpha", "valid"),
      /prywatnego klucza/,
    );
    assert.equal(tls.state("alpha").healthy, false);
    assert.equal(
      tls.state("alpha").certificate?.fingerprint,
      before.certificate?.fingerprint,
    );
    renameSync(keyPath + ".separate", keyPath);
    assert.equal(
      (await tls.inspect("alpha", new AbortController().signal)).healthy,
      true,
    );
  } finally {
    await tls.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two firms bind a real approved certificate renewal to the exact IT case and owner acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-tls-case-")),
    f = await itCaseFixture(dir, { target: laboratoryTlsTarget });
  try {
    for (const tenant of ["synthetic-a", "synthetic-b"]) {
      const id = await f.open(tenant),
        before = f.view(id, tenant);
      assert.equal(
        before.laboratory.observed!.tls!.errorCode,
        "CERT_HAS_EXPIRED",
      );
      assert.equal(
        before.readiness.definitions[0]!.expected.testKey,
        "jarvis.lab.tls",
      );
      const done = await f.complete(
        "lab.renewCertificate",
        before.repairInput,
        "manager",
        tenant,
      );
      assert.equal(done.steps[0]!.verification!.ok, true);
      assert.equal(done.steps[0]!.attempts, 1);
      const result = f.view(id, tenant);
      assert.equal(result.proofs[0]!.identity.current, true);
      assert.notEqual(
        (result.proofs[0]!.identity.tls as any).peerFingerprint,
        before.repairInput.expectedFingerprint,
      );
      assert.equal(result.readiness.ready, false);
      await f.bind(id, tenant);
      await f.complete(
        "ops.cases.submit",
        { id, expectedVersion: 2 },
        "manager",
        tenant,
      );
      await f.complete(
        "ops.cases.accept",
        {
          id,
          expectedVersion: 3,
          decision: "accepted",
          note: "Synthetic owner receives HTTPS and certificate result",
          humanDecision: true,
        },
        "manager",
        tenant,
      );
      assert.equal(f.view(id, tenant).readiness.acceptanceCurrent, true);
      assert.equal(
        f.workspace.laboratoryOverview(f.actor("manager", tenant)).observed,
        null,
        "TLS observation cannot label HTTP healthy",
      );
    }
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
