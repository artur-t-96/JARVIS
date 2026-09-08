import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../src/contracts.js";
import type { CustodyFixture } from "./custody-fixture.js";

export async function replacementAsset(
  h: CustodyFixture,
  tenant = "synthetic-a",
  assetType = "laptop",
) {
  const run = await h.complete(
    "ops.assets.create",
    {
      title: "SYNTHETIC REPLACEMENT DEVICE",
      data: {
        assetType,
        serial: randomUUID(),
        location: "Synthetic replacement stock",
        condition: "good",
      },
    },
    "manager",
    tenant,
  );
  return h.get("assets", String(run.steps[0]!.output!.data.entityId), tenant);
}
export function replacementInput(
  h: CustodyFixture,
  sourceId: string,
  targetId: string,
  tenant = "synthetic-a",
): JsonObject {
  const source = h.get("assets", sourceId, tenant),
    target = h.get("assets", targetId, tenant);
  const allocation = (source.data.allocations as JsonObject[]).find(
    (a) => a.status === "reserved",
  )!;
  return {
    id: source.id,
    expectedVersion: source.version,
    allocationId: allocation.id!,
    expectedAllocationVersion: allocation.version!,
    replacementAssetId: target.id,
    expectedReplacementVersion: target.version,
    reason: "Synthetic substitution of the exact reservation",
  };
}
