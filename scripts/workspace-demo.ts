import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
import type { JsonObject, Principal } from "../src/contracts.js";

// Independent synthetic demonstration. Never reads .env or the application's .data.
const directory = mkdtempSync(join(tmpdir(), "jarvis-workspace-demo-"));
const workspace = new WorkspaceStore(join(directory, "operations.sqlite"));
const tools = workspace.tools();
const operator: Principal = {
  id: "demo-operator",
  tenantId: "synthetic-demo",
  roles: ["operator"],
  scopes: ["*"],
};
const approver: Principal = {
  ...operator,
  id: "demo-approver",
  roles: ["approver"],
};
const engine = new Engine({
  dbPath: join(directory, "core.sqlite"),
  tools,
  principals: [operator, approver],
  policies: [
    {
      tenantId: operator.tenantId,
      name: "Synthetic demonstration only",
      version: "1",
      allowedTools: tools.map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: false,
    },
  ],
});
const today = new Date().toISOString().slice(0, 10);
let completedCommands = 0;
let verifiedSteps = 0;
let approvals = 0;
async function command(module: string, action: string, input: JsonObject) {
  let run = engine.createRun(
    operator,
    `Syntetyczne demo: ${module}.${action}`,
    {
      title: `${module}.${action}`,
      summary: "Syntetyczne dane, zatwierdzenie przez drugie konto testowe",
      steps: [
        {
          id: "operation",
          title: `${module}.${action}`,
          toolId: `ops.${module}.${action}`,
          input,
        },
      ],
    },
    randomUUID(),
  );
  engine.start(operator, run.id);
  await engine.tick();
  run = engine.getRun(operator, run.id);
  assert.equal(run.status, "waiting_approval");
  const approval = run.steps[0]!.approval!;
  engine.approve(approver, run.id, {
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    decision: "approved",
  });
  approvals++;
  for (let i = 0; i < 4; i++) await engine.tick();
  run = engine.getRun(operator, run.id);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.steps[0]!.verification?.ok, true);
  completedCommands++;
  verifiedSteps++;
  return workspace.get(
    operator,
    module,
    String(run.steps[0]!.output!.data.entityId),
  );
}
const create = (module: string, title: string, data: JsonObject) =>
  command(module, "create", { title: `DEMO — ${title}`, data });
const action = (entity: Entity, operation: string, fields: JsonObject = {}) =>
  command(entity.module, operation, {
    id: entity.id,
    expectedVersion: entity.version,
    ...fields,
  });
async function accept(id: string) {
  let entity = workspace.get(operator, "cases", id);
  for (const task of entity.data.tasks as JsonObject[])
    entity = await action(entity, "completeTask", {
      taskId: task.id!,
      evidenceNote: "Syntetyczny protokół demonstracyjny",
      humanConfirmed: true,
    });
  entity = await action(entity, "addEvidence", {
    title: "DEMO protokół",
    reference: "synthetic-only",
    note: "Syntetyczne poświadczenie konta demonstracyjnego",
    humanConfirmed: true,
  });
  entity = await action(entity, "submit");
  assert.equal(entity.status, "awaiting_acceptance");
  return action(entity, "accept", {
    decision: "accepted",
    note: "Syntetyczny odbiór biznesowy",
    humanDecision: true,
  });
}

try {
  let person = await create("people", "Osoba wewnętrzna", {
    personCategory: "internal",
  });
  person = await action(person, "startEmployment", {
    employmentKind: "internal",
    startDate: "2020-01-01",
    role: "Rola demonstracyjna",
    humanDecision: true,
  });
  await accept(String(person.data.onboardingCaseId));
  person = await action(person, "activate", { humanDecision: true });
  let asset = await create("assets", "Laptop", {
    assetType: "laptop",
    serial: "SYNTHETIC-DEMO-001",
    location: "Laboratorium demonstracyjne",
    condition: "good",
  });
  asset = await action(asset, "reserve", {
    personId: person.id,
    purpose: "Demonstracja",
    until: "2099-01-01",
  });
  asset = await action(asset, "issue", {
    personId: person.id,
    issuedOn: today,
    handoverNote: "Syntetyczny protokół",
    humanConfirmed: true,
  });
  const supplier = await create("purchases", "Dostawca", {
    kind: "supplier",
    description: "Syntetyczny dostawca — bez wysyłki",
  });
  let purchase = await create("purchases", "Zamówienie", {
    kind: "order",
    description: "Demonstracyjne zamówienie",
    supplierId: supplier.id,
    quantity: 1,
  });
  purchase = await action(purchase, "placeOrder");
  purchase = await action(purchase, "acknowledge", {
    supplierReference: "SYNTHETIC-PO",
    acknowledgedOn: today,
    evidenceNote: "Demonstracyjne potwierdzenie",
    humanConfirmed: true,
  });
  assert.equal(purchase.data.receivedQuantity, 0);
  purchase = await action(purchase, "recordDelivery", {
    quantityReceived: 1,
    receivedOn: today,
    deliveryNote: "Syntetyczne poświadczenie",
    humanConfirmed: true,
  });
  let license = await create("licenses", "Licencja", {
    product: "Syntetyczny produkt",
    totalSeats: 1,
  });
  license = await action(license, "assign", {
    personId: person.id,
    note: "Lokalny rejestr demonstracyjny",
  });
  const client = await create("sales", "Klient", {
    kind: "client",
    organizationName: "Syntetyczna firma",
  });
  let deal = await create("sales", "Szansa", {
    kind: "deal",
    organizationName: "Syntetyczna firma",
    parentId: client.id,
  });
  deal = await action(deal, "qualify", {
    qualification: "Syntetyczne warunki i budżet",
  });
  let offer = await create("sales", "Oferta", {
    kind: "offer",
    organizationName: "Syntetyczna firma",
    parentId: deal.id,
    scope: "Syntetyczny zakres realizacji",
    value: 100,
    currency: "PLN",
  });
  offer = await action(offer, "submitOffer");
  offer = await action(offer, "acceptOffer", {
    acceptedOn: today,
    acceptanceNote: "Syntetyczna akceptacja",
    humanDecision: true,
  });
  offer = await action(offer, "handoff", {
    acceptanceCriteria: "Syntetyczny protokół odbioru",
  });
  let delivery = workspace.get(
    operator,
    "cases",
    String(offer.data.deliveryCaseId),
  );
  delivery = await action(delivery, "addTask", {
    title: "Demonstracyjne wykonanie",
    required: true,
  });
  delivery = await action(delivery, "addWorklog", {
    description: "Syntetyczny czas i koszt",
    minutes: 90,
    performedOn: today,
    amount: 12.34,
    currency: "PLN",
  });
  delivery = await accept(delivery.id);
  assert.equal((delivery.data.settlementDraft as JsonObject).kind, "draft");
  const candidate = await create("people", "Kandydat kontraktorski", {
    personCategory: "contractor",
  });
  const vacancy = await create("recruitment", "Rekrutacja", {
    kind: "vacancy",
    employmentKind: "contractor",
    description: "Syntetyczna potrzeba",
  });
  let application = await create("recruitment", "Aplikacja", {
    kind: "application",
    employmentKind: "contractor",
    personId: candidate.id,
    vacancyId: vacancy.id,
    description: "Syntetyczny kandydat",
  });
  application = await action(application, "screen", {
    decision: "advance",
    assessment: "Syntetyczna decyzja",
    humanDecision: true,
  });
  application = await action(application, "interview", {
    assessment: "Syntetyczna rozmowa",
    humanDecision: true,
  });
  application = await action(application, "makeOffer", {
    terms: "Syntetyczna propozycja",
    startDate: "2020-01-01",
  });
  application = await action(application, "decide", {
    decision: "accepted",
    reason: "Syntetyczna decyzja",
    humanDecision: true,
  });
  application = await action(application, "hire", {
    startDate: "2020-01-01",
    role: "Syntetyczny kontraktor",
    humanDecision: true,
  });
  let document = await create("documents", "Raport odbioru", {
    accessScope: "sales",
    documentType: "report",
    content: "Syntetyczna zamrożona treść raportu",
    sources: [
      {
        module: "cases",
        id: delivery.id,
        version: delivery.version,
        observedAt: new Date().toISOString(),
      },
    ],
  });
  document = await action(document, "submit");
  document = await action(document, "approve", {
    decision: "approved",
    note: "Syntetyczna akceptacja wersji",
    humanDecision: true,
  });
  let incident = await create("it", "Incydent laboratoryjny", {
    kind: "incident",
    description: "Syntetyczna obserwacja",
    severity: "low",
    environment: "lab",
  });
  incident = await action(incident, "triage", {
    assessment: "Syntetyczna diagnoza",
  });
  incident = await action(incident, "recordAction", {
    actionNote: "Syntetyczna procedura człowieka",
    evidenceNote: "Syntetyczne poświadczenie",
    humanConfirmed: true,
  });
  incident = await action(incident, "resolve", {
    resolution: "Syntetyczny rezultat",
    evidenceNote: "Syntetyczny protokół",
    humanConfirmed: true,
  });
  person = await action(person, "beginOffboarding", {
    endDate: today,
    reason: "Koniec demonstracji",
    humanDecision: true,
  });
  asset = await action(asset, "return", {
    returnedOn: today,
    condition: "good",
    receiptNote: "Syntetyczny zwrot",
    humanConfirmed: true,
  });
  license = await action(license, "revoke", {
    personId: person.id,
    reason: "Koniec demonstracji",
  });
  await accept(String(person.data.offboardingCaseId));
  person = await action(person, "endEmployment", {
    endDate: today,
    reason: "Koniec demonstracji",
    humanDecision: true,
  });
  const summary = workspace.summary(operator);
  assert.equal(summary.modules.filter((module) => module.total > 0).length, 9);
  assert.equal(person.status, "exited");
  assert.equal(asset.status, "available");
  process.stdout.write(
    `${JSON.stringify({ synthetic: true, storage: "temporary databases removed after demonstration", modules: summary.modules, completedCommands, explicitApprovals: approvals, independentlyVerifiedSteps: verifiedSteps, acceptanceProof: { status: delivery.status, decidedBy: (delivery.data.currentAcceptance as JsonObject).decidedBy, settlementDraft: delivery.data.settlementDraft }, offboarding: person.status, asset: asset.status, purchase: purchase.status, recruitment: application.status, document: document.status, incident: incident.status, externalActionsPerformed: false }, null, 2)}\n`,
  );
} finally {
  engine.close();
  workspace.close();
  rmSync(directory, { recursive: true, force: true });
}
