import type { JsonObject } from "../../src/contracts.js";
import { purchasingFixture } from "./purchasing-fixture.js";

export function deliveryFixture(
  directory: string,
  options: Parameters<typeof purchasingFixture>[1] = {},
) {
  const f = purchasingFixture(directory, options);
  const order = async (tenant = "synthetic-a", link: JsonObject = {}) => {
    const supplier = await f.create(
      "Synthetic delivery supplier",
      { kind: "supplier", description: "Synthetic only" },
      tenant,
    );
    const request = await f.create(
      "Synthetic laptop need",
      {
        kind: "request",
        description: "Synthetic stock",
        quantity: 2,
        budgetMinor: 1000000,
        currency: "PLN",
        priceBasis: "gross",
        requiredBy: "2026-09-20",
        assetType: "laptop",
        ...link,
      },
      tenant,
    );
    const quote = await f.create(
      "Synthetic offer",
      f.quotation(request.id, supplier.id, tenant),
      tenant,
    );
    await f.select(request.id, quote.id, tenant);
    await f.approveCost(request.id, quote.id, tenant);
    await f.complete(
      "ops.purchases.placeOrder",
      f.orderInput(request.id, tenant),
      "manager",
      tenant,
    );
    const id = String(f.get("purchases", request.id, tenant).data.orderId);
    const ordered = await f.action(
      id,
      "acknowledge",
      {
        supplierReference: "SYNTHETIC-PO",
        acknowledgedOn: "2026-09-08",
        evidenceNote: "Synthetic supplier acknowledgment",
        humanConfirmed: true,
      },
      tenant,
    );
    return {
      supplier,
      request: f.get("purchases", request.id, tenant),
      order: ordered,
    };
  };
  const deliveries = (id: string, tenant = "synthetic-a") =>
    f.workspace.purchaseDeliveries(f.actor("manager", tenant), id);
  const deliveryInput = (
    id: string,
    documentNumber: string,
    quantityReceived: number,
    quantityAccepted = quantityReceived,
    tenant = "synthetic-a",
  ): JsonObject => ({
    id,
    expectedVersion: f.get("purchases", id, tenant).version,
    documentNumber,
    documentLine: 1,
    quantityReceived,
    quantityAccepted,
    receivedOn: "2026-09-08",
    deliveryNote: "Synthetic physical receipt",
    ...(quantityReceived > quantityAccepted
      ? { rejectionReason: "Damaged unit" }
      : {}),
    humanConfirmed: true,
  });
  return { ...f, order, deliveries, deliveryInput };
}
