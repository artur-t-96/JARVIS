import type { JsonObject } from "../../src/contracts.js";
import { custodyFixture } from "./custody-fixture.js";

export function salesFixture(
  directory: string,
  options: Parameters<typeof custodyFixture>[1] = {},
) {
  const f = custodyFixture(directory, options);
  const create = async (
    title: string,
    data: JsonObject,
    tenant = "synthetic-a",
    actor = "manager",
  ) => {
    const run = await f.complete(
      "ops.sales.create",
      { title, data },
      actor,
      tenant,
    );
    return f.get("sales", String(run.steps[0]!.output!.data.entityId), tenant);
  };
  const action = async (
    id: string,
    name: string,
    input: JsonObject = {},
    tenant = "synthetic-a",
    actor = "manager",
  ) => {
    const e = f.get("sales", id, tenant);
    const run = await f.complete(
      `ops.sales.${name}`,
      { id, expectedVersion: e.version, ...input },
      actor,
      tenant,
    );
    return f.get("sales", String(run.steps[0]!.output!.data.entityId), tenant);
  };
  const terms: JsonObject = {
    scope: "Syntetyczny zakres utrzymania i uruchomienia",
    validUntil: "2026-10-01",
    currency: "PLN",
    priceBasis: "net",
    lines: [
      {
        label: "Syntetyczne utrzymanie",
        unit: "month",
        quantityMilli: 3000,
        unitPriceMinor: 12345,
      },
      {
        label: "Syntetyczne uruchomienie",
        unit: "fixed",
        quantityMilli: 1000,
        unitPriceMinor: 25000,
      },
    ],
  };
  const pins = (dealId: string, tenant = "synthetic-a") => {
    const deal = f.get("sales", dealId, tenant);
    return {
      expectedDealVersion: deal.version,
      expectedClientVersion: f.get("sales", String(deal.data.parentId), tenant)
        .version,
      expectedContactVersion: f.get(
        "sales",
        String(deal.data.contactId),
        tenant,
      ).version,
    };
  };
  const seed = async (tenant = "synthetic-a") => {
    const client = await create(
      "SYNTHETIC klient",
      { kind: "client", organizationName: "Firma syntetyczna" },
      tenant,
    );
    const contact = await create(
      "SYNTHETIC kontakt",
      {
        kind: "contact",
        parentId: client.id,
        contactEmail: "test@example.invalid",
      },
      tenant,
    );
    let deal = await create(
      "SYNTHETIC szansa",
      {
        kind: "deal",
        parentId: client.id,
        contactId: contact.id,
        ownerPrincipalId: "manager",
      },
      tenant,
    );
    deal = await action(
      deal.id,
      "qualify",
      { qualification: "Potrzeba i zakres uzgodnione na danych syntetycznych" },
      tenant,
    );
    const offer = await create(
      "SYNTHETIC oferta",
      { kind: "offer", parentId: deal.id, ...pins(deal.id, tenant), terms },
      tenant,
    );
    return { client, contact, deal, offer };
  };
  const send = async (id: string, tenant = "synthetic-a") => {
    await action(id, "submitOffer", {}, tenant);
    await action(
      id,
      "reviewOffer",
      {
        decision: "approved",
        note: "Syntetyczna decyzja wewnętrzna",
        humanDecision: true,
      },
      tenant,
    );
    return action(
      id,
      "recordDispatch",
      {
        channel: "meeting",
        dispatchedOn: "2026-09-08",
        evidenceReference: "SYNTHETIC-MEETING",
        note: "Wyłącznie scenariusz syntetyczny",
        humanConfirmed: true,
      },
      tenant,
    );
  };
  const accept = (id: string, tenant = "synthetic-a") =>
    action(
      id,
      "acceptOffer",
      {
        acceptedOn: "2026-09-08",
        acceptanceNote: "Syntetyczna odpowiedź klienta",
        evidenceReference: "SYNTHETIC-ACCEPTANCE",
        humanDecision: true,
      },
      tenant,
    );
  const next = async (dealId: string, tenant = "synthetic-a") => {
    const d = await action(
      dealId,
      "scheduleNextStep",
      {
        title: "SYNTHETIC ustalenie realizacji",
        description: "Kontakt i ustalenie zakresu",
        dueDate: "2026-09-09",
        ownerPrincipalId: "manager",
      },
      tenant,
    );
    return action(
      String(d.data.nextStepId),
      "acceptNextStep",
      { humanConfirmed: true },
      tenant,
    );
  };
  return {
    ...f,
    salesCreate: create,
    salesAction: action,
    salesSeed: seed,
    salesSend: send,
    salesAccept: accept,
    salesNext: next,
    salesPins: pins,
    salesTerms: terms,
  };
}
