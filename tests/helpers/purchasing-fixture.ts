import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import type { JsonObject } from "../../src/contracts.js";
import { custodyFixture } from "./custody-fixture.js";

export function purchasingFixture(
  directory: string,
  options: Parameters<typeof custodyFixture>[1] = {},
) {
  const f = custodyFixture(directory, options);
  const create = async (
    title: string,
    data: JsonObject,
    tenant = "synthetic-a",
  ) => {
    const run = await f.complete(
      "ops.purchases.create",
      { title, data },
      "manager",
      tenant,
    );
    return f.get(
      "purchases",
      String(run.steps[0]!.output!.data.entityId),
      tenant,
    );
  };
  const action = async (
    id: string,
    name: string,
    data: JsonObject = {},
    tenant = "synthetic-a",
  ) => {
    const current = f.get("purchases", id, tenant);
    const run = await f.complete(
      `ops.purchases.${name}`,
      { id, expectedVersion: current.version, ...data },
      "manager",
      tenant,
    );
    return f.get(
      "purchases",
      String(run.steps[0]!.output!.data.entityId),
      tenant,
    );
  };
  const view = (id: string, tenant = "synthetic-a") =>
    f.workspace.purchasing(f.actor("manager", tenant), id);
  const quotation = (
    requestId: string,
    supplierId: string,
    tenant = "synthetic-a",
    override: JsonObject = {},
  ): JsonObject => ({
    kind: "quote",
    requestId,
    expectedRequestVersion: f.get("purchases", requestId, tenant).version,
    supplierId,
    expectedSupplierVersion: f.get("purchases", supplierId, tenant).version,
    quoteReference: "SYNTHETIC-" + randomUUID(),
    description: "Dwa syntetyczne laptopy",
    quantity: 2,
    unitPriceMinor: 400000,
    shippingMinor: 10000,
    currency: "PLN",
    priceBasis: "gross",
    validUntil: "2026-09-30",
    expectedDelivery: "2026-09-15",
    terms: "Synthetic local quotation; no dispatch",
    ...override,
  });
  const seed = async (tenant = "synthetic-a") => {
    const supplier = await create(
      "Synthetic supplier",
      { kind: "supplier", description: "No external contact" },
      tenant,
    );
    const request = await create(
      "Synthetic equipment request",
      {
        kind: "request",
        description: "Equipment for synthetic workplace",
        quantity: 2,
        budgetMinor: 1000000,
        currency: "PLN",
        priceBasis: "gross",
        requiredBy: "2026-09-20",
        assetType: "laptop",
      },
      tenant,
    );
    const quote = await create(
      "Synthetic offer",
      quotation(request.id, supplier.id, tenant),
      tenant,
    );
    return { supplier, request: f.get("purchases", request.id, tenant), quote };
  };
  const select = async (id: string, quoteId: string, tenant = "synthetic-a") =>
    action(
      id,
      "selectQuote",
      {
        quoteId,
        expectedQuoteVersion: f.get("purchases", quoteId, tenant).version,
        selectionReason: "Termin i koszt odpowiadają potrzebie.",
      },
      tenant,
    );
  const approveCost = async (
    id: string,
    quoteId: string,
    tenant = "synthetic-a",
  ) =>
    action(
      id,
      "decideCost",
      {
        quoteId,
        expectedQuoteVersion: f.get("purchases", quoteId, tenant).version,
        decision: "approved",
        note: "Synthetic human cost decision",
        humanDecision: true,
      },
      tenant,
    );
  const orderInput = (id: string, tenant = "synthetic-a"): JsonObject => {
    const request = f.get("purchases", id, tenant),
      d = request.data.costDecision as JsonObject;
    return {
      id,
      expectedVersion: request.version,
      costDecisionHash: d.hash!,
      expectedSupplierVersion: d.supplierVersion!,
    };
  };
  const failRun = async (
    name: string,
    input: JsonObject,
    tenant = "synthetic-a",
  ) => {
    const run = await f.stage(name, input, "manager", tenant);
    f.approve(run, tenant);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    const result = f.engine.getRun(f.actor("manager", tenant), run.id);
    assert.notEqual(result.status, "completed", JSON.stringify(result));
    return result;
  };
  return {
    ...f,
    create,
    action,
    view,
    quotation,
    seedPurchase: seed,
    select,
    approveCost,
    orderInput,
    failRun,
  };
}
