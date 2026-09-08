import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  exportArtifact,
  materializeArtifact,
  prepareDocument,
} from "../src/artifacts.js";
import {
  DomainError,
  type JsonObject,
  type Principal,
} from "../src/contracts.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";

const p: Principal = {
  id: "operator",
  tenantId: "synthetic-artifacts",
  roles: ["operator"],
  scopes: ["*"],
};
const denied = (error: unknown) =>
  error instanceof DomainError && [403, 404].includes(error.statusCode);
function fixture() {
  const store = new WorkspaceStore(":memory:");
  const tools = new Map(store.tools().map((t) => [t.id, t]));
  const apply = async (module: string, action: string, input: JsonObject) => {
    const result = await tools.get(`ops.${module}.${action}`)!.execute(
      {
        tenantId: p.tenantId,
        actorId: p.id,
        approvedBy: "synthetic-approver",
        runId: "synthetic-run",
        stepId: "synthetic-step",
        operationKey: randomUUID(),
        signal: new AbortController().signal,
      },
      input,
    );
    return store.get(p, module, String(result.data.entityId));
  };
  const create = (module: string, title: string, data: JsonObject) =>
    apply(module, "create", { title, data });
  const action = (e: Entity, action: string, input: JsonObject = {}) =>
    apply(e.module, action, { id: e.id, expectedVersion: e.version, ...input });
  return { store, tools, create, action };
}

test("document exports are authorized, versioned and hashed; source revisions are frozen and stale proposals rejected", async () => {
  const f = fixture();
  try {
    let source = await f.create("assets", "A".repeat(160), {
      assetType: "laptop",
      serial: "SYNTHETIC",
      location: "Local",
      condition: "good",
    });
    const prepared = prepareDocument(f.store, p, "asset_report", source.id);
    assert.ok(
      String(prepared.title).length <= 160,
      "prepared title must satisfy actual create tool schema",
    );
    const tool = f.tools.get("ops.documents.create")!;
    assert.equal(tool.inputSchema.safeParse(prepared).success, true);
    const document = await f.create(
      "documents",
      String(prepared.title),
      prepared.data as JsonObject,
    );
    const first = exportArtifact(f.store, p, "documents", document.id);
    assert.match(
      first.filename,
      new RegExp(`^document-${document.id}-v1\\.md$`),
    );
    assert.equal(
      first.sha256,
      createHash("sha256").update(first.body).digest("hex"),
    );
    assert.equal(first.manifest.bytes, Buffer.byteLength(first.body));
    assert.equal(first.manifest.tenantId, p.tenantId);
    assert.match(first.body, /Status: draft/);
    assert.throws(
      () =>
        exportArtifact(
          f.store,
          { ...p, tenantId: "other" },
          "documents",
          document.id,
        ),
      denied,
    );
    assert.throws(
      () =>
        exportArtifact(
          f.store,
          { ...p, scopes: ["documents"] },
          "documents",
          document.id,
        ),
      denied,
      "source module ACL applies to exported document",
    );
    source = await f.action(source, "update", { title: "Changed source" });
    assert.equal(
      exportArtifact(f.store, p, "documents", document.id).sha256,
      first.sha256,
      "source edits do not silently regenerate a frozen document",
    );
    await assert.rejects(
      f.create(
        "documents",
        String(prepared.title),
        prepared.data as JsonObject,
      ),
      (e) => e instanceof DomainError && e.code === "SOURCE_VERSION_CHANGED",
    );
    const revised = await f.action(document, "revise", {
      content: "Explicit second revision",
      changeNote: "Test",
    });
    const second = exportArtifact(f.store, p, "documents", revised.id);
    assert.notEqual(second.sha256, first.sha256);
    assert.notEqual(second.filename, first.filename);
    assert.equal(second.manifest.entityVersion, 2);
  } finally {
    f.store.close();
  }
});

test("case package requires current business acceptance and includes draft settlement without financial effects", async () => {
  const f = fixture();
  try {
    let c = await f.create("cases", "Synthetic case", {
      caseType: "general",
      brief: "Test",
      acceptanceCriteria: "Human review",
    });
    assert.throws(
      () => exportArtifact(f.store, p, "cases", c.id),
      (e) => e instanceof DomainError && e.code === "CASE_NOT_ACCEPTED",
    );
    c = await f.action(c, "addTask", { title: "Test", required: true });
    c = await f.action(c, "completeTask", {
      taskId: (c.data.tasks as JsonObject[])[0]!.id!,
      evidenceNote: "Synthetic",
      humanConfirmed: true,
    });
    c = await f.action(c, "addEvidence", {
      title: "Synthetic",
      reference: "Test",
      note: "Human attestation",
      humanConfirmed: true,
    });
    c = await f.action(c, "addWorklog", {
      description: "Declared time",
      minutes: 30,
      performedOn: new Date().toISOString().slice(0, 10),
    });
    c = await f.action(c, "submit");
    assert.throws(
      () => exportArtifact(f.store, p, "cases", c.id),
      (e) => e instanceof DomainError && e.code === "CASE_NOT_ACCEPTED",
    );
    c = await f.action(c, "accept", {
      decision: "accepted",
      note: "Accepted",
      humanDecision: true,
    });
    const exported = exportArtifact(f.store, p, "cases", c.id),
      body = JSON.parse(exported.body);
    assert.equal(
      body.case.data.currentAcceptance.decidedBy,
      "synthetic-approver",
    );
    assert.equal(body.settlement.kind, "draft");
    assert.equal(body.settlement.declaredMinutes, 30);
    assert.equal(body.financialPosting, false);
    assert.equal(body.paymentExecuted, false);
    c = await f.action(c, "revise", {
      brief: "Changed",
      acceptanceCriteria: "New approval",
      reason: "Test",
    });
    assert.throws(
      () => exportArtifact(f.store, p, "cases", c.id),
      (e) => e instanceof DomainError && e.code === "CASE_NOT_ACCEPTED",
    );
  } finally {
    f.store.close();
  }
});

test("exports are idempotent, detect overwritten files, and reject symlink directories before outside writes", async () => {
  const f = fixture(),
    directory = mkdtempSync(join(tmpdir(), "jarvis-artifacts-test-"));
  try {
    const document = await f.create("documents", "Test", {
      accessScope: "documents",
      documentType: "policy",
      content: "Synthetic content",
    });
    const artifact = exportArtifact(f.store, p, "documents", document.id),
      data = join(directory, "data");
    mkdirSync(data);
    materializeArtifact(data, artifact);
    materializeArtifact(data, artifact);
    const stored = join(
      data,
      "evidence",
      "exports",
      createHash("sha256").update(p.tenantId).digest("hex"),
      artifact.filename,
    );
    assert.equal(readFileSync(stored, "utf8"), artifact.body);
    assert.equal(
      JSON.parse(readFileSync(`${stored}.manifest.json`, "utf8")).sha256,
      artifact.sha256,
    );
    writeFileSync(stored, "tampered test data");
    assert.throws(
      () => materializeArtifact(data, artifact),
      (e) => e instanceof DomainError && e.code === "ARTIFACT_CONFLICT",
    );
    const outside = join(directory, "outside"),
      alias = join(directory, "alias");
    mkdirSync(outside);
    symlinkSync(outside, alias, "dir");
    assert.throws(
      () => materializeArtifact(alias, artifact),
      "base dataDir cannot redirect exports through symlink",
    );
    assert.equal(
      existsSync(join(outside, "evidence")),
      false,
      "rejection precedes writes outside dataDir",
    );
    const nested = join(directory, "nested");
    mkdirSync(nested);
    symlinkSync(outside, join(nested, "evidence"), "dir");
    assert.throws(() => materializeArtifact(nested, artifact));
    assert.equal(existsSync(join(outside, "exports")), false);
  } finally {
    f.store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
