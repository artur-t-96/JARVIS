import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reportFixture } from "./helpers/report-fixture.js";
import { approveDocument } from "./helpers/document-fixture.js";
import { exportArtifact } from "../src/artifacts.js";
import type { JsonObject, ToolContext } from "../src/contracts.js";
import { custodyNow } from "./helpers/custody-fixture.js";
const setup = (
  t: test.TestContext,
  options: Parameters<typeof reportFixture>[1] = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-reports-")),
    f = reportFixture(dir, options);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { f, dir };
};
test("report freshness propagates through an ordinary document and a case requirement", async (t) => {
  const { f } = setup(t);
  await f.newAsset();
  const { document } = await f.createReport();
  await approveDocument(f, document.id);
  const parent = await f.complete("ops.documents.create", {
    title: "Syntetyczne podsumowanie raportu",
    data: {
      accessScope: "documents",
      documentType: "report",
      content: "Podsumowanie zachowanego raportu wyposażenia.",
      sources: [
        {
          module: "documents",
          id: document.id,
          version: f.get("documents", document.id).version,
          observedAt: new Date(custodyNow).toISOString(),
        },
      ],
    },
  });
  const parentId = String(parent.steps[0]!.output!.data.entityId);
  await approveDocument(f, parentId);
  const c = await f.complete("ops.cases.create", {
      title: "Syntetyczny odbiór raportu",
      data: {
        caseType: "general",
        brief: "Sprawdź raport",
        acceptanceCriteria: "Aktualny raport",
        requirements: [
          {
            key: "report",
            title: "Aktualny raport wyposażenia",
            kind: "document_approved",
            required: true,
            expected: { documentType: "report", currentVersionRequired: true },
          },
        ],
      },
    }),
    caseId = String(c.steps[0]!.output!.data.entityId);
  await f.complete("ops.cases.bindEvidence", {
    id: caseId,
    expectedVersion: f.get("cases", caseId).version,
    requirementId: f.workspace.readiness(f.actor(), caseId).requirements[0]!.id,
    sourceModule: "documents",
    sourceId: parentId,
    sourceVersion: f.get("documents", parentId).version,
  });
  assert.equal(
    f.workspace.readiness(f.actor(), caseId).requirements[0]!.status,
    "satisfied",
    JSON.stringify(f.workspace.readiness(f.actor(), caseId)),
  );
  await f.newAsset();
  assert.equal(
    f.workspace.documentReadiness(f.actor(), parentId).approvalCurrent,
    false,
  );
  assert.notEqual(
    f.workspace.readiness(f.actor(), caseId).requirements[0]!.status,
    "satisfied",
  );
});
test("refusal, cancellation, delayed approval and another author's preview leave no generated document", async (t) => {
  let now = custodyNow;
  const { f } = setup(t, { domainClock: () => now });
  await f.newAsset();
  for (const decision of ["rejected", "cancelled"]) {
    const run = await f.stage("ops.documents.createReport", f.prepare());
    if (decision === "cancelled") f.engine.cancel(f.actor(), run.id);
    else {
      const a = run.steps[0]!.approval!;
      f.engine.approve(f.actor("reviewer"), run.id, {
        approvalId: a.id,
        bindingHash: a.bindingHash,
        decision: "rejected",
      });
    }
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), run.id).steps[0]!.attempts, 0);
  }
  const input = f.prepare(),
    tool = f.tools.find((t) => t.id === "ops.documents.createReport")!;
  const ctx: ToolContext = {
    tenantId: "synthetic-a",
    actorId: "manager",
    approvedBy: "reviewer",
    runId: randomUUID(),
    stepId: "report",
    operationKey: randomUUID(),
    signal: new AbortController().signal,
  };
  f.actor("it-one").scopes = ["*"];
  await assert.rejects(tool.execute({ ...ctx, actorId: "it-one" }, input), {
    code: "REPORT_AUTHOR_FORBIDDEN",
  });
  now += 8 * 86400_000;
  await assert.rejects(tool.execute(ctx, input), {
    code: "REPORT_PREVIEW_EXPIRED",
  });
  assert.equal(f.workspace.list(f.actor(), "documents").length, 0);
});
test("report creation rolls back its document, revision and preview publication together and cannot consume one preview twice", async (t) => {
  const { f, dir } = setup(t);
  await f.newAsset();
  const input = f.prepare(),
    tool = f.tools.find((t) => t.id === "ops.documents.createReport")!,
    ctx: ToolContext = {
      tenantId: "synthetic-a",
      actorId: "manager",
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "report",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    };
  const db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    db.exec(
      "CREATE TRIGGER reject_report_receipt BEFORE INSERT ON ops_commands WHEN NEW.tool_id='ops.documents.createReport' BEGIN SELECT RAISE(ABORT,'Synthetic report receipt failure'); END",
    );
    await assert.rejects(
      tool.execute(ctx, input),
      /Synthetic report receipt failure/,
    );
    assert.equal(f.workspace.list(f.actor(), "documents").length, 0);
    assert.equal(
      db.prepare("SELECT count(*) n FROM ops_document_versions").get()!.n,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT document_id FROM ops_report_previews WHERE id=?")
        .get(String(input.previewId))!.document_id,
      null,
    );
    db.exec("DROP TRIGGER reject_report_receipt");
    await tool.execute(ctx, input);
    await assert.rejects(
      tool.execute({ ...ctx, operationKey: randomUUID() }, input),
      { code: "REPORT_PREVIEW_USED" },
    );
    assert.equal(f.workspace.list(f.actor(), "documents").length, 1);
  } finally {
    db.close();
  }
});
test("a changed company profile invalidates the waiting report; failed independent verification never reports completion", async (t) => {
  const { f } = setup(t, {
    wrap: (tool) =>
      tool.id !== "ops.documents.createReport"
        ? tool
        : {
            ...tool,
            async verify() {
              return {
                ok: false,
                summary: "Synthetic independent verification failed",
                evidence: [],
              };
            },
          },
  });
  await f.newAsset();
  const stale = f.prepare(),
    profile = f.initiatives.profileForTenant("synthetic-a");
  await f.complete("initiatives.configure", {
    companyName: "Synthetic different company label",
    timezone: "America/New_York",
    licenseReminderDays: profile.licenseReminderDays,
    quietHours: profile.quietHours,
    rules: profile.rules,
    roleBindings: {},
    processTemplates: profile.processTemplates,
    employmentPolicy: profile.employmentPolicy,
    expectedVersion: profile.version,
  });
  const tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.documents.createReport")!,
    ctx: ToolContext = {
      tenantId: "synthetic-a",
      actorId: "manager",
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "report",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    };
  await assert.rejects(tool.execute(ctx, stale), {
    code: "REPORT_PREVIEW_CHANGED",
  });
  const run = await f.stage(tool.id, f.prepare());
  f.approve(run);
  await f.engine.tick();
  const failed = f.engine.getRun(f.actor(), run.id);
  assert.notEqual(failed.status, "completed");
  assert.equal(failed.steps[0]!.verification?.ok, false);
  assert.equal(f.workspace.list(f.actor(), "documents").length, 1);
  await f.engine.tick();
  assert.equal(f.workspace.list(f.actor(), "documents").length, 1);
});
test("two firms receive immutable report documents; a new matching row invalidates acceptance and refresh requires a new decision", async (t) => {
  const { f } = setup(t);
  const ids = [];
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    const asset = await f.newAsset(tenant),
      { input, document, run } = await f.createReport(tenant);
    ids.push(document.id);
    assert.equal(run.steps[0]!.verification?.ok, true);
    assert.equal(document.data.revision, 1);
    assert.equal(
      (document.data.operationalReport as JsonObject).previewHash,
      input.previewHash,
    );
    assert.ok(String(document.data.content).includes(asset.title));
    await approveDocument(f, document.id, tenant);
    assert.equal(
      f.workspace.documentReadiness(f.actor("manager", tenant), document.id)
        .approvalCurrent,
      true,
    );
    assert.ok(
      exportArtifact(
        f.workspace,
        f.actor("manager", tenant),
        "documents",
        document.id,
      ).body.includes(asset.title),
    );
    await f.newAsset(tenant);
    const stale = f.workspace.documentReadiness(
      f.actor("manager", tenant),
      document.id,
    );
    assert.equal(stale.reportCurrent, false);
    assert.equal(stale.approvalCurrent, false);
    assert.throws(() =>
      exportArtifact(
        f.workspace,
        f.actor("manager", tenant),
        "documents",
        document.id,
      ),
    );
    const next = f.prepare(tenant, { kind: "equipment" }, document.id);
    await f.complete("ops.documents.refreshReport", next, "manager", tenant);
    const refreshed = f.get("documents", document.id, tenant);
    assert.equal(refreshed.status, "draft");
    assert.equal(refreshed.data.revision, 2);
    assert.equal(
      (refreshed.data.versions as JsonObject[])[0]!.status,
      "approved",
    );
    assert.equal(
      f.workspace.documentReadiness(f.actor("manager", tenant), document.id)
        .readyForReview,
      true,
    );
    assert.equal(
      f.workspace.documentReadiness(f.actor("manager", tenant), document.id)
        .approvalCurrent,
      false,
    );
    await approveDocument(f, document.id, tenant);
  }
  assert.throws(() => f.get("documents", ids[0]!, "synthetic-b"), {
    code: "ENTITY_NOT_FOUND",
  });
});
test("the stored proposal survives live changes but cannot create a report from an obsolete approval", async (t) => {
  const { f } = setup(t);
  await f.newAsset();
  const input = f.prepare(),
    pending = await f.stage("ops.documents.createReport", input);
  await f.newAsset();
  const proposal = f.workspace.operationalReportProposal(
    f.actor("reviewer"),
    "manager",
    input,
  );
  assert.equal(proposal.snapshot.rows.length, 1);
  assert.equal(proposal.current, false);
  f.approve(pending);
  await f.engine.tick();
  assert.notEqual(f.engine.getRun(f.actor(), pending.id).status, "completed");
  assert.equal(f.workspace.list(f.actor(), "documents").length, 0);
});
test("the scope of every historical report revision remains protected and manual edits cannot keep a generated identity", async (t) => {
  const { f } = setup(t);
  await f.seed();
  const { document } = await f.createReport("synthetic-a", {
    kind: "starts",
    from: "2026-09-01",
    to: "2026-09-30",
  });
  await f.complete(
    "ops.documents.refreshReport",
    f.prepare("synthetic-a", { kind: "equipment" }, document.id),
  );
  const reader = f.actor("observer");
  reader.scopes = ["documents", "assets", "inventory"];
  assert.throws(() => f.workspace.get(reader, "documents", document.id));
  assert.equal(f.workspace.list(reader, "documents").length, 0);
  const tool = f.workspace
    .tools()
    .find((t) => t.id === "ops.documents.revise")!;
  const ctx: ToolContext = {
    tenantId: "synthetic-a",
    actorId: "manager",
    approvedBy: "reviewer",
    runId: randomUUID(),
    stepId: "edit",
    operationKey: randomUUID(),
    signal: new AbortController().signal,
  };
  await assert.rejects(
    tool.execute(ctx, {
      id: document.id,
      expectedVersion: f.get("documents", document.id).version,
      content: "Arbitrary",
      changeNote: "Synthetic edit",
    }),
    { code: "REPORT_REFRESH_REQUIRED" },
  );
});
test("recovery verifies a committed snapshot even after sources change, and refuses a revoked source scope or corrupted receipt", async (t) => {
  const { f, dir } = setup(t);
  await f.newAsset();
  const input = f.prepare(),
    tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.documents.createReport")!;
  const ctx: ToolContext = {
    tenantId: "synthetic-a",
    actorId: "manager",
    approvedBy: "reviewer",
    runId: randomUUID(),
    stepId: "report",
    operationKey: randomUUID(),
    signal: new AbortController().signal,
  };
  const result = await tool.execute(ctx, input);
  await f.newAsset();
  assert.deepEqual(await tool.execute(ctx, input), result);
  assert.equal((await tool.reconcile(ctx, input)).status, "applied");
  assert.equal((await tool.verify(ctx, input, result)).ok, true);
  assert.equal(f.workspace.list(f.actor(), "documents").length, 1);
  f.actor("reviewer").scopes = ["documents"];
  await assert.rejects(tool.reconcile(ctx, input));
  f.actor("reviewer").scopes = ["*"];
  const db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    db.prepare(
      "UPDATE ops_document_versions SET context_json=json_set(context_json,'$.operationalReport.summary.rows',123) WHERE document_id=?",
    ).run(String(result.data.entityId));
    assert.equal(
      f.workspace.documentReadiness(f.actor(), String(result.data.entityId))
        .integrity,
      false,
    );
    await assert.rejects(tool.reconcile(ctx, input), {
      code: "DOCUMENT_STATE_INCONSISTENT",
    });
  } finally {
    db.close();
  }
});
