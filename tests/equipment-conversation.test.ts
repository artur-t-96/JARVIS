import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  AssistantDraftStore,
  conversationAuthority,
  type PreparedProposal,
} from "../src/assistant-drafts.js";
import { ContextBroker } from "../src/context-broker.js";
import {
  DomainError,
  type JsonObject,
  type Principal,
} from "../src/contracts.js";
import {
  advanceEquipment,
  equipmentDate,
} from "../src/equipment-conversation.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";
import { baselineProcessTemplates } from "../src/workspace-models.js";

const principal: Principal = {
  id: "synthetic-manager",
  tenantId: "synthetic-company",
  roles: ["operator", "approver"],
  scopes: ["*"],
};
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
function fixture(
  t: TestContext,
  options: { ttl?: number; parallel?: boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-equipment-conversation-"));
  let now = Date.parse("2026-09-08T23:30:00Z");
  let active = [principal];
  const profile = {
    version: 3,
    definitionVersion: "3",
    timezone: "Europe/Warsaw",
    updatedAt: "2026-09-08T09:00:00Z",
    updatedApprovedBy: principal.id,
    roleBindings: { hr: principal.id, it: principal.id, manager: principal.id },
    processTemplates: baselineProcessTemplates("internal"),
    employmentPolicy: {
      mode: options.parallel
        ? ("parallel_projects" as const)
        : ("single_open" as const),
      maxConcurrent: options.parallel ? 2 : 1,
      allowInternalOverlap: false as const,
    },
  };
  const workspace = new WorkspaceStore(join(dir, "operations.sqlite"), {
    clock: () => now,
  });
  workspace.setPrincipalProvider((tenant) =>
    active.filter((p) => p.tenantId === tenant),
  );
  workspace.setProfileProvider(() => profile);
  const path = join(dir, "assistant.sqlite");
  let db = new DatabaseSync(path);
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,title TEXT NOT NULL,slots_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,authority_hash TEXT NOT NULL);
    CREATE TABLE chat_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,kind TEXT,run_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE chat_requests(conversation_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(conversation_id,request_key));`);
  const id = randomUUID();
  db.prepare(
    "INSERT INTO conversations VALUES(?,?,?,'Nowa rozmowa','{}',?,?,?)",
  ).run(
    id,
    principal.tenantId,
    principal.id,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
    conversationAuthority(principal),
  );
  const stores = () => {
    const drafts = new AssistantDraftStore(db, { clock: () => now });
    drafts.setPrincipalProvider((tenant, actor) =>
      active.find((p) => p.tenantId === tenant && p.id === actor),
    );
    return {
      drafts,
      broker: new ContextBroker(db, workspace, {
        clock: () => now,
        tokenTtlMs: options.ttl ?? 900_000,
        companyProvider: () => profile,
        principalProvider: (tenant) =>
          active.filter((p) => p.tenantId === tenant),
      }),
    };
  };
  let { drafts, broker } = stores();
  let last: PreparedProposal | undefined;
  const message = (text: string, choiceRef?: string) => {
    const draft = drafts.get(principal, id);
    const claim = drafts.claim(principal, id, randomUUID(), {
      message: text,
      ...(choiceRef ? { choiceRef } : {}),
      ...(draft ? { expectedDraftVersion: draft.version } : {}),
    });
    const turn = broker.beginTurn(principal, id, claim.turnId);
    try {
      const proposed = advanceEquipment({
        broker,
        turn,
        claim,
        text,
        choiceRef,
        clock: () => now,
      });
      const prepared = drafts.prepare(claim, proposed);
      drafts.finish(claim, prepared.plan ? randomUUID() : undefined);
      last = prepared;
      return prepared;
    } catch (error) {
      drafts.abandonBeforePlan(claim);
      throw error;
    }
  };
  const choose = (index = 0) => {
    const option = last!.draft.clarification!.options[index]!;
    return message(option.label, option.ref);
  };
  const execute = async (module: string, action: string, input: JsonObject) => {
    const tool = workspace
      .tools()
      .find((tool) => tool.id === `ops.${module}.${action}`)!;
    const prepared = tool.prepareInput?.(input, principal.tenantId) ?? input;
    const result = await tool.execute(
      {
        tenantId: principal.tenantId,
        actorId: principal.id,
        approvedBy: principal.id,
        runId: randomUUID(),
        stepId: "fixture",
        operationKey: randomUUID(),
        signal: new AbortController().signal,
      },
      prepared,
    );
    return workspace.get(principal, module, String(result.data.entityId));
  };
  const create = (module: string, title: string, data: JsonObject) =>
    execute(module, "create", { title, data });
  const person = (title = "Anna Kowalska") =>
    create("people", title, { personCategory: "internal" });
  const start = (person: Entity, project?: Entity) =>
    execute("people", "startEmployment", {
      id: person.id,
      expectedVersion: workspace.get(principal, "people", person.id).version,
      employmentKind: project ? "contractor" : "internal",
      startDate: "2026-09-01",
      role: "Synthetic role",
      humanDecision: true,
      ...(project
        ? { engagementRef: { module: "cases", id: project.id } }
        : {}),
    });
  const asset = (title = "Laptop laboratoryjny") =>
    create("assets", title, {
      assetType: "laptop",
      serial: randomUUID(),
      location: "Lab",
      condition: "good",
    });
  t.after(() => {
    db.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    id,
    workspace,
    profile,
    message,
    choose,
    create,
    person,
    start,
    asset,
    execute,
    get db() {
      return db;
    },
    get drafts() {
      return drafts;
    },
    get last() {
      return last;
    },
    advance(ms: number) {
      now += ms;
    },
    revoke() {
      active = [];
    },
    restart() {
      db.close();
      db = new DatabaseSync(path);
      ({ drafts, broker } = stores());
    },
  };
}

test("explicit local choices, durable dates and real registry build one version-bound plan without reserving", async (t) => {
  const f = fixture(t),
    person = await f.person();
  await f.start(person);
  const asset = await f.asset();
  let p = f.message("Przygotuj Ani laptop na jutro");
  assert.equal(p.draft.clarification?.kind, "person");
  assert.equal(
    p.draft.clarification?.options.length,
    1,
    "one candidate still requires a human selection",
  );
  assert.equal(p.draft.person, undefined);
  assert.equal(
    p.draft.readyOn,
    "2026-09-10",
    "tomorrow is evaluated in company timezone, not UTC",
  );
  assert.equal(p.draft.reservationUntil, undefined);
  p = f.choose();
  assert.equal(p.draft.clarification?.kind, "episode");
  assert.equal(p.draft.episode, undefined);
  f.restart();
  p = f.choose();
  assert.equal(p.draft.clarification?.kind, "reservationUntil");
  assert.equal(p.plan, undefined);
  p = f.message("2026-09-12");
  assert.equal(p.draft.clarification?.kind, "case");
  p = f.choose();
  assert.equal(p.draft.clarification?.kind, "asset");
  assert.equal(
    f.workspace.get(principal, "assets", asset.id).status,
    "available",
  );
  p = f.choose();
  assert.equal(p.kind, "ready");
  assert.equal(p.plan?.steps.length, 1);
  const step = p.plan!.steps[0]!;
  const episode = f.workspace.listEmploymentEpisodes(principal, person.id)[0]!;
  assert.equal(step.toolId, "ops.assets.reserve");
  assert.deepEqual(step.input, {
    id: asset.id,
    expectedVersion: 1,
    personId: person.id,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    caseId: episode.onboardingCaseId,
    profileVersion: 3,
    purpose: "Sprzęt gotowy na 2026-09-10; rezerwacja do 2026-09-12.",
    until: "2026-09-12",
  });
  assert.equal(
    f.workspace.get(principal, "assets", asset.id).status,
    "available",
  );
  assert.equal(f.drafts.get(principal, f.id)!.phase, "planned");
  assert.ok(
    p.draft.sources!.every(
      (source) => source.observedAt && source.version >= 1,
    ),
  );
  const budgets = f.db.prepare("SELECT reads,bytes FROM context_turns").all();
  assert.ok(
    budgets.every(
      (row) => Number(row.reads) <= 4 && Number(row.bytes) <= 24576,
    ),
  );
  const reserved = await f.execute("assets", "reserve", step.input);
  assert.equal(
    reserved.status,
    "reserved",
    "the exact plan is accepted by the closed domain adapter",
  );
});

test("two people and two project periods stay explicit and never select by alias alone", async (t) => {
  const f = fixture(t, { parallel: true }),
    a = await f.person("Anna Kowalska");
  await f.person("Anna Nowak");
  for (const title of ["Projekt A", "Projekt B"]) {
    const project = await f.create("cases", title, {
      caseType: "delivery",
      brief: "Synthetic project",
      acceptanceCriteria: "Human acceptance",
    });
    await f.start(a, project);
  }
  let p = f.message("Laptop dla Ani");
  assert.equal(p.draft.clarification?.options.length, 2);
  assert.equal(p.draft.person, undefined);
  p = f.choose(0);
  assert.equal(p.draft.clarification?.options.length, 2);
  assert.ok(p.draft.clarification!.options[0]!.detail?.includes("Projekt"));
  assert.equal(p.draft.episode, undefined);
  p = f.choose(1);
  assert.equal(p.draft.clarification?.kind, "readyOn");
  assert.equal(p.plan, undefined);
});

test("separate expiry rejects ambiguous and backwards dates without losing ready date", async (t) => {
  const f = fixture(t),
    person = await f.person();
  await f.start(person);
  f.message("Laptop dla Ani");
  f.choose();
  f.choose();
  let p = f.message("jutro");
  assert.equal(p.draft.readyOn, "2026-09-10");
  assert.equal(p.draft.reservationUntil, undefined);
  p = f.message("2026-09-09");
  assert.equal(p.draft.clarification?.kind, "reservationUntil");
  assert.equal(p.draft.readyOn, "2026-09-10");
  assert.equal(p.draft.reservationUntil, undefined);
  p = f.message("2026-09-11 lub 2026-09-12");
  assert.equal(p.draft.reservationUntil, undefined);
  p = f.message("2026-09-12");
  assert.equal(p.draft.clarification?.kind, "case");
});

test("unknown optional type and dates stay absent through real draft prepare and finish", async (t) => {
  for (const initial of [
    "Przygotuj sprzęt dla Ani",
    "Przygotuj sprzęt dla Ani na kiedyś",
  ]) {
    const f = fixture(t),
      person = await f.person();
    await f.start(person);
    let p = f.message(initial);
    assert.equal(p.draft.clarification?.kind, "person");
    for (const field of ["assetType", "readyOn", "reservationUntil"])
      assert.equal(
        Object.hasOwn(p.draft, field),
        false,
        `${field} must be absent, not undefined`,
      );
    f.choose();
    p = f.choose();
    assert.equal(p.draft.clarification?.kind, "assetType");
    assert.equal(Object.hasOwn(p.draft, "assetType"), false);
    p = f.message("Jeszcze nie wiem");
    assert.equal(p.draft.clarification?.kind, "assetType");
    assert.equal(Object.hasOwn(p.draft, "assetType"), false);
    p = f.message("laptop");
    assert.equal(p.draft.assetType, "laptop");
    assert.equal(p.draft.clarification?.kind, "readyOn");
    assert.equal(Object.hasOwn(p.draft, "readyOn"), false);
    p = f.message("kiedyś");
    assert.equal(p.draft.clarification?.kind, "readyOn");
    assert.equal(Object.hasOwn(p.draft, "readyOn"), false);
    p = f.message("jutro");
    assert.equal(p.draft.clarification?.kind, "reservationUntil");
    assert.equal(Object.hasOwn(p.draft, "reservationUntil"), false);
    p = f.message("nie znam jeszcze terminu");
    assert.equal(Object.hasOwn(p.draft, "reservationUntil"), false);
    assert.equal(f.drafts.get(principal, f.id)!.version, 8);
    assert.equal(p.plan, undefined);
  }
});

test("missing episode, case and equipment stop with actionable human work, not invented records", async (t) => {
  const noEpisode = fixture(t);
  await noEpisode.person();
  noEpisode.message("Laptop dla Ani");
  let p = noEpisode.choose();
  assert.equal(p.draft.phase, "blocked");
  assert.equal(p.draft.missingFields[0], "episode");
  assert.match(p.message, /HR/);
  assert.equal(p.plan, undefined);
  const noCase = fixture(t),
    person = await noCase.person();
  await noCase.start(person);
  const episode = noCase.workspace.listEmploymentEpisodes(
    principal,
    person.id,
  )[0]!;
  const record = noCase.workspace.get(
    principal,
    "cases",
    episode.onboardingCaseId!,
  );
  await noCase.execute("cases", "cancel", {
    id: record.id,
    expectedVersion: record.version,
    reason: "Synthetic fixture",
  });
  noCase.message("Laptop dla Ani na jutro");
  noCase.choose();
  noCase.choose();
  p = noCase.message("2026-09-12");
  assert.equal(p.draft.missingFields[0], "case");
  assert.equal(p.plan, undefined);
  assert.match(p.message, /Sprawach/);
  const noAsset = fixture(t),
    other = await noAsset.person();
  await noAsset.start(other);
  noAsset.message("Laptop dla Ani na jutro");
  noAsset.choose();
  noAsset.choose();
  noAsset.message("2026-09-12");
  p = noAsset.choose();
  assert.equal(p.draft.missingFields[0], "asset");
  assert.equal(p.plan, undefined);
  assert.match(p.message, /zakupowe/);
});

test("changed or expired candidates require another explicit choice and never retarget silently", async (t) => {
  const f = fixture(t),
    person = await f.person();
  await f.start(person);
  const asset = await f.asset();
  f.message("Laptop dla Ani na jutro");
  f.choose();
  f.choose();
  f.message("2026-09-12");
  f.choose();
  const staleRef = f.last!.draft.clarification!.options[0]!.ref;
  const episode = f.workspace.listEmploymentEpisodes(principal, person.id)[0]!;
  await f.execute("assets", "reserve", {
    id: asset.id,
    expectedVersion: asset.version,
    personId: person.id,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    caseId: episode.onboardingCaseId!,
    until: "2026-09-12",
    purpose: "Another approved reservation",
  });
  const p = f.choose();
  assert.equal(p.plan, undefined);
  assert.equal(p.draft.phase, "blocked");
  assert.equal(p.draft.asset, undefined);
  assert.equal(p.draft.missingFields[0], "asset");
  assert.equal(JSON.stringify(p.draft).includes(staleRef), false);
  const expired = fixture(t, { ttl: 1000 });
  await expired.person();
  expired.message("Laptop dla Ani");
  expired.advance(1001);
  const q = expired.choose();
  assert.equal(q.plan, undefined);
  assert.equal(q.draft.person, undefined);
  assert.match(q.message, /Profil/);
  const refreshed = expired.message("Anna");
  assert.equal(refreshed.draft.clarification?.kind, "person");
  assert.equal(refreshed.draft.person, undefined);
});

test("forged choice and revoked authority fail closed; confirmed profile is mandatory", async (t) => {
  const f = fixture(t);
  await f.person();
  f.message("Laptop dla Ani");
  assert.throws(
    () => f.message("Anna Kowalska", `ctx_${"a".repeat(32)}`),
    code("INVALID_CHOICE"),
  );
  f.revoke();
  assert.throws(
    () => f.choose(),
    (error) => error instanceof DomainError && error.statusCode === 403,
  );
  const unconfirmed = fixture(t);
  unconfirmed.profile.updatedApprovedBy = "";
  const p = unconfirmed.message("Laptop dla Ani");
  assert.equal(p.draft.missingFields[0], "company");
  assert.equal(p.plan, undefined);
});

test("relative date parsing follows local midnight and DST, rejecting impossible dates", () => {
  assert.equal(
    equipmentDate("dziś", "Europe/Warsaw", Date.parse("2026-09-08T23:30:00Z")),
    "2026-09-09",
  );
  assert.equal(
    equipmentDate("jutro", "Europe/Warsaw", Date.parse("2026-10-24T22:30:00Z")),
    "2026-10-26",
  );
  assert.equal(
    equipmentDate(
      "pojutrze",
      "America/New_York",
      Date.parse("2026-03-08T04:30:00Z"),
    ),
    "2026-03-09",
  );
  assert.equal(
    equipmentDate("2026-02-30", "Europe/Warsaw", Date.now()),
    undefined,
  );
  assert.equal(
    equipmentDate("dziś albo jutro", "Europe/Warsaw", Date.now()),
    undefined,
  );
});

test("all seven people, project periods and case candidates are reachable with private bound cursors", async (t) => {
  const f = fixture(t, { parallel: true });
  f.profile.employmentPolicy.maxConcurrent = 20;
  const people: Entity[] = [];
  for (const name of [
    "Anna A",
    "Anna B",
    "Anna C",
    "Anna D",
    "Anna E",
    "Anna F",
    "Anna G",
  ])
    people.push(await f.person(name));
  const selected = people[6]!;
  for (let i = 0; i < 7; i++) {
    const project = await f.create("cases", `Przedsięwzięcie ${i}`, {
      caseType: "delivery",
      brief: "Synthetic project",
      acceptanceCriteria: "Human acceptance",
    });
    await f.start(selected, project);
  }
  let p = f.message("Laptop dla Ani na jutro");
  assert.equal(p.draft.clarification!.options.length, 5);
  assert.equal(p.draft.clarification!.hasNextPage, true);
  const cursor = (
    (f.drafts.getState(principal, f.id).equipment as JsonObject)
      .page as JsonObject
  ).cursor;
  assert.equal(typeof cursor, "string");
  assert.equal(JSON.stringify(p.draft).includes(String(cursor)), false);
  assert.throws(
    () => f.message("Pokaż kolejne", String(cursor)),
    code("INVALID_CHOICE"),
  );
  f.restart();
  p = f.message("Pokaż kolejne");
  assert.deepEqual(
    p.draft.clarification!.options.map((o) => o.label),
    ["Anna F", "Anna G"],
  );
  assert.equal(p.draft.clarification!.hasNextPage, undefined);
  p = f.choose(1);
  assert.equal(p.draft.person!.label, "Anna G");
  assert.equal(p.draft.clarification!.kind, "episode");
  const firstEpisodes = p.draft.clarification!.options.map((o) => o.detail);
  assert.equal(firstEpisodes.length, 5);
  p = f.message("Pokaż kolejne");
  assert.equal(p.draft.clarification!.options.length, 2);
  assert.ok(
    p.draft.clarification!.options.every(
      (o) => !firstEpisodes.includes(o.detail),
    ),
  );
  p = f.choose(1);
  const privateRecords = (
    f.drafts.getState(principal, f.id).equipment as JsonObject
  ).records as JsonObject;
  const episodeId = (
    (privateRecords.episode as JsonObject).source as JsonObject
  ).id;
  for (let i = 0; i < 6; i++)
    await f.create("cases", `Powiązana sprawa ${i}`, {
      caseType: "general",
      brief: "Synthetic scope",
      acceptanceCriteria: "Human acceptance",
      personId: selected.id,
      employmentEpisodeId: episodeId!,
    });
  p = f.message("2026-09-12");
  assert.equal(p.draft.clarification!.kind, "case");
  assert.equal(p.draft.clarification!.options.length, 5);
  const firstCases = p.draft.clarification!.options.map((o) => o.label);
  p = f.message("Pokaż kolejne");
  assert.equal(p.draft.clarification!.options.length, 2);
  assert.ok(
    p.draft.clarification!.options.every((o) => !firstCases.includes(o.label)),
  );
  p = f.choose(1);
  assert.equal(p.draft.missingFields[0], "asset");
  assert.equal(p.plan, undefined);
  assert.throws(
    () => f.message("Pokaż kolejne"),
    code("CONTEXT_PAGE_UNAVAILABLE"),
  );
  assert.ok(
    f.db
      .prepare("SELECT reads FROM context_turns")
      .all()
      .every((row) => Number(row.reads) <= 4),
  );
});

test("a collection changed between pages restarts an explicit selection rather than skipping or choosing a candidate", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++)
    await f.person(`Anna ${String.fromCharCode(65 + i)}`);
  f.message("Laptop dla Ani");
  await f.person("Anna Aaa");
  const p = f.message("Pokaż kolejne");
  assert.match(p.message, /Lista zmieniła/);
  assert.equal(p.draft.clarification?.hasNextPage, true);
  assert.equal(p.draft.person, undefined);
  assert.equal(p.plan, undefined);
});
