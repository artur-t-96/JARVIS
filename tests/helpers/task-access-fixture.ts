import assert from "node:assert/strict";
import type { JsonObject } from "../../src/contracts.js";
import type { CustodyFixture } from "./custody-fixture.js";
import { seedAccess } from "./access-fixture.js";
export async function seedTaskAccess(
  f: CustodyFixture,
  tenant = "synthetic-a",
  accept = true,
  dependencies = true,
) {
  const seed = await seedAccess(f, tenant, true);
  const tasks = () =>
    f.workspace
      .listTasks(f.actor("manager", tenant))
      .filter((t) => t.caseId === seed.caseId);
  const accessTask = tasks().find(
    (t) => t.kind === "attestation" && t.assigneeRole === "it",
  );
  assert.ok(accessTask);
  async function transition(taskId: string, action: string) {
    const t = tasks().find((t) => t.id === taskId)!;
    await f.complete(
      "ops.cases." + action,
      {
        id: seed.caseId,
        expectedVersion: f.get("cases", seed.caseId, tenant).version,
        taskId,
        expectedTaskVersion: t.version,
        humanConfirmed: true,
        ...(action === "completeTask"
          ? {
              evidenceNote:
                "Synthetic dependency work only; not a domain readiness proof",
            }
          : {}),
      },
      t.assigneePrincipalId!,
      tenant,
    );
  }
  if (dependencies)
    for (const dependency of accessTask.dependsOn) {
      await transition(dependency.id, "acceptTask");
      await transition(dependency.id, "completeTask");
    }
  if (accept) await transition(accessTask.id, "acceptTask");
  return { ...seed, accessTaskId: accessTask.id, transition };
}
export const taskWitness = (member = 0): JsonObject => ({
  accountRef: "synthetic-task-access-" + member,
  observedOn: "2026-09-08",
  validUntil: "2026-09-14",
  verificationMethod: "Synthetic local account and role check",
  note: "Synthetic witness only",
  humanConfirmed: true,
});
