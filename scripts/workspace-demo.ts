import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
import { InitiativeStore } from "../src/initiative.js";
import type { JsonObject, Principal } from "../src/contracts.js";

// Independent synthetic demonstration. Never reads .env or the application's .data.
const directory = mkdtempSync(join(tmpdir(), "jarvis-workspace-demo-"));
const workspace = new WorkspaceStore(join(directory, "operations.sqlite"));
const initiatives = new InitiativeStore(
  join(directory, "initiatives.sqlite"),
  workspace,
);
workspace.setProfileProvider((tenant) => initiatives.profileForTenant(tenant));
const tools = [...workspace.tools(), ...initiatives.tools()];
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
workspace.setPrincipalProvider(() => [operator, approver]);
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
async function approved(toolId: string, input: JsonObject) {
  let run = engine.createRun(
    operator,
    `Syntetyczne demo: ${toolId}`,
    {
      title: `${toolId}`,
      summary: "Syntetyczne dane, zatwierdzenie przez drugie konto testowe",
      steps: [
        {
          id: "operation",
          title: `${toolId}`,
          toolId,
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
  return run;
}
async function command(module: string, action: string, input: JsonObject) {
  // Only this synthetic demo asserts a single open period before choosing it.
  // Operational commands require the user's explicit period ID and version.
  if (
    (module === "people" &&
      ["activate", "beginOffboarding", "endEmployment"].includes(action)) ||
    (module === "assets" && ["reserve", "issue"].includes(action)) ||
    (module === "licenses" && ["assign", "revoke"].includes(action))
  ) {
    const episodes = workspace
      .listEmploymentEpisodes(
        operator,
        String(module === "people" ? input.id : input.personId),
      )
      .filter((e) => e.status !== "ended");
    assert.equal(
      episodes.length,
      1,
      "demo must select exactly one open employment period",
    );
    input = {
      ...(module === "assets"
        ? { caseId: episodes[0]!.onboardingCaseId! }
        : {}),
      employmentEpisodeId: episodes[0]!.id,
      expectedEpisodeVersion: episodes[0]!.version,
      ...input,
    };
  }
  if (
    module === "assets" &&
    ["issue", "return", "release", "expireReservation"].includes(action)
  ) {
    const active = (
      workspace.get(operator, "assets", String(input.id)).data
        .allocations as JsonObject[]
    ).filter((item) => ["reserved", "issued"].includes(String(item.status)));
    assert.equal(
      active.length,
      1,
      "demo must select exactly one current allocation",
    );
    input = {
      allocationId: active[0]!.id!,
      expectedAllocationVersion: active[0]!.version!,
      ...input,
    };
  }
  const run = await approved(`ops.${module}.${action}`, input);
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
  for (const task of entity.data.tasks as JsonObject[]) {
    if (task.status === "completed") continue;
    entity = await action(entity, "acceptTask", {
      taskId: task.id!,
      expectedTaskVersion: task.version!,
      humanConfirmed: true,
    });
    const acceptedTask = (entity.data.tasks as JsonObject[]).find(
      (t) => t.id === task.id,
    )!;
    entity = await action(entity, "completeTask", {
      taskId: task.id!,
      expectedTaskVersion: acceptedTask.version!,
      evidenceNote: "Syntetyczny protokół demonstracyjny",
      humanConfirmed: true,
    });
  }
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
  const {
    companyName,
    timezone,
    licenseReminderDays,
    quietHours,
    rules,
    processTemplates,
    employmentPolicy,
  } = initiatives.profile(operator);
  await approved("initiatives.configure", {
    expectedVersion: 0,
    companyName,
    timezone,
    licenseReminderDays,
    quietHours,
    rules,
    processTemplates,
    employmentPolicy,
    roleBindings: { hr: operator.id, it: operator.id, manager: operator.id },
  });
  let person = await create("people", "Osoba wewnętrzna", {
    personCategory: "internal",
  });
  person = await action(person, "startEmployment", {
    employmentKind: "internal",
    startDate: "2020-01-01",
    role: "Rola demonstracyjna",
    humanDecision: true,
  });
  let onboardingReadiness = workspace.readiness(
    operator,
    String(person.data.onboardingCaseId),
  );
  assert.equal(
    onboardingReadiness.ready,
    false,
    "Missing typed proofs must block onboarding",
  );
  assert.ok(
    onboardingReadiness.requirements.some(
      (requirement) =>
        requirement.kind === "access_attested" &&
        requirement.status !== "satisfied",
    ),
  );
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
  const onboardingCase = workspace.get(
    operator,
    "cases",
    String(person.data.onboardingCaseId),
  );
  const equipmentTask = (onboardingCase.data.tasks as JsonObject[]).find(
    (task) =>
      Array.isArray(task.requirementKeys) &&
      task.requirementKeys.length === 1 &&
      task.requirementKeys[0] === "equipment",
  );
  assert.ok(equipmentTask);
  await action(onboardingCase, "acceptTask", {
    taskId: equipmentTask.id!,
    expectedTaskVersion: equipmentTask.version!,
    humanConfirmed: true,
  });
  let equipment = workspace.taskEquipment(operator, String(equipmentTask.id));
  const issueInput = equipment.allocations[0]!.commandBindings.issueForTask;
  assert.ok(issueInput);
  await approved("ops.assets.issueForTask", {
    ...issueInput,
    issuedOn: today,
    location: "Syntetyczna lokalizacja odbiorcy",
    condition: "good",
    handoverNote: "Syntetyczny protokół demonstracyjny",
    humanConfirmed: true,
  });
  equipment = workspace.taskEquipment(operator, String(equipmentTask.id));
  const bindingInput =
    equipment.allocations[0]!.commandBindings.bindAssetForTask;
  assert.ok(bindingInput);
  await approved("ops.assets.bindAssetForTask", bindingInput);
  onboardingReadiness = workspace.readiness(operator, onboardingCase.id);
  assert.equal(
    onboardingReadiness.requirements.find(
      (requirement) => requirement.key === "equipment",
    )?.status,
    "satisfied",
  );
  assert.equal(
    onboardingReadiness.ready,
    false,
    "document and access are separate required proofs",
  );
  asset = workspace.get(operator, "assets", asset.id);
  const supplier = await create("purchases", "Dostawca", {
    kind: "supplier",
    description: "Syntetyczny dostawca — bez wysyłki",
  });
  let request = await create("purchases", "Zapotrzebowanie", {
    kind: "request",
    description: "Syntetyczny zakup",
    quantity: 1,
    budgetMinor: 1000000,
    currency: "PLN",
    priceBasis: "gross",
    requiredBy: today,
  });
  const quote = await create("purchases", "Oferta dostawcy", {
    kind: "quote",
    requestId: request.id,
    expectedRequestVersion: request.version,
    supplierId: supplier.id,
    expectedSupplierVersion: supplier.version,
    quoteReference: "SYNTHETIC-QUOTE",
    description: "Syntetyczny zakup",
    quantity: 1,
    unitPriceMinor: 100000,
    shippingMinor: 0,
    currency: "PLN",
    priceBasis: "gross",
    validUntil: today,
    expectedDelivery: today,
    terms: "Syntetyczna oferta bez wysyłki",
  });
  request = workspace.get(operator, "purchases", request.id);
  request = await action(request, "selectQuote", {
    quoteId: quote.id,
    expectedQuoteVersion: quote.version,
    selectionReason: "Uzgodniony koszt i termin",
  });
  request = await action(request, "decideCost", {
    quoteId: quote.id,
    expectedQuoteVersion: quote.version,
    decision: "approved",
    note: "Jawna decyzja testowa",
    humanDecision: true,
  });
  const cost = request.data.costDecision as JsonObject;
  request = await action(request, "placeOrder", {
    costDecisionHash: cost.hash!,
    expectedSupplierVersion: supplier.version,
  });
  let purchase = workspace.get(
    operator,
    "purchases",
    String(request.data.orderId),
  );
  purchase = await action(purchase, "acknowledge", {
    supplierReference: "SYNTHETIC-PO",
    acknowledgedOn: today,
    evidenceNote: "Demonstracyjne potwierdzenie",
    humanConfirmed: true,
  });
  assert.equal(purchase.data.receivedQuantity, 0);
  purchase = await action(purchase, "recordDelivery", {
    quantityReceived: 1,
    quantityAccepted: 1,
    documentNumber: "SYNTHETIC-DELIVERY-1",
    documentLine: 1,
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
    kind: "work",
    assigneePrincipalId: operator.id,
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
    location: "Syntetyczny magazyn zwrotów",
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
    `${JSON.stringify({ synthetic: true, storage: "temporary databases removed after demonstration", modules: summary.modules, completedCommands, explicitApprovals: approvals, independentlyVerifiedSteps: verifiedSteps, acceptanceProof: { status: delivery.status, decidedBy: (delivery.data.currentAcceptance as JsonObject).decidedBy, settlementDraft: delivery.data.settlementDraft }, onboarding: { status: "blocked", requirementsBeforeOffboarding: onboardingReadiness.requirements }, offboarding: person.status, asset: asset.status, purchase: purchase.status, recruitment: application.status, document: document.status, incident: incident.status, externalActionsPerformed: false }, null, 2)}\n`,
  );
} finally {
  engine.close();
  initiatives.close();
  workspace.close();
  rmSync(directory, { recursive: true, force: true });
}
