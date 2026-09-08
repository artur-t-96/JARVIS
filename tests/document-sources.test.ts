import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  type JsonObject,
  type ToolContext,
} from "../src/contracts.js";
import { exportArtifact } from "../src/artifacts.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import {
  approveDocument,
  reviseDocumentCase,
  seedDocumentCase,
} from "./helpers/document-fixture.js";
import { randomUUID } from "node:crypto";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-document-sources-")),
    f = custodyFixture(dir);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return f;
}
const code = (expected: string) => (e: unknown) =>
  e instanceof DomainError && e.code === expected;
const json = (v: unknown): JsonObject => JSON.parse(JSON.stringify(v));

test("revision rejects direct and indirect document source cycles before changing a record", async (t) => {
  const f = fixture(t);
  const a = await f.complete("ops.documents.create", {
    title: "A",
    data: {
      accessScope: "documents",
      documentType: "report",
      content: "Synthetic A",
    },
  });
  const id = String(a.steps[0]!.output!.data.entityId);
  const b = await f.complete("ops.documents.create", {
    title: "B",
    data: {
      accessScope: "documents",
      documentType: "report",
      content: "Synthetic B",
      sources: [
        {
          module: "documents",
          id,
          version: 1,
          observedAt: "2026-09-08T10:00:00.000Z",
        },
      ],
    },
  });
  const otherId = String(b.steps[0]!.output!.data.entityId);
  const tool = f.workspace
    .tools()
    .find((t) => t.id === "ops.documents.revise")!;
  for (const sourceId of [id, otherId])
    await assert.rejects(
      tool.execute(
        {
          tenantId: "synthetic-a",
          actorId: "manager",
          approvedBy: "reviewer",
          runId: randomUUID(),
          stepId: "action",
          operationKey: randomUUID(),
          signal: new AbortController().signal,
        },
        {
          id,
          expectedVersion: 1,
          content: "Synthetic cycle attempt",
          changeNote: "Rejected cycle",
          sources: [
            {
              module: "documents",
              id: sourceId,
              version: 1,
              observedAt: "2026-09-08T10:00:00.000Z",
            },
          ],
        },
      ),
      code("DOCUMENT_SOURCE_CYCLE"),
    );
  assert.equal(f.get("documents", id).version, 1);
  assert.equal(
    f.workspace.documentReadiness(f.actor(), otherId).readyForReview,
    true,
  );
});

test("case scope sources survive task work, evidence binding and acceptance in two isolated firms", async (t) => {
  const f = fixture(t);
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    const p = f.actor("manager", tenant),
      { caseId, prepared } = await seedDocumentCase(f, tenant);
    const created = await f.complete(
        "ops.documents.create",
        prepared,
        "manager",
        tenant,
      ),
      id = String(created.steps[0]!.output!.data.entityId);
    await approveDocument(f, id, tenant);
    const doc = f.get("documents", id, tenant),
      versions = doc.data.versions as JsonObject[];
    assert.equal(versions[0]!.createdBy, "manager");
    assert.equal(versions[0]!.decidedBy, "manager");
    assert.equal(versions[0]!.approvedBy, "reviewer");
    const before = f.workspace.documentReadiness(p, id);
    assert.equal(before.approvalCurrent, true);
    await f.complete(
      "ops.cases.bindEvidence",
      {
        id: caseId,
        expectedVersion: f.get("cases", caseId, tenant).version,
        requirementId: f.workspace.readiness(p, caseId).requirements[0]!.id,
        sourceModule: "documents",
        sourceId: id,
        sourceVersion: doc.version,
      },
      "manager",
      tenant,
    );
    assert.equal(f.workspace.readiness(p, caseId).ready, true);
    for (const action of ["submit", "accept"])
      await f.complete(
        "ops.cases." + action,
        {
          id: caseId,
          expectedVersion: f.get("cases", caseId, tenant).version,
          ...(action === "accept"
            ? {
                decision: "accepted",
                note: "Reviewed scope and result",
                humanDecision: true,
              }
            : {}),
        },
        "manager",
        tenant,
      );
    assert.deepEqual(f.workspace.documentReadiness(p, id), before);
    assert.equal(
      JSON.parse(exportArtifact(f.workspace, p, "cases", caseId).body).readiness
        .acceptanceCurrent,
      true,
    );
    assert.throws(
      () =>
        f.workspace.documentReadiness(
          f.actor(
            "manager",
            tenant === "synthetic-a" ? "synthetic-b" : "synthetic-a",
          ),
          id,
        ),
      code("ENTITY_NOT_FOUND"),
    );
    assert.throws(
      () => f.workspace.documentReadiness(f.actor("it-one", tenant), id),
      code("SCOPE_REQUIRED"),
    );
    await reviseDocumentCase(f, caseId, tenant);
    assert.equal(f.workspace.documentReadiness(p, id).approvalCurrent, false);
    assert.throws(
      () => exportArtifact(f.workspace, p, "documents", id),
      code("DOCUMENT_APPROVAL_STALE"),
    );
    const content = String(doc.data.content),
      oldSources = JSON.stringify(doc.data.sources);
    await f.complete(
      "ops.documents.revise",
      {
        id,
        expectedVersion: doc.version,
        content,
        changeNote: "Keep exact historical sources while drafting",
      },
      "manager",
      tenant,
    );
    assert.equal(
      JSON.stringify(f.get("documents", id, tenant).data.sources),
      oldSources,
    );
    assert.equal(f.workspace.documentReadiness(p, id).readyForReview, false);
    const pending = await f.stage(
      "ops.documents.submit",
      { id, expectedVersion: f.get("documents", id, tenant).version },
      "manager",
      tenant,
    );
    f.approve(pending, tenant);
    await f.engine.tick();
    assert.notEqual(f.engine.getRun(p, pending.id).status, "completed");
    const refresh = f.workspace.documentRefresh(p, id);
    await f.complete(
      "ops.documents.revise",
      {
        ...json(refresh),
        title: "Explicit refreshed scope",
        content: content + "\nRevised scope checked",
        changeNote: "Refresh sources and check content",
      },
      "manager",
      tenant,
    );
    await approveDocument(f, id, tenant);
    const revised = f.get("documents", id, tenant);
    assert.equal(revised.data.revision, 3);
    assert.equal(f.workspace.documentReadiness(p, id).approvalCurrent, true);
    assert.equal(
      ((revised.data.versions as JsonObject[])[0]!.context as JsonObject).title,
      doc.title,
    );
    assert.equal(
      JSON.stringify(
        ((revised.data.versions as JsonObject[])[0]!.context as JsonObject)
          .sources,
      ),
      oldSources,
    );
  }
});

test("pending source approval cannot survive a scope change or revoked operator authority", async (t) => {
  const f = fixture(t),
    { caseId, prepared } = await seedDocumentCase(f);
  const staged = await f.stage("ops.documents.create", prepared);
  await reviseDocumentCase(f, caseId);
  f.approve(staged);
  await f.engine.tick();
  const result = f.engine.getRun(f.actor(), staged.id);
  assert.notEqual(result.status, "completed");
  assert.equal(f.workspace.list(f.actor(), "documents").length, 0);
  const scope = f.workspace.documentScope(f.actor(), caseId);
  const next = {
    ...prepared,
    data: { ...(prepared.data as JsonObject), sources: [json(scope.source)] },
  };
  const denied = await f.stage("ops.documents.create", next);
  f.approve(denied);
  f.actor().scopes = [];
  await f.engine.tick();
  f.actor().scopes = ["*"];
  assert.notEqual(f.engine.getRun(f.actor(), denied.id).status, "completed");
  assert.equal(f.workspace.list(f.actor(), "documents").length, 0);
});

test("onboarding documents require the exact period scope, including parallel contractor projects", async (t) => {
  const f = fixture(t);
  for (const tenant of ["synthetic-a", "synthetic-b"]) {
    const p = f.actor("manager", tenant),
      profile = f.initiatives.profile(p);
    await f.complete(
      "initiatives.configure",
      json({
        companyName: "Synthetic documents",
        timezone:
          tenant === "synthetic-a" ? "Europe/Warsaw" : "America/New_York",
        licenseReminderDays: profile.licenseReminderDays,
        quietHours: profile.quietHours,
        rules: profile.rules,
        roleBindings: { hr: "manager", it: "it-one", manager: "manager" },
        processTemplates: profile.processTemplates,
        employmentPolicy: {
          mode: "parallel_projects",
          maxConcurrent: 2,
          allowInternalOverlap: false,
        },
        expectedVersion: profile.version,
      }),
      "manager",
      tenant,
    );
    const person = await f.complete(
        "ops.people.create",
        {
          title: "Synthetic contractor",
          data: { personCategory: "contractor" },
        },
        "manager",
        tenant,
      ),
      personId = String(person.steps[0]!.output!.data.entityId);
    const cases: string[] = [];
    for (const name of ["Alfa", "Beta"]) {
      const project = await f.complete(
        "ops.cases.create",
        {
          title: "Synthetic project " + name,
          data: {
            caseType: "delivery",
            brief: "Synthetic project scope",
            acceptanceCriteria: "Synthetic acceptance",
          },
        },
        "manager",
        tenant,
      );
      await f.complete(
        "ops.people.startEmployment",
        {
          id: personId,
          expectedVersion: f.get("people", personId, tenant).version,
          employmentKind: "contractor",
          startDate: "2026-09-08",
          role: "Synthetic consultant",
          engagementRef: {
            module: "cases",
            id: String(project.steps[0]!.output!.data.entityId),
          },
          humanDecision: true,
        },
        "manager",
        tenant,
      );
      const episodes = f.workspace.listEmploymentEpisodes(p, personId);
      cases.push(
        episodes.find((e) => !cases.includes(e.onboardingCaseId!))!
          .onboardingCaseId!,
      );
    }
    const scope = f.workspace.documentScope(p, cases[0]!);
    const create = async (linkedCaseId: string, sources: JsonObject[]) => {
      const r = await f.complete(
        "ops.documents.create",
        {
          title: "Synthetic agreement supplied by reviewer",
          data: {
            accessScope: "people",
            documentType: "contract",
            content: "Synthetic fixture text only; not a legal agreement",
            linkedCaseId,
            sources,
          },
        },
        "manager",
        tenant,
      );
      return String(r.steps[0]!.output!.data.entityId);
    };
    const wrong = await create(cases[1]!, [json(scope.source)]),
      empty = await create(cases[0]!, []);
    assert.equal(f.workspace.documentReadiness(p, wrong).readyForReview, false);
    assert.equal(f.workspace.documentReadiness(p, empty).readyForReview, false);
    const right = await create(cases[0]!, [json(scope.source)]);
    await approveDocument(f, right, tenant);
    await f.complete(
      "ops.cases.bindEvidence",
      {
        id: cases[0]!,
        expectedVersion: f.get("cases", cases[0]!, tenant).version,
        requirementId: f.workspace
          .readiness(p, cases[0]!)
          .requirements.find((r) => r.kind === "document_approved")!.id,
        sourceModule: "documents",
        sourceId: right,
        sourceVersion: f.get("documents", right, tenant).version,
      },
      "manager",
      tenant,
    );
    assert.equal(
      f.workspace
        .readiness(p, cases[0]!)
        .requirements.find((r) => r.kind === "document_approved")!.status,
      "satisfied",
    );
    assert.equal(f.workspace.readiness(p, cases[0]!).ready, false);
    assert.equal(
      f.workspace
        .readiness(p, cases[1]!)
        .requirements.find((r) => r.kind === "document_approved")!.status,
      "missing",
    );
    await f.complete(
      "ops.cases.cancel",
      {
        id: cases[0]!,
        expectedVersion: f.get("cases", cases[0]!, tenant).version,
        reason: "Synthetic cancellation",
      },
      "manager",
      tenant,
    );
    assert.equal(
      f.workspace.documentReadiness(p, right).approvalCurrent,
      false,
    );
  }
});

test("source history retains access restrictions after a revision removes a private reference", async (t) => {
  const f = fixture(t);
  const created = await f.complete("ops.people.create", {
      title: "PRIVATE_HR_SOURCE",
      data: { personCategory: "internal" },
    }),
    personId = String(created.steps[0]!.output!.data.entityId);
  const docRun = await f.complete("ops.documents.create", {
      title: "Historical source ACL",
      data: {
        documentType: "report",
        accessScope: "documents",
        content: "Synthetic content",
        sources: [
          {
            module: "people",
            id: personId,
            version: 1,
            observedAt: "2026-09-08T10:00:00.000Z",
          },
        ],
      },
    }),
    id = String(docRun.steps[0]!.output!.data.entityId);
  await f.complete("ops.documents.revise", {
    id,
    expectedVersion: 1,
    content: "Synthetic revision without current references",
    sources: [],
    changeNote: "Explicitly removed current reference",
  });
  assert.throws(
    () =>
      f.workspace.get({ ...f.actor(), scopes: ["documents"] }, "documents", id),
    code("SCOPE_REQUIRED"),
  );
  const tool = f.workspace
    .tools()
    .find((t) => t.id === "ops.documents.update")!;
  const ctx: ToolContext = {
    tenantId: "synthetic-a",
    actorId: "manager",
    approvedBy: "reviewer",
    runId: randomUUID(),
    stepId: "action",
    operationKey: randomUUID(),
    signal: new AbortController().signal,
  };
  await assert.rejects(
    tool.execute(ctx, { id, expectedVersion: 2, title: "Unreviewed rename" }),
    code("REVISION_REQUIRED"),
  );
});
