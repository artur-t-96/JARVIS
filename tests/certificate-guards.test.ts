import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { itCaseFixture } from "./helpers/it-case-fixture.js";
import { laboratoryTlsTarget } from "../src/laboratory-contract.js";
import { hash } from "../src/engine.js";

test("failed independent TLS verification preserves the committed effect and blocks business evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cert-negative-")),
    f = await itCaseFixture(dir, {
      target: laboratoryTlsTarget,
      wrap: (tool) =>
        tool.id === "lab.renewCertificate"
          ? {
              ...tool,
              async verify(ctx, input, result) {
                const db = new DatabaseSync(join(dir, "laboratory.sqlite"));
                db.prepare(
                  "UPDATE laboratory_tls_state SET encrypted_key='corrupted' WHERE tenant_id=?",
                ).run(ctx.tenantId);
                db.close();
                return tool.verify(ctx, input, result);
              },
            }
          : tool,
    });
  try {
    const id = await f.open(),
      failed = await f.failCommand(
        "lab.renewCertificate",
        f.view(id).repairInput,
      );
    assert.equal(failed.steps[0]!.verification!.ok, false);
    assert.equal(failed.steps[0]!.attempts, 1);
    assert.equal(f.view(id).proofs.length, 0);
    assert.equal(f.view(id).testHistory[0]!.result, "negative");
    assert.equal(f.view(id).readiness.ready, false);
    const db = new DatabaseSync(join(dir, "laboratory.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      db.prepare("SELECT count(*) n FROM laboratory_effects").get()!.n,
      1,
    );
    db.close();
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("certificate approval binds fingerprint and scope; refusal, change and cancellation cause no renewal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cert-guards-")),
    f = await itCaseFixture(dir, { target: laboratoryTlsTarget });
  try {
    const id = await f.open(),
      pins = f.view(id).repairInput;
    const refused = await f.stage("lab.renewCertificate", pins),
      a = refused.steps[0]!.approval!;
    f.engine.approve(f.actor("reviewer"), refused.id, {
      approvalId: a.id,
      bindingHash: a.bindingHash,
      decision: "rejected",
    });
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), refused.id).steps[0]!.attempts, 0);
    await f.failCommand("lab.renewCertificate", {
      ...pins,
      expectedFingerprint: "0".repeat(64),
    });
    assert.equal(
      f.view(id).repairInput.expectedFingerprint,
      pins.expectedFingerprint,
    );
    const changed = await f.stage("lab.renewCertificate", pins);
    await f.complete("lab.simulateCertificateFailure", {
      expectedVersion: pins.expectedVersion,
      expectedFingerprint: pins.expectedFingerprint,
      failure: "wrong_name",
    });
    f.approve(changed);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), changed.id).status, "completed");
    assert.equal(
      f.view(id).laboratory.observed!.tls!.errorCode,
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    assert.equal(f.view(id).proofs.length, 0);
    await f.failCommand("ops.cases.revise", {
      id,
      expectedVersion: 1,
      brief: "Remove TLS",
      acceptanceCriteria: "No TLS",
      reason: "Invalid test removal",
      requirements: [],
    });
    const oldScope = f.view(id).repairInput;
    await f.complete("ops.cases.revise", {
      id,
      expectedVersion: 1,
      brief: "Explicit changed hypothesis",
      acceptanceCriteria: "Same real TLS test",
      reason: "New operator scope",
    });
    await f.failCommand("lab.renewCertificate", oldScope);
    await f.complete("ops.cases.cancel", {
      id,
      expectedVersion: 2,
      reason: "Synthetic cancellation",
    });
    await f.failCommand("lab.renewCertificate", f.view(id).repairInput);
    assert.equal((await f.inspect()).version, 1);
    const db = new DatabaseSync(join(dir, "laboratory.sqlite"), {
      readOnly: true,
    });
    assert.equal(
      db.prepare("SELECT count(*) n FROM laboratory_effects").get()!.n,
      1,
    );
    db.close();
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rehashed observation cannot alter Core's actual verification evidence", async () => {
  for (const target of [undefined, laboratoryTlsTarget]) {
    const dir = mkdtempSync(join(tmpdir(), "jarvis-proof-integrity-")),
      f = await itCaseFixture(dir, { target });
    try {
      const id = await f.open(),
        tool = target ? "lab.renewCertificate" : "lab.repairCase";
      await f.complete(tool, f.view(id).repairInput);
      await f.bind(id);
      assert.equal(f.view(id).readiness.ready, true);
      const proof = f.view(id).proofs[0]!,
        db = new DatabaseSync(join(dir, "laboratory.sqlite"));
      const row = db
        .prepare("SELECT record_json FROM laboratory_observations WHERE id=?")
        .get(proof.id)!;
      const changed = JSON.parse(String(row.record_json));
      changed.observation.observedAt = new Date(
        Date.parse(changed.observation.observedAt) - 1000,
      ).toISOString();
      db.prepare(
        "UPDATE laboratory_observations SET record_json=?,record_hash=? WHERE id=?",
      ).run(JSON.stringify(changed), hash(changed), proof.id);
      db.close();
      assert.equal(f.view(id).proofs.length, 0);
      assert.equal(f.view(id).readiness.ready, false);
      assert.equal(f.view(id).laboratory.observed!.verified, false);
    } finally {
      await f.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a lost local key invalidates existing certificate acceptance before any new observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cert-key-proof-")),
    f = await itCaseFixture(dir, { target: laboratoryTlsTarget });
  try {
    const id = await f.open();
    await f.complete("lab.renewCertificate", f.view(id).repairInput);
    await f.bind(id);
    assert.equal(f.view(id).readiness.ready, true);
    const key = join(dir, "laboratory-wrapping.key");
    renameSync(key, key + ".separate");
    assert.equal(f.view(id).laboratory.observed!.current, false);
    assert.equal(f.view(id).readiness.ready, false);
    assert.equal(f.view(id).proofs[0]!.identity.current, false);
    renameSync(key + ".separate", key);
    assert.equal(f.view(id).readiness.ready, true);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
