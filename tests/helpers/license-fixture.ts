import type { JsonObject } from "../../src/contracts.js";
import { purchasingFixture } from "./purchasing-fixture.js";
export function licenseFixture(
  directory: string,
  options: Parameters<typeof purchasingFixture>[1] = {},
) {
  const f = purchasingFixture(directory, options);
  const licenseAction = async (
    id: string,
    action: string,
    input: JsonObject = {},
    tenant = "synthetic-a",
    actor = "manager",
  ) => {
    const e = f.get("licenses", id, tenant);
    const run = await f.complete(
      `ops.licenses.${action}`,
      { id, expectedVersion: e.version, ...input },
      actor,
      tenant,
    );
    return f.get(
      "licenses",
      String(run.steps[0]!.output!.data.entityId),
      tenant,
    );
  };
  const seedLicense = async (tenant = "synthetic-a") => {
    const supplier = await f.create(
      "Synthetic license supplier",
      { kind: "supplier", description: "No external service" },
      tenant,
    );
    const run = await f.complete(
      "ops.licenses.create",
      {
        title: "SYNTHETIC license pool",
        data: {
          product: "SYNTHETIC product",
          totalSeats: 2,
          expiresOn: "2026-09-20",
          supplierId: supplier.id,
        },
      },
      "manager",
      tenant,
    );
    const pool = f.get(
      "licenses",
      String(run.steps[0]!.output!.data.entityId),
      tenant,
    );
    const terms: JsonObject = {
      supplierId: supplier.id,
      supplierVersion: supplier.version,
      agreementReference: "SYNTHETIC-CONTRACT",
      ownerPrincipalId: "manager",
      validFrom: "2026-09-01",
      expiresOn: "2027-08-31",
      totalSeats: 3,
      totalCostMinor: 12345,
      currency: tenant === "synthetic-a" ? "PLN" : "USD",
      priceBasis: "gross",
      renewalLeadDays: 45,
      description: "Entire period; synthetic terms only",
    };
    return { pool, supplier, terms };
  };
  const decision = (id: string, tenant = "synthetic-a") =>
    licenseAction(
      id,
      "decideTerms",
      {
        decision: "approved",
        note: "Synthetic owner approves exact cost",
        humanDecision: true,
      },
      tenant,
    );
  const confirmInput = (
    id: string,
    tenant = "synthetic-a",
    doc = "SYNTHETIC-DOC-1",
  ): JsonObject => {
    const e = f.get("licenses", id, tenant);
    return {
      id,
      expectedVersion: e.version,
      costDecisionHash: (e.data.costDecision as JsonObject).hash!,
      confirmationReference: doc,
      confirmationLine: 1,
      confirmedOn: "2026-09-08",
      evidenceNote: "Synthetic local attestation",
      humanConfirmed: true,
    };
  };
  const view = (id: string, tenant = "synthetic-a") =>
    f.workspace.licenseContracts(f.actor("manager", tenant), id);
  return {
    ...f,
    licenseAction,
    seedLicense,
    decision,
    confirmInput,
    licenseView: view,
  };
}
