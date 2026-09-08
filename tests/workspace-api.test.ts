import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { JsonObject, Principal } from "../src/contracts.js";
import { Engine, type RunDetail } from "../src/engine.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";

function fixture() {
  const workspace = new WorkspaceStore(":memory:");
  const tools = workspace.tools();
  const principals: Principal[] = ["a", "b"].flatMap((tenantId) => [
    { id: "operator", tenantId, roles: ["operator"], scopes: ["*"] },
    { id: "approver", tenantId, roles: ["approver"], scopes: ["*"] },
  ]);
  const config: AppConfig = {
    mode: "authenticated",
    host: "127.0.0.1",
    port: 4310,
    dataDir: "/unused",
    plannerKind: "demo",
    principals,
    policies: ["a", "b"].map((tenantId) => ({
      tenantId,
      name: "Test",
      version: "1",
      allowedTools: tools.map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: false,
    })),
    tokens: new Map(
      principals.map((p) => [
        `synthetic-credential-only-${p.tenantId}-${p.id}-aaaaaaaaaaaaaaaaaaaa`,
        p,
      ]),
    ),
  };
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals,
    policies: config.policies,
  });
  const app = createApp({
    engine,
    workspace,
    tools,
    config,
    planner: {
      kind: "test",
      async plan() {
        throw new Error("Unused planner");
      },
    },
  });
  const headers = (tenant = "a", role = "operator") => ({
    authorization: `Bearer synthetic-credential-only-${tenant}-${role}-aaaaaaaaaaaaaaaaaaaa`,
  });
  const post = (
    url: string,
    payload: object,
    tenant = "a",
    role = "operator",
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: headers(tenant, role),
      payload,
    });
  const get = (url: string, tenant = "a") =>
    app.inject({ method: "GET", url, headers: headers(tenant) });
  const command = async (
    module: string,
    action: string,
    input: JsonObject,
    tenant = "a",
  ) => {
    const principal = principals.find(
      (p) => p.tenantId === tenant && p.id === "operator",
    )!;
    // This fixture has one open period; API clients must make the selection explicitly.
    if (
      (module === "people" &&
        ["activate", "beginOffboarding", "endEmployment"].includes(action)) ||
      (module === "assets" && ["reserve", "issue"].includes(action)) ||
      (module === "licenses" && ["assign", "revoke"].includes(action))
    ) {
      const episodes = workspace
        .listEmploymentEpisodes(
          principal,
          String(module === "people" ? input.id : input.personId),
        )
        .filter((e) => e.status !== "ended");
      assert.equal(
        episodes.length,
        1,
        "fixture must select exactly one open employment period",
      );
      input = {
        employmentEpisodeId: episodes[0]!.id,
        expectedEpisodeVersion: episodes[0]!.version,
        ...input,
      };
    }
    const before = workspace.list(principal, module);
    const created = await post(
      "/api/commands",
      {
        toolId: `ops.${module}.${action}`,
        input,
        idempotencyKey: randomUUID(),
      },
      tenant,
    );
    assert.equal(created.statusCode, 201, created.body);
    let run = created.json<{ run: RunDetail }>().run;
    assert.equal(run.status, "planned");
    assert.equal(
      (await post(`/api/runs/${run.id}/start`, {}, tenant)).statusCode,
      200,
    );
    await engine.tick();
    run = (await get(`/api/runs/${run.id}`, tenant)).json<{ run: RunDetail }>()
      .run;
    assert.equal(run.status, "waiting_approval");
    assert.deepEqual(
      workspace.list(
        principals.find((p) => p.tenantId === tenant && p.id === "operator")!,
        module,
      ),
      before,
      "no effect before Core approval",
    );
    const approval = run.steps[0]!.approval!;
    const decision = {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    };
    assert.equal(
      (await post(`/api/runs/${run.id}/approve`, decision, tenant)).statusCode,
      403,
      "operator cannot self-approve",
    );
    assert.equal(
      (await post(`/api/runs/${run.id}/approve`, decision, tenant, "approver"))
        .statusCode,
      200,
    );
    for (let i = 0; i < 4; i++) await engine.tick();
    run = (await get(`/api/runs/${run.id}`, tenant)).json<{ run: RunDetail }>()
      .run;
    assert.equal(run.status, "completed", JSON.stringify(run));
    assert.equal(run.steps[0]!.verification!.ok, true);
    const entityResponse = await get(
      `/api/workspace/${module}/${run.steps[0]!.output!.data.entityId}`,
      tenant,
    );
    assert.equal(entityResponse.statusCode, 200);
    return { entity: entityResponse.json<{ item: Entity }>().item, run };
  };
  const create = async (
    module: string,
    title: string,
    data: JsonObject,
    tenant = "a",
  ) => (await command(module, "create", { title, data }, tenant)).entity;
  const action = async (
    entity: Entity,
    action: string,
    data: JsonObject = {},
    tenant = "a",
  ) =>
    (
      await command(
        entity.module,
        action,
        { id: entity.id, expectedVersion: entity.version, ...data },
        tenant,
      )
    ).entity;
  return {
    workspace,
    engine,
    app,
    config,
    post,
    get,
    command,
    create,
    action,
    async close() {
      await app.close();
      engine.close();
      workspace.close();
    },
  };
}

test("all nine domain APIs execute through Core approvals; asset handover is tenant-isolated and case acceptance is separate", async () => {
  const f = fixture();
  try {
    const today = new Date().toISOString().slice(0, 10);
    let person = await f.create("people", "Alicja Testowa", {
      personCategory: "internal",
    });
    person = await f.action(person, "startEmployment", {
      employmentKind: "internal",
      startDate: "2020-01-01",
      role: "Test",
      humanDecision: true,
    });
    let asset = await f.create("assets", "Laptop", {
      assetType: "laptop",
      serial: "ONLY-A",
      location: "Local",
      condition: "good",
    });
    const foreign = await f.create(
      "assets",
      "Laptop B",
      {
        assetType: "laptop",
        serial: "ONLY-A",
        location: "Local",
        condition: "good",
      },
      "b",
    );
    assert.equal(
      (await f.get(`/api/workspace/assets/${asset.id}`, "b")).statusCode,
      404,
    );
    assert.equal(
      (await f.get(`/api/workspace/assets/${foreign.id}`)).statusCode,
      404,
    );
    const reserved = await f.command("assets", "reserve", {
      id: asset.id,
      expectedVersion: asset.version,
      personId: person.id,
      purpose: "Test",
      until: "2099-01-01",
    });
    asset = reserved.entity;
    assert.equal(
      (await f.get(`/api/runs/${reserved.run.id}`, "b")).statusCode,
      404,
    );
    asset = await f.action(asset, "issue", {
      personId: person.id,
      issuedOn: today,
      handoverNote: "Potwierdzenie człowieka",
      humanConfirmed: true,
    });
    asset = await f.action(asset, "return", {
      returnedOn: today,
      condition: "good",
      receiptNote: "Zwrot człowieka",
      humanConfirmed: true,
    });
    assert.equal(asset.status, "available");
    assert.equal((asset.data.handover as JsonObject).confirmedBy, "operator");
    assert.equal(
      (asset.data.returnReceipt as JsonObject).confirmedBy,
      "operator",
    );

    let business = await f.create("cases", "Odbiór biznesowy", {
      caseType: "general",
      brief: "Zakres",
      acceptanceCriteria: "Test",
    });
    assert.equal(
      business.status,
      "open",
      "completed Core write is not accepted business case",
    );
    business = await f.action(business, "addTask", {
      title: "Sprawdzenie",
      kind: "work",
      assigneePrincipalId: "operator",
      required: true,
    });
    business = await f.action(business, "acceptTask", {
      taskId: (business.data.tasks as JsonObject[])[0]!.id!,
      expectedTaskVersion: (business.data.tasks as JsonObject[])[0]!.version!,
      humanConfirmed: true,
    });
    business = await f.action(business, "completeTask", {
      taskId: (business.data.tasks as JsonObject[])[0]!.id!,
      expectedTaskVersion: (business.data.tasks as JsonObject[])[0]!.version!,
      evidenceNote: "Poświadczenie",
      humanConfirmed: true,
    });
    business = await f.action(business, "addEvidence", {
      title: "Protokół",
      reference: "Test",
      note: "Człowiek potwierdza",
      humanConfirmed: true,
    });
    business = await f.action(business, "submit");
    assert.equal(business.status, "awaiting_acceptance");
    business = await f.action(business, "accept", {
      decision: "accepted",
      note: "Odbiór człowieka",
      humanDecision: true,
    });
    assert.equal(business.status, "accepted");
    assert.equal(
      (business.data.currentAcceptance as JsonObject).decidedBy,
      "operator",
    );

    const supplier = await f.create("purchases", "Dostawca", {
      kind: "supplier",
      description: "Test",
    });
    let purchase = await f.create("purchases", "Zamówienie", {
      kind: "order",
      description: "Test",
      supplierId: supplier.id,
      quantity: 1,
    });
    purchase = await f.action(purchase, "placeOrder");
    purchase = await f.action(purchase, "acknowledge", {
      supplierReference: "Test",
      acknowledgedOn: today,
      evidenceNote: "Człowiek",
      humanConfirmed: true,
    });
    purchase = await f.action(purchase, "recordDelivery", {
      quantityReceived: 1,
      receivedOn: today,
      deliveryNote: "Człowiek",
      humanConfirmed: true,
    });
    assert.equal(purchase.status, "received");
    let license = await f.create("licenses", "Licencja", {
      product: "Local",
      totalSeats: 1,
    });
    license = await f.action(license, "assign", {
      personId: person.id,
      note: "Rejestr",
    });
    assert.equal(license.data.provisioning, "local_register_only");
    const client = await f.create("sales", "Klient", {
      kind: "client",
      organizationName: "Test",
    });
    let deal = await f.create("sales", "Szansa", {
      kind: "deal",
      organizationName: "Test",
      parentId: client.id,
    });
    deal = await f.action(deal, "qualify", {
      qualification: "Warunki potwierdzone",
    });
    let offer = await f.create("sales", "Oferta", {
      kind: "offer",
      organizationName: "Test",
      parentId: deal.id,
      scope: "Test",
      value: 100,
    });
    offer = await f.action(offer, "submitOffer");
    offer = await f.action(offer, "acceptOffer", {
      acceptedOn: today,
      acceptanceNote: "Człowiek",
      humanDecision: true,
    });
    offer = await f.action(offer, "handoff", { acceptanceCriteria: "Test" });
    assert.ok(offer.data.deliveryCaseId);
    const candidate = await f.create("people", "Kandydat", {
      personCategory: "contractor",
    });
    const vacancy = await f.create("recruitment", "Wakat", {
      kind: "vacancy",
      employmentKind: "contractor",
      description: "Test",
    });
    let application = await f.create("recruitment", "Aplikacja", {
      kind: "application",
      employmentKind: "contractor",
      description: "Test",
      personId: candidate.id,
      vacancyId: vacancy.id,
    });
    application = await f.action(application, "screen", {
      decision: "advance",
      assessment: "Człowiek",
      humanDecision: true,
    });
    application = await f.action(application, "interview", {
      assessment: "Człowiek",
      humanDecision: true,
    });
    application = await f.action(application, "makeOffer", {
      terms: "Test",
      startDate: "2020-01-01",
    });
    application = await f.action(application, "decide", {
      decision: "accepted",
      reason: "Człowiek",
      humanDecision: true,
    });
    application = await f.action(application, "hire", {
      role: "Test",
      startDate: "2020-01-01",
      humanDecision: true,
    });
    assert.ok(application.data.employmentEpisodeId);
    let doc = await f.create("documents", "Dokument", {
      accessScope: "documents",
      documentType: "policy",
      content: "Test",
    });
    doc = await f.action(doc, "submit");
    doc = await f.action(doc, "approve", {
      decision: "approved",
      note: "Odbiór",
      humanDecision: true,
    });
    assert.equal(doc.status, "approved");
    let incident = await f.create("it", "Incydent", {
      kind: "incident",
      description: "Test",
      severity: "low",
      environment: "lab",
    });
    incident = await f.action(incident, "triage", { assessment: "Test" });
    incident = await f.action(incident, "resolve", {
      resolution: "Test",
      evidenceNote: "Człowiek",
      humanConfirmed: true,
    });
    assert.equal(incident.data.externalActionsPerformed, false);
  } finally {
    await f.close();
  }
});

test("command API rejects unknown fields, tenant spoofing and direct write routes", async () => {
  const f = fixture();
  try {
    assert.equal(
      (
        await f.post("/api/commands", {
          toolId: "ops.people.create",
          input: {
            title: "Spoof",
            data: { personCategory: "internal" },
            tenantId: "b",
          },
          idempotencyKey: "test-spoof",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.post("/api/workspace/people", { title: "Direct mutation" }))
        .statusCode,
      404,
    );
    assert.equal(f.workspace.list(f.config.principals[0]!, "people").length, 0);
  } finally {
    await f.close();
  }
});

test("template preparation retries reuse the frozen draft and require a fresh key for a different source", async () => {
  const f = fixture();
  try {
    const source = await f.create("assets", "Syntetyczny sprzęt", {
      assetType: "laptop",
      serial: "TEMPLATE-ONLY",
      location: "Local",
      condition: "good",
    });
    const payload = {
      templateId: "asset_report",
      sourceId: source.id,
      idempotencyKey: randomUUID(),
    };
    const first = await f.post("/api/document-templates/prepare", payload);
    assert.equal(first.statusCode, 201, first.body);
    const second = await f.post("/api/document-templates/prepare", payload);
    assert.ok([200, 201].includes(second.statusCode), second.body);
    assert.deepEqual(
      second.json().run,
      first.json().run,
      "observedAt is preserved rather than regenerated on retry",
    );
    assert.equal(first.json().run.status, "planned");
    assert.equal(
      f.workspace.list(f.config.principals[0]!, "documents").length,
      0,
      "preparing content never persists a domain document before approval",
    );
    const foreign = await f.post(
      "/api/document-templates/prepare",
      payload,
      "b",
    );
    assert.equal(foreign.statusCode, 404);
    const another = await f.create("assets", "Drugi", {
      assetType: "laptop",
      serial: "TEMPLATE-SECOND",
      location: "Local",
      condition: "good",
    });
    const changed = await f.post("/api/document-templates/prepare", {
      ...payload,
      sourceId: another.id,
    });
    assert.equal(changed.statusCode, 409);
  } finally {
    await f.close();
  }
});
