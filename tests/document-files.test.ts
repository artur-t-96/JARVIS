import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DomainError, type ToolContext } from "../src/contracts.js";
import { fileHash, validateDocumentFile } from "../src/document-files.js";
import { exportArtifact } from "../src/artifacts.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import { approveDocument } from "./helpers/document-fixture.js";
import {
  fileBody,
  seedFileDocument,
  stageFile,
} from "./helpers/document-file-fixture.js";
const code = (value: string) => (e: unknown) =>
  e instanceof DomainError && e.code === value;
const context = (): ToolContext => ({
  tenantId: "synthetic-a",
  actorId: "manager",
  approvedBy: "reviewer",
  runId: randomUUID(),
  stepId: "action",
  operationKey: randomUUID(),
  signal: new AbortController().signal,
});
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-files-")),
    f = custodyFixture(dir);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, f };
}
test("files are approved revision inputs in two firms; removal preserves history and cannot satisfy a required file", async (t) => {
  const { f } = fixture(t);
  const ids: string[] = [];
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    const actor = f.actor("manager", tenant),
      { caseId, documentId } = await seedFileDocument(f, tenant, true);
    ids.push(documentId);
    const input = await stageFile(f, documentId, tenant);
    assert.equal(f.workspace.documentFiles(actor, documentId).length, 0);
    assert.equal(f.get("documents", documentId, tenant).version, 1);
    const pending = await f.stage(
      "ops.documents.attachFile",
      input,
      "manager",
      tenant,
    );
    assert.equal(f.workspace.documentFiles(actor, documentId).length, 0);
    f.approve(pending, tenant);
    await f.engine.tick();
    assert.equal(f.engine.getRun(actor, pending.id).status, "completed");
    let d = f.get("documents", documentId, tenant);
    assert.equal(d.data.revision, 2);
    assert.equal(d.status, "draft");
    const files = f.workspace.documentFiles(actor, documentId);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.valid, true);
    assert.deepEqual(files[0]!.revisions, [2]);
    assert.deepEqual(
      f.workspace.readDocumentFile(actor, documentId, String(input.uploadId))
        .body,
      fileBody,
    );
    await approveDocument(f, documentId, tenant);
    d = f.get("documents", documentId, tenant);
    assert.equal(
      f.workspace.documentReadiness(actor, documentId).approvalCurrent,
      true,
    );
    await f.complete(
      "ops.cases.bindEvidence",
      {
        id: caseId,
        expectedVersion: f.get("cases", caseId, tenant).version,
        requirementId: f.workspace.readiness(actor, caseId).requirements[0]!.id,
        sourceModule: "documents",
        sourceId: documentId,
        sourceVersion: d.version,
      },
      "manager",
      tenant,
    );
    assert.equal(f.workspace.readiness(actor, caseId).ready, true);
    for (const action of ["submit", "accept"])
      await f.complete(
        "ops.cases." + action,
        {
          id: caseId,
          expectedVersion: f.get("cases", caseId, tenant).version,
          ...(action === "accept"
            ? {
                decision: "accepted",
                note: "Syntetyczny odbiór pliku",
                humanDecision: true,
              }
            : {}),
        },
        "manager",
        tenant,
      );
    assert.equal(
      f.workspace.documentReadiness(actor, documentId).approvalCurrent,
      true,
    );
    await f.complete(
      "ops.documents.detachFile",
      {
        id: documentId,
        expectedVersion: d.version,
        fileId: input.uploadId!,
        changeNote: "Syntetyczna nowa rewizja bez tego pliku",
      },
      "manager",
      tenant,
    );
    assert.equal(
      f.workspace.documentReadiness(actor, documentId).approvalCurrent,
      false,
    );
    assert.equal(f.workspace.readiness(actor, caseId).acceptanceCurrent, false);
    assert.deepEqual(
      f.workspace.readDocumentFile(actor, documentId, String(input.uploadId))
        .body,
      fileBody,
    );
    assert.equal(
      f.workspace.documentFiles(actor, documentId)[0]!.current,
      false,
    );
    assert.equal(f.get("documents", documentId, tenant).data.revision, 3);
  }
  assert.throws(
    () => f.workspace.documentFiles(f.actor("manager", "synthetic-b"), ids[0]!),
    code("ENTITY_NOT_FOUND"),
  );
  assert.throws(
    () => f.workspace.documentFiles(f.actor("it-one"), ids[0]!),
    code("SCOPE_REQUIRED"),
  );
});
test("a corrupt file invalidates approval, case evidence and export; recovery never repeats it", async (t) => {
  const { dir, f } = fixture(t),
    { caseId, documentId } = await seedFileDocument(f, "synthetic-a", true),
    input = await stageFile(f, documentId);
  const applied = await f.complete("ops.documents.attachFile", input);
  await approveDocument(f, documentId);
  const d = f.get("documents", documentId);
  await f.complete("ops.cases.bindEvidence", {
    id: caseId,
    expectedVersion: f.get("cases", caseId).version,
    requirementId: f.workspace.readiness(f.actor(), caseId).requirements[0]!.id,
    sourceModule: "documents",
    sourceId: documentId,
    sourceVersion: d.version,
  });
  const path = join(
    dir,
    "attachments",
    "document-files",
    "saved",
    fileHash("synthetic-a"),
    String(input.uploadId),
    "content.bin",
  );
  writeFileSync(path, Buffer.from("Changed bytes"));
  assert.equal(
    f.workspace.documentReadiness(f.actor(), documentId).approvalCurrent,
    false,
  );
  assert.equal(
    f.workspace.documentFiles(f.actor(), documentId)[0]!.valid,
    false,
  );
  assert.equal(f.workspace.readiness(f.actor(), caseId).ready, false);
  assert.throws(
    () => exportArtifact(f.workspace, f.actor(), "documents", documentId),
    code("DOCUMENT_APPROVAL_STALE"),
  );
  assert.throws(
    () =>
      f.workspace.readDocumentFile(
        f.actor(),
        documentId,
        String(input.uploadId),
      ),
    code("FILE_INTEGRITY_FAILED"),
  );
  const s = applied.steps[0]!,
    core = new DatabaseSync(join(dir, "core.sqlite"), { readOnly: true }),
    operationKey = String(
      core
        .prepare("SELECT operation_key FROM steps WHERE run_id=? AND id=?")
        .get(applied.id, s.id)!.operation_key,
    );
  core.close();
  const ctx = { ...context(), runId: applied.id, operationKey },
    tool = f.workspace.tools().find((t) => t.id === s.toolId)!;
  await assert.rejects(
    tool.reconcile!(ctx, input),
    code("DOCUMENT_FILE_INCONSISTENT"),
  );
  assert.equal(f.get("documents", documentId).version, d.version);
  writeFileSync(path, fileBody);
  assert.equal(
    f.workspace.documentReadiness(f.actor(), documentId).approvalCurrent,
    true,
  );
  unlinkSync(path);
  symlinkSync(join(dir, "operations.sqlite"), path);
  assert.throws(
    () =>
      f.workspace.readDocumentFile(
        f.actor(),
        documentId,
        String(input.uploadId),
      ),
    code("FILE_INTEGRITY_FAILED"),
  );
});
test("upload identity, actor, metadata, authority and expiry are checked again before attachment", async (t) => {
  const { f } = fixture(t),
    { documentId } = await seedFileDocument(f),
    uploadId = randomUUID(),
    input = await stageFile(f, documentId, "synthetic-a", fileBody, uploadId);
  assert.deepEqual(
    await stageFile(f, documentId, "synthetic-a", fileBody, uploadId),
    input,
  );
  await assert.rejects(
    stageFile(f, documentId, "synthetic-a", Buffer.from("Changed"), uploadId),
    code("FILE_UPLOAD_CONFLICT"),
  );
  const tool = f.workspace
    .tools()
    .find((t) => t.id === "ops.documents.attachFile")!;
  await assert.rejects(
    tool.execute(context(), { ...input, filename: "Spoofed.txt" }),
    code("FILE_APPROVAL_MISMATCH"),
  );
  assert.equal(f.get("documents", documentId).version, 1);
  f.actor("it-one").scopes = ["*"];
  await assert.rejects(
    tool.execute({ ...context(), actorId: "it-one" }, input),
    code("FILE_UNAVAILABLE"),
  );
  const pending = await f.stage(tool.id, input);
  f.approve(pending);
  f.actor().scopes = [];
  await f.engine.tick();
  f.actor().scopes = ["*"];
  assert.notEqual(f.engine.getRun(f.actor(), pending.id).status, "completed");
  assert.equal(f.get("documents", documentId).version, 1);
});
test("file publication and a rolled-back revision reconcile through the same manifest", async (t) => {
  const { dir, f } = fixture(t),
    { documentId } = await seedFileDocument(f),
    input = await stageFile(f, documentId),
    db = new DatabaseSync(join(dir, "operations.sqlite"));
  t.after(() => db.close());
  const tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.documents.attachFile")!,
    ctx = context();
  db.exec(
    "CREATE TRIGGER fail_file_revision BEFORE INSERT ON ops_document_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic file rollback'); END",
  );
  await assert.rejects(tool.execute(ctx, input), /synthetic file rollback/);
  assert.equal(f.get("documents", documentId).version, 1);
  assert.equal(f.workspace.documentFiles(f.actor(), documentId).length, 0);
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM ops_commands WHERE operation_key=?")
      .get(ctx.operationKey)!.n,
    0,
  );
  db.exec("DROP TRIGGER fail_file_revision");
  const result = await tool.execute(ctx, input);
  assert.equal((await tool.verify(ctx, input, result)).ok, true);
  assert.deepEqual(await tool.execute(ctx, input), result);
  assert.equal(f.get("documents", documentId).data.revision, 2);
  assert.equal(f.workspace.documentFiles(f.actor(), documentId).length, 1);
  const manifest = join(
    dir,
    "attachments",
    "document-files",
    "saved",
    fileHash("synthetic-a"),
    String(input.uploadId),
    "manifest.json",
  );
  const original = readFileSync(manifest);
  writeFileSync(manifest, Buffer.from("{}"));
  await assert.rejects(
    tool.reconcile!(ctx, input),
    code("DOCUMENT_FILE_INCONSISTENT"),
  );
  writeFileSync(manifest, original);
});
test("expired prepared input and mismatched file formats cannot become document evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-expired-file-"));
  let now = custodyNow;
  const f = custodyFixture(dir, { domainClock: () => now });
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { documentId } = await seedFileDocument(f),
    input = await stageFile(f, documentId),
    tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.documents.attachFile")!;
  now += 8 * 86400_000;
  await assert.rejects(
    tool.execute(context(), input),
    code("FILE_UPLOAD_EXPIRED"),
  );
  assert.equal(f.get("documents", documentId).version, 1);
  await assert.rejects(
    validateDocumentFile("test.pdf", "application/pdf", fileBody),
    code("FILE_FORMAT_INVALID"),
  );
  await assert.rejects(
    validateDocumentFile("test.txt", "text/plain", Buffer.from([0, 255, 1])),
    code("FILE_FORMAT_INVALID"),
  );
  await assert.rejects(
    validateDocumentFile("../test.txt", "text/plain", fileBody),
  );
  await assert.rejects(
    validateDocumentFile(
      "test.txt",
      "text/plain",
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ),
    code("FILE_SIZE_INVALID"),
  );
});
