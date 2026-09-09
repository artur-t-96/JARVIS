import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type ToolContext,
  type JsonObject,
} from "../src/contracts.js";
import { hash } from "../src/engine.js";
import { assetImportFixture, csvBody } from "./helpers/asset-import-fixture.js";
import { custodyNow } from "./helpers/custody-fixture.js";
const code = (expected: string) => (e: unknown) =>
  e instanceof DomainError && e.code === expected;
function fixture(
  t: test.TestContext,
  options: Parameters<typeof assetImportFixture>[1] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-import-")),
    f = assetImportFixture(dir, options);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, f };
}
const context = (key = randomUUID()): ToolContext => ({
  tenantId: "synthetic-a",
  actorId: "manager",
  approvedBy: "reviewer",
  runId: randomUUID(),
  stepId: "action",
  operationKey: key,
  signal: new AbortController().signal,
});
const sourcePath = (dir: string, id: string) =>
  join(
    dir,
    "attachments/asset-imports/saved",
    createHash("sha256").update("synthetic-a").digest("hex"),
    id,
    "content.csv",
  );
test("approved batches preserve raw source and serials in two firms; selected skips are explicit and physical custody remains empty", async (t) => {
  const { f } = fixture(t);
  const ids: string[] = [];
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    const actor = f.actor("manager", tenant),
      input = f.prepare(tenant),
      pending = await f.stage(
        "ops.assets.importBatch",
        input,
        "manager",
        tenant,
      );
    assert.equal(f.workspace.list(actor, "assets").length, 0);
    const proposal = f.workspace.assetImportProposal(
      f.actor("reviewer", tenant),
      actor.id,
      input,
    );
    assert.equal(proposal.status, "pending");
    if (proposal.status === "pending") {
      assert.equal(proposal.current, true);
      assert.equal(proposal.preview.rows[0]!.asset!.serial, "0000123");
    }
    f.approve(pending, tenant);
    await f.engine.tick();
    const r = f.engine.getRun(actor, pending.id);
    assert.equal(r.status, "completed", JSON.stringify(r));
    assert.equal(r.steps[0]!.verification?.ok, true);
    const report = f.workspace.assetImportReport(actor, String(input.uploadId));
    ids.push(report.id);
    assert.equal(report.valid, true);
    assert.equal(report.created.length, 2);
    assert.deepEqual(report.skippedRows, []);
    assert.deepEqual(
      f.workspace.assetImportSource(actor, report.id).body,
      csvBody,
    );
    for (const line of report.created) {
      const a = f.get("assets", line.id, tenant);
      assert.equal(a.version, 1);
      assert.deepEqual(a.data.allocations, []);
      assert.equal(a.data.personId, undefined);
      assert.equal(
        (a.data.importSource as JsonObject).sourceRow,
        line.sourceRow,
      );
      assert.equal(
        a.status,
        line.sourceRow === 1 ? "available" : "maintenance",
      );
    }
    const mixed = Buffer.concat([
      csvBody,
      Buffer.from(
        "New phone;phone;00789;Office;good;Synthetic\r\nBroken record;computer;BAD;;bad;Synthetic\r\n",
      ),
    ]);
    const preview = f.workspace.assetImportPreview(actor, f.source(mixed));
    assert.deepEqual(preview.counts, {
      total: 4,
      eligible: 1,
      existing: 2,
      invalid: 1,
    });
    const before = hash(f.workspace.list(actor, "assets"));
    const second = f.prepare(tenant, mixed, [3]);
    await f.complete("ops.assets.importBatch", second, "manager", tenant);
    const receipt = f.workspace.assetImportReport(
      actor,
      String(second.uploadId),
    );
    assert.deepEqual(receipt.skippedRows, [1, 2, 4]);
    assert.equal(receipt.created.length, 1);
    assert.notEqual(hash(f.workspace.list(actor, "assets")), before);
    for (const original of report.created)
      assert.equal(f.get("assets", original.id, tenant).version, 1);
    assert.equal(
      f.workspace.assetImports(actor, { limit: 1, offset: 1 }).items.length,
      1,
    );
    assert.equal(
      f.workspace.assetImports(actor, { limit: 1, offset: 1 }).total,
      2,
    );
  }
  assert.throws(
    () =>
      f.workspace.assetImportReport(f.actor("manager", "synthetic-b"), ids[0]!),
    code("ASSET_IMPORT_NOT_FOUND"),
  );
  assert.throws(
    () => f.workspace.assetImports(f.actor("it-one"), { limit: 10, offset: 0 }),
    code("SCOPE_REQUIRED"),
  );
});
test("stale data, scope changes, invalid selection and revoked authority cannot write a partial import", async (t) => {
  const { dir, f } = fixture(t),
    tool = f.tools.find((t) => t.id === "ops.assets.importBatch")!,
    input = f.prepare();
  const staleContext = context();
  await f.complete("ops.assets.create", {
    title: "Existing",
    data: {
      assetType: "laptop",
      serial: "0000123",
      location: "A",
      condition: "good",
    },
  });
  const before = hash(f.workspace.list(f.actor(), "assets"));
  await assert.rejects(
    tool.execute(staleContext, input),
    code("ASSET_IMPORT_PREVIEW_CHANGED"),
  );
  const changed = f.prepare("synthetic-a", csvBody, [2]);
  await assert.rejects(
    tool.execute(context(), { ...changed, note: "Other scope" }),
    code("ASSET_IMPORT_SCOPE_CHANGED"),
  );
  const p = f.workspace.assetImportPreview(f.actor(), f.source());
  assert.throws(
    () =>
      f.workspace.prepareAssetImport(f.actor(), {
        ...f.source(),
        uploadId: randomUUID(),
        previewHash: p.previewHash,
        selectedRows: [1],
        profileVersion: p.profileVersion,
        note: "Invalid",
      }),
    code("ASSET_IMPORT_SELECTION_INVALID"),
  );
  f.actor("reviewer").scopes = [];
  for (const action of [
    () => tool.execute(context(), changed),
    () => tool.reconcile!(context(), changed),
    () => tool.verify(context(), changed, { data: {} }),
  ])
    await assert.rejects(action, code("ASSET_IMPORT_AUTHORITY_REQUIRED"));
  f.actor("reviewer").scopes = ["*"];
  const db = new DatabaseSync(join(dir, "operations.sqlite"));
  // Force a storage failure after the first INSERT; the shared transaction must remove every partial asset and audit row.
  db.exec(
    "CREATE TRIGGER synthetic_import_failure BEFORE INSERT ON ops_asset_imports BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;",
  );
  await assert.rejects(
    tool.execute(context(), changed),
    /synthetic receipt failure/,
  );
  assert.equal(hash(f.workspace.list(f.actor(), "assets")), before);
  assert.equal(
    db.prepare("SELECT count(*) n FROM ops_asset_imports").get()!.n,
    0,
  );
  db.exec("DROP TRIGGER synthetic_import_failure");
  db.close();
  const ctx = context(),
    result = await tool.execute(ctx, changed);
  assert.equal((await tool.verify(ctx, changed, result)).ok, true);
});
test("receipt reconciliation survives restart and expiration without repeating a batch; corrupt sources and manifests fail independent proof", async (t) => {
  let now = custodyNow;
  const { dir, f } = fixture(t, { domainClock: () => now }),
    tool = f.tools.find((t) => t.id === "ops.assets.importBatch")!,
    input = f.prepare(),
    ctx = context();
  const result = await tool.execute(ctx, input),
    before = hash(f.workspace.list(f.actor(), "assets"));
  assert.equal((await tool.verify(ctx, input, result)).ok, true);
  now += 20 * 86400000;
  const reopened = assetImportFixture(dir, { domainClock: () => now });
  try {
    const next = reopened.tools.find((t) => t.id === tool.id)!;
    assert.deepEqual(await next.execute(ctx, input), result);
    assert.equal((await next.reconcile!(ctx, input)).status, "applied");
    assert.equal((await next.verify(ctx, input, result)).ok, true);
    await assert.rejects(
      next.execute(context(), input),
      code("ASSET_IMPORT_ALREADY_APPLIED"),
    );
    const path = sourcePath(dir, String(input.uploadId)),
      body = readFileSync(path);
    writeFileSync(path, "Different bytes");
    assert.equal(
      reopened.workspace.assetImportReport(
        reopened.actor(),
        String(input.uploadId),
      ).valid,
      false,
    );
    await assert.rejects(next.reconcile!(ctx, input));
    assert.equal(
      hash(reopened.workspace.list(reopened.actor(), "assets")),
      before,
    );
    writeFileSync(path, body);
    const other = join(dir, "untrusted.csv");
    writeFileSync(other, body);
    unlinkSync(path);
    symlinkSync(other, path);
    await assert.rejects(next.verify(ctx, input, result));
    unlinkSync(path);
    writeFileSync(path, body);
    const manifest = join(
        sourcePath(dir, String(input.uploadId)),
        "../manifest.json",
      ),
      saved = readFileSync(manifest);
    writeFileSync(manifest, "{}");
    assert.equal(
      reopened.workspace.assetImportReport(
        reopened.actor(),
        String(input.uploadId),
      ).valid,
      false,
    );
    writeFileSync(manifest, saved);
    assert.equal((await next.verify(ctx, input, result)).ok, true);
    assert.equal(
      reopened.workspace.assetImports(reopened.actor(), {
        limit: 20,
        offset: 0,
      }).total,
      1,
    );
  } finally {
    reopened.close();
  }
});
test("expired preparations are rejected and eventually released from the staging quota", async (t) => {
  let now = custodyNow;
  const { dir, f } = fixture(t, { domainClock: () => now }),
    input = f.prepare(),
    tool = f.tools.find((t) => t.id === "ops.assets.importBatch")!;
  now += 8 * 86400000;
  await assert.rejects(
    tool.execute(context(), input),
    code("ASSET_IMPORT_EXPIRED"),
  );
  assert.equal(f.workspace.list(f.actor(), "assets").length, 0);
  const next = f.prepare();
  assert.notEqual(next.uploadId, input.uploadId);
  const stages = join(
    dir,
    "attachments/asset-imports/staged",
    createHash("sha256").update("synthetic-a").digest("hex"),
    createHash("sha256").update("manager").digest("hex"),
  );
  assert.deepEqual(readdirSync(stages), [next.uploadId]);
});
test("declined or cancelled imports have no domain effect; another author cannot borrow a staged file", async (t) => {
  const { f } = fixture(t),
    tool = f.tools.find((t) => t.id === "ops.assets.importBatch")!;
  for (const action of ["reject", "cancel"]) {
    const input = f.prepare(),
      r = await f.stage(tool.id, input);
    if (action === "reject") {
      const a = r.steps[0]!.approval!;
      f.engine.approve(f.actor("reviewer"), r.id, {
        approvalId: a.id,
        bindingHash: a.bindingHash,
        decision: "rejected",
      });
    } else f.engine.cancel(f.actor(), r.id);
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), r.id).steps[0]!.attempts, 0);
  }
  assert.equal(f.workspace.list(f.actor(), "assets").length, 0);
  assert.equal(
    f.workspace.assetImports(f.actor(), { limit: 20, offset: 0 }).total,
    0,
  );
  f.actor("it-one").scopes = ["assets"];
  await assert.rejects(
    tool.execute({ ...context(), actorId: "it-one" }, f.prepare()),
  );
  assert.equal(f.workspace.list(f.actor(), "assets").length, 0);
});
