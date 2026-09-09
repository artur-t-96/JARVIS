import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../src/contracts.js";
import { custodyFixture } from "./custody-fixture.js";
export function stocktakeFixture(
  directory: string,
  options: Parameters<typeof custodyFixture>[1] = {},
) {
  const f = custodyFixture(directory, options);
  for (const tenant of ["synthetic-a", "synthetic-b"])
    f.actor("it-two", tenant).scopes = ["inventory", "assets"];
  const newAsset = async (tenant = "synthetic-a", serial = randomUUID()) => {
    const r = await f.complete(
      "ops.assets.create",
      {
        title: "SYNTHETIC STOCKTAKE " + serial,
        data: {
          assetType: "laptop",
          serial,
          location: "Synthetic stock",
          condition: "good",
        },
      },
      "manager",
      tenant,
    );
    return f.get("assets", String(r.steps[0]!.output!.data.entityId), tenant);
  };
  const createInput = (
    ids: string[],
    tenant = "synthetic-a",
    owner = "manager",
  ): JsonObject => ({
    title: "SYNTHETIC stocktake",
    data: {
      ownerPrincipalId: owner,
      dueDate: "2026-09-10",
      note: "Synthetic inventory proof",
      profileVersion: f.initiatives.profileForTenant(tenant).version,
      assetPins: ids.map((id) => ({
        id,
        expectedVersion: f.get("assets", id, tenant).version,
      })),
    },
  });
  const open = async (
    ids: string[],
    tenant = "synthetic-a",
    owner = "manager",
  ) => {
    const r = await f.complete(
      "ops.inventory.create",
      createInput(ids, tenant, owner),
      "manager",
      tenant,
    );
    return f.get(
      "inventory",
      String(r.steps[0]!.output!.data.entityId),
      tenant,
    );
  };
  const input = (
    id: string,
    values: JsonObject,
    tenant = "synthetic-a",
  ): JsonObject => ({
    id,
    expectedVersion: f.get("inventory", id, tenant).version,
    ...values,
  });
  const act = async (
    id: string,
    action: string,
    values: JsonObject,
    tenant = "synthetic-a",
    actor = "manager",
  ) => {
    const r = await f.complete(
      `ops.inventory.${action}`,
      input(id, values, tenant),
      actor,
      tenant,
    );
    return f.get(
      "inventory",
      String(r.steps[0]!.output!.data.entityId),
      tenant,
    );
  };
  const observeInput = (
    id: string,
    assetId: string,
    values: JsonObject = {},
    tenant = "synthetic-a",
  ) => {
    const a = f.get("assets", assetId, tenant);
    return input(
      id,
      {
        assetId,
        expectedAssetVersion: a.version,
        present: true,
        location: a.data.location!,
        condition: a.data.condition!,
        observedOn: "2026-09-08",
        note: "Synthetic physical observation only",
        humanConfirmed: true,
        ...values,
      },
      tenant,
    );
  };
  const view = (id: string, tenant = "synthetic-a") =>
    f.workspace.stocktakeReport(f.actor("manager", tenant), id);
  const resolveInput = (
    id: string,
    assetId: string,
    tenant = "synthetic-a",
  ) => {
    const l = view(id, tenant).lines.find((l) => l.baseline.id === assetId)!;
    assert.ok(l.observation);
    return input(
      id,
      {
        assetId,
        expectedAssetVersion: l.current.version,
        observationId: l.observation.id,
        observationHash: l.observation.hash,
        reason: "Synthetic owner checked matching evidence",
        humanDecision: true,
      },
      tenant,
    );
  };
  const failRun = async (
    toolId: string,
    values: JsonObject,
    tenant = "synthetic-a",
    actor = "manager",
  ) => {
    const r = await f.stage(toolId, values, actor, tenant);
    f.approve(r, tenant);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    const result = f.engine.getRun(f.actor(actor, tenant), r.id);
    assert.notEqual(result.status, "completed", JSON.stringify(result));
    return result;
  };
  return {
    ...f,
    newAsset,
    createInput,
    open,
    input,
    act,
    observeInput,
    view,
    resolveInput,
    failRun,
  };
}
