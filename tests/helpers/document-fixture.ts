import type { JsonObject } from "../../src/contracts.js";
import type { CustodyFixture } from "./custody-fixture.js";
import { prepareDocument } from "../../src/artifacts.js";

export async function seedDocumentCase(
  f: CustodyFixture,
  tenant = "synthetic-a",
  fileRequired = false,
) {
  const run = await f.complete(
    "ops.cases.create",
    {
      title: "Synthetic scope document",
      data: {
        caseType: "general",
        brief: "Deliver the agreed synthetic report",
        acceptanceCriteria: "Reviewed report with current scope",
        dueDate: "2026-09-15",
        requirements: [
          {
            key: "scope",
            title: "Current scope report",
            kind: "document_approved",
            required: true,
            expected: {
              documentType: "report",
              currentVersionRequired: true,
              ...(fileRequired ? { fileRequired: true } : {}),
            },
          },
        ],
      },
    },
    "manager",
    tenant,
  );
  const caseId = String(run.steps[0]!.output!.data.entityId);
  const get = () => f.get("cases", caseId, tenant);
  await f.complete(
    "ops.cases.addTask",
    {
      id: caseId,
      expectedVersion: get().version,
      title: "Review scope",
      kind: "work",
      required: true,
      assigneePrincipalId: "manager",
    },
    "manager",
    tenant,
  );
  const prepared = prepareDocument(
    f.workspace,
    f.actor("manager", tenant),
    "case_scope",
    caseId,
  );
  for (const action of ["acceptTask", "completeTask"]) {
    const task = (get().data.tasks as JsonObject[])[0]!;
    await f.complete(
      "ops.cases." + action,
      {
        id: caseId,
        expectedVersion: get().version,
        taskId: task.id!,
        expectedTaskVersion: task.version!,
        humanConfirmed: true,
        ...(action === "completeTask"
          ? { evidenceNote: "Synthetic scope task checked" }
          : {}),
      },
      "manager",
      tenant,
    );
  }
  return { caseId, prepared };
}
export async function approveDocument(
  f: CustodyFixture,
  id: string,
  tenant = "synthetic-a",
) {
  for (const action of ["submit", "approve"])
    await f.complete(
      "ops.documents." + action,
      {
        id,
        expectedVersion: f.get("documents", id, tenant).version,
        ...(action === "approve"
          ? {
              decision: "approved",
              note: "Synthetic content checked independently",
              humanDecision: true,
            }
          : {}),
      },
      "manager",
      tenant,
    );
}
export async function reviseDocumentCase(
  f: CustodyFixture,
  caseId: string,
  tenant = "synthetic-a",
) {
  const c = f.get("cases", caseId, tenant);
  return f.complete(
    "ops.cases.revise",
    {
      id: c.id,
      expectedVersion: c.version,
      brief: String(c.data.brief) + " — revised scope",
      acceptanceCriteria: String(c.data.acceptanceCriteria),
      reason: "Explicit synthetic scope change",
    },
    "manager",
    tenant,
  );
}
