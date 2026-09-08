import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  laboratoryTarget,
  laboratoryDefinition,
  type LaboratoryTarget,
} from "../../src/laboratory-contract.js";
import { LocalLaboratory } from "../../src/laboratory.js";
import { type JsonObject, type ToolDefinition } from "../../src/contracts.js";
import { custodyFixture, custodyNow } from "./custody-fixture.js";

export async function itCaseFixture(
  directory: string,
  options: {
    target?: LaboratoryTarget;
    clock?: () => number;
    engineClock?: () => number;
    wrap?: (tool: ToolDefinition) => ToolDefinition;
  } = {},
) {
  const target = options.target ?? laboratoryTarget;
  const clock = options.clock ?? (() => custodyNow),
    laboratory = new LocalLaboratory(join(directory, "laboratory.sqlite"), {
      clock,
    });
  await laboratory.start();
  const f = custodyFixture(directory, {
    domainClock: clock,
    clock: options.engineClock ?? clock,
    wrap: options.wrap,
    extraTools: (workspace) => {
      workspace.setLaboratory(laboratory);
      return laboratory.tools();
    },
  });
  laboratory.setOutcomeReader((tenant, runId, stepId) =>
    f.engine.verificationReceipt(tenant, runId, stepId),
  );
  const inspect = async (tenant = "synthetic-a") => {
    const run = f.engine.createRun(
      f.actor("manager", tenant),
      "Synthetic HTTP observation",
      {
        title: "Synthetic HTTP",
        summary: "Own laboratory only",
        steps: [
          {
            id: "inspect",
            title: "HTTP",
            toolId: laboratoryDefinition(target).inspectTool,
            input: {},
          },
        ],
      },
      randomUUID(),
    );
    f.engine.start(f.actor("manager", tenant), run.id);
    for (let i = 0; i < 3; i++) await f.engine.tick();
    assert.equal(
      f.engine.getRun(f.actor("manager", tenant), run.id).status,
      "completed",
    );
    return f.workspace.laboratoryOverview(f.actor("manager", tenant), target)
      .observed!;
  };
  const openingInput = (tenant = "synthetic-a"): JsonObject => {
    const view = f.workspace.laboratoryOverview(
        f.actor("manager", tenant),
        target,
      ),
      o = view.observed!;
    return {
      title: `Synthetic IT case ${tenant}`,
      data: {
        caseType: "it",
        brief: "HTTP unavailable; restore own fixture. No external target.",
        acceptanceCriteria: "Independent HTTP 200 and explicit acceptance",
        dueDate: "2026-09-09",
        laboratory: {
          targetId: view.targetId,
          observationId: o.id,
          observationHash: o.hash,
          procedureId: view.procedureId,
          procedureVersion: view.procedureVersion,
        },
      },
    };
  };
  const open = async (tenant = "synthetic-a") => {
    await inspect(tenant);
    const run = await f.complete(
      "ops.cases.create",
      openingInput(tenant),
      "manager",
      tenant,
    );
    return String(run.steps[0]!.output!.data.entityId);
  };
  const view = (caseId: string, tenant = "synthetic-a") =>
    f.workspace.laboratoryCase(f.actor("manager", tenant), caseId);
  const bind = async (caseId: string, tenant = "synthetic-a") => {
    const v = view(caseId, tenant),
      proof = v.proofs.find((p) => p.identity.current)!;
    assert.ok(proof, JSON.stringify(v));
    return f.complete(
      "ops.cases.bindEvidence",
      {
        id: caseId,
        expectedVersion: f.get("cases", caseId, tenant).version,
        requirementId: v.readiness.requirements[0]!.id,
        sourceModule: "laboratory",
        sourceId: proof.id,
        sourceVersion: proof.version,
        sourceProofHash: proof.hash,
      },
      "manager",
      tenant,
    );
  };
  const failCommand = async (
    tool: string,
    input: JsonObject,
    tenant = "synthetic-a",
  ) => {
    const run = await f.stage(tool, input, "manager", tenant);
    f.approve(run, tenant);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    const result = f.engine.getRun(f.actor("manager", tenant), run.id);
    assert.notEqual(result.status, "completed", JSON.stringify(result));
    return result;
  };
  return {
    ...f,
    laboratory,
    inspect,
    openingInput,
    open,
    view,
    bind,
    failCommand,
    async close() {
      f.close();
      await laboratory.close();
    },
  };
}
export type ItCaseFixture = Awaited<ReturnType<typeof itCaseFixture>>;
