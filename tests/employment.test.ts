import { custodyPins } from "./helpers/custody-pins.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "../src/contracts.js";
import {
  WorkspaceStore,
  type Entity,
  type EmploymentEpisode,
} from "../src/workspace.js";
import { InitiativeStore } from "../src/initiative.js";
import { Engine } from "../src/engine.js";
import {
  defaultEmploymentPolicy,
  type EmploymentPolicy,
} from "../src/workspace-models.js";

const now = "2026-09-08T10:00:00.000Z";
const principal: Principal = {
  id: "operator",
  tenantId: "synthetic",
  roles: ["operator", "approver"],
  scopes: ["*"],
};
const ctx = (): ToolContext => ({
  tenantId: principal.tenantId,
  actorId: principal.id,
  approvedBy: "independent-approver",
  operationKey: randomUUID(),
  runId: randomUUID(),
  stepId: randomUUID(),
  signal: new AbortController().signal,
});
const episodeInput = (episode: EmploymentEpisode): JsonObject => ({
  employmentEpisodeId: episode.id,
  expectedEpisodeVersion: episode.version,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-employment-")),
    path = join(directory, "workspace.db");
  const workspace = new WorkspaceStore(path, { clock: () => Date.parse(now) });
  workspace.setPrincipalProvider(() => [principal]);
  const initiatives = new InitiativeStore(
    join(directory, "profile.db"),
    workspace,
    { clock: () => Date.parse(now) },
  );
  workspace.setProfileProvider((tenant) =>
    initiatives.profileForTenant(tenant),
  );
  t.after(() => {
    initiatives.close();
    workspace.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const tool = (module: string, action: string) =>
    workspace.tools().find((tool) => tool.id === `ops.${module}.${action}`)!;
  const execute = async (
    module: string,
    action: string,
    input: JsonObject,
    context = ctx(),
  ) => {
    if (module === "assets")
      input = custodyPins(workspace, principal, action, input);
    const adapter = tool(module, action),
      prepared = adapter.prepareInput?.(input, principal.tenantId) ?? input;
    const result = await adapter.execute(context, prepared);
    assert.equal((await adapter.verify(context, prepared, result)).ok, true);
    return workspace.get(principal, module, String(result.data.entityId));
  };
  const get = (module: string, id: string) =>
    workspace.get(principal, module, id);
  const create = (module: string, title: string, data: JsonObject) =>
    execute(module, "create", { title, data });
  const action = (entity: Entity, action: string, input: JsonObject = {}) =>
    execute(entity.module, action, {
      id: entity.id,
      expectedVersion: entity.version,
      ...input,
    });
  const episodes = (person: Entity) =>
    workspace.listEmploymentEpisodes(principal, person.id);
  const configure = async (policy: EmploymentPolicy) => {
    const p = initiatives.profile(principal);
    const input = {
      companyName: p.companyName,
      timezone: p.timezone,
      licenseReminderDays: p.licenseReminderDays,
      quietHours: p.quietHours,
      rules: p.rules,
      roleBindings: {
        hr: principal.id,
        it: principal.id,
        manager: principal.id,
      },
      processTemplates: p.processTemplates,
      employmentPolicy: policy,
      expectedVersion: p.version,
    } as unknown as JsonObject;
    const adapter = initiatives
        .tools()
        .find((tool) => tool.id === "initiatives.configure")!,
      context = ctx();
    const result = await adapter.execute(context, input);
    assert.equal((await adapter.verify(context, input, result)).ok, true);
    return initiatives.profile(principal);
  };
  const project = (name = "Project") =>
    create("cases", name, {
      caseType: "delivery",
      brief: "Agreed local delivery scope",
      acceptanceCriteria: "Explicit human acceptance",
    });
  const start = async (person: Entity, project?: Entity, kind = "contractor") =>
    action(get("people", person.id), "startEmployment", {
      employmentKind: kind,
      startDate: "2026-09-01",
      role: "Synthetic role",
      humanDecision: true,
      ...(project
        ? { engagementRef: { module: project.module, id: project.id } }
        : {}),
    });
  const acceptCase = async (id: string) => {
    let record = get("cases", id);
    for (const initial of record.data.tasks as JsonObject[]) {
      let task = (record.data.tasks as JsonObject[]).find(
        (task) => task.id === initial.id,
      )!;
      if (task.status === "unassigned") {
        record = await action(record, "transferTask", {
          taskId: task.id!,
          expectedTaskVersion: task.version!,
          assigneePrincipalId: principal.id,
          humanConfirmed: true,
          reason: "Explicit worker assignment",
        });
        task = (record.data.tasks as JsonObject[]).find(
          (task) => task.id === initial.id,
        )!;
      }
      record = await action(record, "acceptTask", {
        taskId: task.id!,
        expectedTaskVersion: task.version!,
        humanConfirmed: true,
      });
      task = (record.data.tasks as JsonObject[]).find(
        (task) => task.id === initial.id,
      )!;
      record = await action(record, "completeTask", {
        taskId: task.id!,
        expectedTaskVersion: task.version!,
        humanConfirmed: true,
        evidenceNote: "Synthetic completed offboarding work",
      });
    }
    record = await action(record, "addEvidence", {
      title: "Offboarding record",
      reference: "synthetic",
      note: "Explicit scope completion report",
      humanConfirmed: true,
    });
    record = await action(record, "submit");
    return action(record, "accept", {
      decision: "accepted",
      note: "Current scope accepted",
      humanDecision: true,
    });
  };
  return {
    directory,
    path,
    workspace,
    initiatives,
    tool,
    execute,
    get,
    create,
    action,
    episodes,
    configure,
    project,
    start,
    acceptCase,
  };
}
const parallel: EmploymentPolicy = {
  mode: "parallel_projects",
  maxConcurrent: 2,
  allowInternalOverlap: false,
};

test("default and historical profiles permit one period; episode identity/version are mandatory and category is historical", async (t) => {
  const h = fixture(t),
    person = await h.create("people", "Synthetic worker", {
      personCategory: "internal",
    });
  const started = await h.start(person);
  assert.equal(started.data.personCategory, "internal");
  assert.equal(h.episodes(person)[0]!.kind, "contractor");
  assert.equal(h.episodes(person)[0]!.version, 1);
  await assert.rejects(h.start(started), code("EMPLOYMENT_LIMIT"));
  const old = {
    ...h.initiatives.profile(principal),
    definitionVersion: "2",
    employmentPolicy: parallel,
  };
  h.workspace.setProfileProvider(() => old);
  await assert.rejects(
    h.start(started, await h.project()),
    code("EMPLOYMENT_LIMIT"),
  );
  const episode = h.episodes(person)[0]!;
  await assert.rejects(
    h.tool("people", "beginOffboarding").execute(ctx(), {
      id: person.id,
      expectedVersion: started.version,
      endDate: "2026-09-08",
      reason: "No implicit episode choice",
      humanDecision: true,
    }),
    code("INVALID_DOMAIN_INPUT"),
  );
  await assert.rejects(
    h.action(started, "beginOffboarding", {
      ...episodeInput(episode),
      expectedEpisodeVersion: 9,
      endDate: "2026-09-08",
      reason: "Stale episode",
      humanDecision: true,
    }),
    code("EPISODE_VERSION_CONFLICT"),
  );
  const foreign = await h.create("people", "Another person", {
    personCategory: "contractor",
  });
  await assert.rejects(
    h.action(foreign, "beginOffboarding", {
      ...episodeInput(episode),
      endDate: "2026-09-08",
      reason: "Wrong person",
      humanDecision: true,
    }),
    code("EMPLOYMENT_REQUIRED"),
  );
  assert.throws(
    () =>
      h.workspace.listEmploymentEpisodes(
        { ...principal, tenantId: "foreign" },
        person.id,
      ),
    code("ENTITY_NOT_FOUND"),
  );
});

test("approved parallel policy allows two agreed distinct projects, denies duplicate/draft/internal overlap and preserves periods on downgrade", async (t) => {
  const h = fixture(t),
    profile = await h.configure(parallel);
  assert.equal(profile.definitionVersion, "3");
  assert.equal(profile.updatedApprovedBy, "independent-approver");
  const person = await h.create("people", "Synthetic consultant", {
    personCategory: "contractor",
  });
  const a = await h.project("Project A"),
    b = await h.project("Project B");
  await assert.rejects(h.start(person), code("ENGAGEMENT_REQUIRED"));
  const client = await h.create("sales", "Client", {
    kind: "client",
    organizationName: "Synthetic client",
  });
  const draft = await h.create("sales", "Draft deal", {
    kind: "deal",
    organizationName: "Synthetic client",
    parentId: client.id,
  });
  await assert.rejects(h.start(person, draft), code("ENGAGEMENT_NOT_AGREED"));
  await h.start(person, a);
  await assert.rejects(h.start(person, a), code("DUPLICATE_ENGAGEMENT"));
  await assert.rejects(
    h.start(person, b, "internal"),
    code("INTERNAL_EMPLOYMENT_OVERLAP"),
  );
  const both = await h.start(person, b),
    before = h.episodes(person);
  assert.equal(before.length, 2);
  assert.equal(both.data.currentEmploymentEpisodeId, null);
  assert.equal(both.data.onboardingCaseId, null);
  assert.equal(
    before.every(
      (episode) => episode.status === "onboarding" && episode.onboardingCaseId,
    ),
    true,
  );
  assert.notEqual(before[0]!.onboardingCaseId, before[1]!.onboardingCaseId);
  await assert.rejects(
    h.start(person, await h.project("Third")),
    code("EMPLOYMENT_LIMIT"),
  );
  const futureProject = await h.project("Future plan");
  const staleInput = h.tool("people", "startEmployment").prepareInput!(
    {
      id: person.id,
      expectedVersion: both.version,
      employmentKind: "contractor",
      startDate: "2026-09-02",
      role: "Old policy plan",
      engagementRef: { module: "cases", id: futureProject.id },
      humanDecision: true,
    },
    principal.tenantId,
  );
  await h.configure(defaultEmploymentPolicy);
  assert.deepEqual(h.episodes(person), before);
  await assert.rejects(
    h.tool("people", "startEmployment").execute(ctx(), staleInput),
    code("PROFILE_CHANGED"),
  );
  await assert.rejects(
    h.start(person, await h.project("Denied after downgrade")),
    code("EMPLOYMENT_LIMIT"),
  );
});

test("offboarding A cannot issue, revoke, close or mutate period B and its resources", async (t) => {
  const h = fixture(t);
  await h.configure(parallel);
  let person = await h.create("people", "Two-project consultant", {
    personCategory: "contractor",
  });
  const projectA = await h.project("A"),
    projectB = await h.project("B");
  person = await h.start(person, projectA);
  const a = h.episodes(person)[0]!;
  person = await h.start(person, projectB);
  const b = h.episodes(person).find((episode) => episode.id !== a.id)!;
  let asset = await h.create("assets", "B laptop", {
    assetType: "laptop",
    serial: randomUUID(),
    location: "Test",
    condition: "good",
  });
  asset = await h.action(asset, "reserve", {
    personId: person.id,
    ...episodeInput(b),
    caseId: b.onboardingCaseId!,
    purpose: "Project B",
    until: "2026-09-10",
  });
  await assert.rejects(
    h.action(asset, "issue", {
      personId: person.id,
      ...episodeInput(a),
      issuedOn: "2026-09-08",
      handoverNote: "Wrong episode",
      humanConfirmed: true,
    }),
    code("RESOURCE_EPISODE_MISMATCH"),
  );
  asset = await h.action(asset, "issue", {
    personId: person.id,
    ...episodeInput(b),
    caseId: b.onboardingCaseId!,
    issuedOn: "2026-09-08",
    handoverNote: "Actual synthetic B handover",
    humanConfirmed: true,
  });
  let license = await h.create("licenses", "Per-project seats", {
    product: "Synthetic license",
    totalSeats: 2,
  });
  license = await h.action(license, "assign", {
    personId: person.id,
    ...episodeInput(b),
    caseId: b.onboardingCaseId!,
    note: "B seat",
  });
  await assert.rejects(
    h.action(license, "revoke", {
      personId: person.id,
      ...episodeInput(a),
      reason: "A cannot revoke B",
    }),
    code("SEAT_NOT_ASSIGNED"),
  );
  person = await h.action(h.get("people", person.id), "beginOffboarding", {
    ...episodeInput(a),
    endDate: "2026-09-08",
    reason: "Only A ends",
    humanDecision: true,
  });
  const endingA = h.episodes(person).find((episode) => episode.id === a.id)!;
  assert.equal(endingA.version, 2);
  assert.equal(h.get("cases", a.onboardingCaseId!).status, "cancelled");
  assert.equal(h.get("cases", b.onboardingCaseId!).status, "open");
  await h.acceptCase(endingA.offboardingCaseId!);
  await assert.rejects(
    h.action(h.get("people", person.id), "endEmployment", {
      ...episodeInput(endingA),
      endDate: "2026-09-07",
      reason: "Cannot silently change accepted date",
      humanDecision: true,
    }),
    code("EXIT_DATE_CHANGED"),
  );
  person = await h.action(h.get("people", person.id), "endEmployment", {
    ...episodeInput(endingA),
    endDate: "2026-09-08",
    reason: "A accepted and settled",
    humanDecision: true,
  });
  const after = h.episodes(person);
  assert.equal(after.find((episode) => episode.id === a.id)!.status, "ended");
  assert.equal(after.find((episode) => episode.id === a.id)!.version, 3);
  assert.deepEqual(
    after.find((episode) => episode.id === b.id),
    b,
  );
  assert.equal(person.status, "onboarding");
  assert.equal(person.data.currentEmploymentEpisodeId, b.id);
  assert.deepEqual(h.get("assets", asset.id), asset);
  assert.deepEqual(h.get("licenses", license.id), license);
});

test("offer, won deal and its delivery case identify one engagement rather than three projects", async (t) => {
  const h = fixture(t);
  await h.configure(parallel);
  const person = await h.create("people", "Canonical engagement", {
    personCategory: "contractor",
  });
  const client = await h.create("sales", "Synthetic client", {
    kind: "client",
    organizationName: "Test",
  });
  let deal = await h.create("sales", "Deal", {
    kind: "deal",
    organizationName: "Test",
    parentId: client.id,
  });
  deal = await h.action(deal, "qualify", { qualification: "Agreed test need" });
  let offer = await h.create("sales", "Offer", {
    kind: "offer",
    organizationName: "Test",
    parentId: deal.id,
    value: 1,
    currency: "PLN",
    scope: "Agreed test service",
  });
  offer = await h.action(offer, "submitOffer");
  offer = await h.action(offer, "acceptOffer", {
    acceptedOn: "2026-09-08",
    acceptanceNote: "Explicit business acceptance",
    humanDecision: true,
  });
  offer = await h.action(offer, "handoff", {
    acceptanceCriteria: "Deliver agreed scope",
  });
  await h.start(person, offer);
  await assert.rejects(
    h.start(person, h.get("sales", deal.id)),
    code("DUPLICATE_ENGAGEMENT"),
  );
  await assert.rejects(
    h.start(person, h.get("cases", String(offer.data.deliveryCaseId))),
    code("DUPLICATE_ENGAGEMENT"),
  );
  assert.equal(h.episodes(person).length, 1);
});

test("independent verification reads actual episode and allocation rows, not only their entity mirror", async (t) => {
  const h = fixture(t),
    person = await h.create("people", "Independent source verification", {
      personCategory: "contractor",
    });
  const startTool = h.tool("people", "startEmployment"),
    startContext = ctx();
  const input = startTool.prepareInput!(
    {
      id: person.id,
      expectedVersion: person.version,
      employmentKind: "contractor",
      startDate: "2026-09-01",
      role: "Test",
      humanDecision: true,
    },
    principal.tenantId,
  );
  const receipt = await startTool.execute(startContext, input);
  const episode = h.episodes(person)[0]!,
    db = new DatabaseSync(h.path);
  try {
    assert.equal(
      (await startTool.verify(startContext, input, receipt)).ok,
      true,
    );
    db.prepare("UPDATE ops_employment SET version=version+1 WHERE id=?").run(
      episode.id,
    );
    assert.equal(
      (await startTool.verify(startContext, input, receipt)).ok,
      false,
    );
    db.prepare("UPDATE ops_employment SET version=version-1 WHERE id=?").run(
      episode.id,
    );
    const asset = await h.create("assets", "Independent allocation", {
      assetType: "laptop",
      serial: randomUUID(),
      location: "Test",
      condition: "good",
    });
    const reserve = h.tool("assets", "reserve"),
      reserveContext = ctx();
    const reserveInput = reserve.prepareInput!(
      {
        id: asset.id,
        expectedVersion: asset.version,
        personId: person.id,
        ...episodeInput(episode),
        caseId: episode.onboardingCaseId!,
        purpose: "Explicit allocation",
        until: "2026-09-09",
      },
      principal.tenantId,
    );
    const result = await reserve.execute(reserveContext, reserveInput);
    assert.equal(
      (await reserve.verify(reserveContext, reserveInput, result)).ok,
      true,
    );
    db.prepare(
      "UPDATE ops_allocations SET employment_episode_id=NULL WHERE asset_id=?",
    ).run(asset.id);
    assert.equal(
      (await reserve.verify(reserveContext, reserveInput, result)).ok,
      false,
    );
  } finally {
    db.close();
  }
});

test("v3 migration pins only unambiguous lifecycle cases and preserves unresolved resource links", () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-episode-migration-")),
    path = join(directory, "workspace.db");
  new WorkspaceStore(path).close();
  let db = new DatabaseSync(path);
  db.exec(
    "DROP TABLE ops_asset_register_events; DROP TABLE ops_asset_events; ALTER TABLE ops_tasks DROP COLUMN template_key; DELETE FROM schema_versions_operations WHERE version>=5",
  );
  for (const column of [
    "version",
    "expires_at",
    "timezone",
    "profile_version",
    "created_at",
    "updated_at",
    "provenance",
    "issue_event_id",
    "return_event_id",
    "last_event_id",
  ])
    db.exec(`ALTER TABLE ops_allocations DROP COLUMN ${column}`);
  db.exec(
    "DROP INDEX ops_one_open_engagement; DROP INDEX ops_one_open_internal; DROP INDEX ops_unique_episode_seat; DROP INDEX ops_unique_legacy_seat; CREATE UNIQUE INDEX ops_one_open_employment ON ops_employment(tenant_id,person_id) WHERE status!='ended'; CREATE UNIQUE INDEX ops_unique_seat ON ops_license_seats(tenant_id,license_id,person_id) WHERE status='assigned'; DELETE FROM schema_versions_operations WHERE version=4;",
  );
  for (const column of [
    "version",
    "onboarding_case_id",
    "offboarding_case_id",
    "engagement_module",
    "engagement_id",
    "engagement_key",
    "end_reason",
    "updated_at",
  ])
    db.exec(`ALTER TABLE ops_employment DROP COLUMN ${column}`);
  const first = randomUUID(),
    second = randomUUID(),
    firstEpisode = randomUUID(),
    secondEpisode = randomUUID(),
    firstCase = randomUUID(),
    license = randomUUID();
  const insert = db.prepare(
    "INSERT INTO ops_entities VALUES(?,?,?,?,?,?,?,?,?)",
  );
  const historical = JSON.stringify({
    personCategory: "contractor",
    currentEmploymentEpisodeId: firstEpisode,
    onboardingCaseId: firstCase,
    employmentEpisodes: [
      { id: firstEpisode, kind: "contractor", status: "onboarding" },
    ],
  });
  insert.run(
    principal.tenantId,
    first,
    "people",
    "Legacy unique case",
    "onboarding",
    2,
    historical,
    now,
    now,
  );
  insert.run(
    principal.tenantId,
    second,
    "people",
    "Legacy ambiguous case",
    "onboarding",
    2,
    JSON.stringify({ personCategory: "contractor" }),
    now,
    now,
  );
  for (const [personId, episodeId] of [
    [first, firstEpisode],
    [second, secondEpisode],
  ])
    db.prepare(
      "INSERT INTO ops_employment VALUES(?,?,?,?,?,NULL,'onboarding',?)",
    ).run(
      principal.tenantId,
      episodeId!,
      personId!,
      "contractor",
      "2026-09-01",
      "Legacy role",
    );
  for (const [personId, episodeId, caseId] of [
    [first, firstEpisode, firstCase],
    [second, secondEpisode, randomUUID()],
    [second, secondEpisode, randomUUID()],
  ])
    insert.run(
      principal.tenantId,
      caseId!,
      "cases",
      "Legacy onboarding",
      "open",
      1,
      JSON.stringify({
        caseType: "onboarding",
        personId,
        employmentEpisodeId: episodeId,
        scopeRevision: 1,
      }),
      now,
      now,
    );
  insert.run(
    principal.tenantId,
    license,
    "licenses",
    "Legacy seat",
    "active",
    1,
    JSON.stringify({ product: "Legacy", totalSeats: 1 }),
    now,
    now,
  );
  db.prepare(
    "INSERT INTO ops_license_seats VALUES(?,?,?,?,'assigned',?,NULL,NULL,NULL)",
  ).run(principal.tenantId, randomUUID(), license, first, now);
  // Force a late failure after additive columns and index removal. Everything
  // must roll back, leaving the usable v3 schema intact.
  db.exec("CREATE INDEX ops_one_open_engagement ON ops_employment(role)");
  assert.throws(
    () => new WorkspaceStore(path),
    /ops_one_open_engagement already exists/,
  );
  assert.equal(
    db
      .prepare("SELECT max(version) AS n FROM schema_versions_operations")
      .get()!.n,
    3,
  );
  assert.equal(
    db
      .prepare(
        "SELECT name FROM pragma_table_info('ops_employment') WHERE name='version'",
      )
      .get(),
    undefined,
  );
  assert.ok(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='ops_one_open_employment'",
      )
      .get(),
  );
  db.exec("DROP INDEX ops_one_open_engagement");
  db.close();
  const store = new WorkspaceStore(path);
  try {
    const a = store.listEmploymentEpisodes(principal, first)[0]!,
      b = store.listEmploymentEpisodes(principal, second)[0]!;
    assert.equal(a.version, 1);
    assert.equal(a.onboardingCaseId, firstCase);
    assert.equal(a.engagementRef, null);
    assert.equal(b.onboardingCaseId, null);
    db = new DatabaseSync(path);
    assert.equal(
      db.prepare("SELECT data_json FROM ops_entities WHERE id=?").get(first)!
        .data_json,
      historical,
    );
    assert.equal(
      db
        .prepare(
          "SELECT employment_episode_id FROM ops_license_seats WHERE license_id=?",
        )
        .get(license)!.employment_episode_id,
      null,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      db
        .prepare("SELECT max(version) AS n FROM schema_versions_operations")
        .get()!.n,
      7,
    );
  } finally {
    db.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy NULL resource ownership blocks parallel start and closing, never matches an explicit revoke", async (t) => {
  const h = fixture(t);
  await h.configure(parallel);
  let person = await h.create("people", "Legacy unresolved resources", {
    personCategory: "contractor",
  });
  person = await h.start(person, await h.project("Existing project"));
  const a = h.episodes(person)[0]!;
  const license = await h.create("licenses", "Legacy seat", {
    product: "Historical license",
    totalSeats: 1,
  });
  const db = new DatabaseSync(h.path);
  try {
    db.prepare(
      "INSERT INTO ops_license_seats(tenant_id,id,license_id,person_id,status,assigned_at,revoked_at,employment_episode_id,case_id) VALUES(?,?,?,?,'assigned',?,NULL,NULL,NULL)",
    ).run(principal.tenantId, randomUUID(), license.id, person.id, now);
    await assert.rejects(
      h.start(person, await h.project("New project")),
      code("LEGACY_EMPLOYMENT_UNRESOLVED"),
    );
    await assert.rejects(
      h.action(license, "revoke", {
        personId: person.id,
        ...episodeInput(a),
        reason: "No guessed ownership",
      }),
      code("SEAT_NOT_ASSIGNED"),
    );
    person = await h.action(person, "beginOffboarding", {
      ...episodeInput(a),
      endDate: "2026-09-08",
      reason: "End explicit episode",
      humanDecision: true,
    });
    const ending = h.episodes(person)[0]!;
    await h.acceptCase(ending.offboardingCaseId!);
    await assert.rejects(
      h.action(person, "endEmployment", {
        ...episodeInput(ending),
        endDate: "2026-09-08",
        reason: "Unresolved resources remain",
        humanDecision: true,
      }),
      code("LEGACY_RESOURCES_UNRESOLVED"),
    );
    assert.equal(
      db
        .prepare(
          "SELECT employment_episode_id FROM ops_license_seats WHERE license_id=?",
        )
        .get(license.id)!.employment_episode_id,
      null,
    );
    assert.equal(h.episodes(person)[0]!.status, "offboarding");
  } finally {
    db.close();
  }
});

test("two native processes race for the last permitted period and commit only one new engagement", async (t) => {
  const h = fixture(t);
  await h.configure(parallel);
  let person = await h.create("people", "Race subject", {
    personCategory: "contractor",
  });
  person = await h.start(person, await h.project("First"));
  const candidates = [await h.project("Second"), await h.project("Third")];
  const code = `import { once } from 'node:events'; import { WorkspaceStore } from ${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).href)};
    const c=JSON.parse(process.argv.at(-1)); const s=new WorkspaceStore(c.path); s.setPrincipalProvider(()=>[c.principal]); s.setProfileProvider(()=>c.profile);
    const t=s.tools().find(t=>t.id==='ops.people.startEmployment'); process.stdout.write('ready\\n'); await once(process.stdin,'data');
    try { await t.execute({...c.context,signal:new AbortController().signal}, c.input); process.stdout.write(JSON.stringify({ok:true})+'\\n'); }
    catch(e) { process.stdout.write(JSON.stringify({ok:false,code:e.code})+'\\n'); } finally {s.close(); process.stdin.destroy();}`;
  const children = candidates.map((project) => {
    const input = h.tool("people", "startEmployment").prepareInput!(
      {
        id: person.id,
        expectedVersion: person.version,
        employmentKind: "contractor",
        startDate: "2026-09-02",
        role: "Race",
        engagementRef: { module: "cases", id: project.id },
        humanDecision: true,
      },
      principal.tenantId,
    );
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        code,
        JSON.stringify({
          path: h.path,
          principal,
          profile: h.initiatives.profile(principal),
          input,
          context: ctx(),
        }),
      ],
      {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Child readiness timeout")),
        5000,
      );
      child.stdout.on("data", () => {
        if (output.includes("ready\n")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("error", reject);
    });
    const completed = once(child, "exit");
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    return {
      child,
      ready,
      completed,
      result: () => {
        assert.equal(child.exitCode, 0, errors);
        return JSON.parse(output.trim().split("\n").at(-1)!);
      },
    };
  });
  await Promise.all(children.map((child) => child.ready));
  for (const child of children) child.child.stdin.end("go\n");
  await Promise.all(children.map((child) => child.completed));
  const results = children.map((child) => child.result());
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(
    results.filter((result) =>
      ["VERSION_CONFLICT", "EMPLOYMENT_LIMIT"].includes(result.code),
    ).length,
    1,
  );
  assert.equal(h.episodes(person).length, 2);
});

test("a sealed plan retains its supplied profile pin across repeated preparation and fails closed after a policy change", async (t) => {
  const h = fixture(t);
  const person = await h.create("people", "Pinned policy person", {
    personCategory: "contractor",
  });
  const adapter = h.tool("people", "startEmployment");
  const prepared = adapter.prepareInput!(
    {
      id: person.id,
      expectedVersion: person.version,
      employmentKind: "contractor",
      startDate: "2026-09-01",
      role: "Pinned role",
      humanDecision: true,
    },
    principal.tenantId,
  );
  const original = structuredClone(prepared);
  assert.equal(prepared.profileVersion, 0);
  await h.configure(parallel);
  assert.deepEqual(
    adapter.prepareInput!(prepared, principal.tenantId),
    original,
  );
  await assert.rejects(
    adapter.execute(ctx(), prepared),
    code("PROFILE_CHANGED"),
  );
  assert.equal(h.episodes(person).length, 0);
  const approver: Principal = {
    ...principal,
    id: "independent-approver",
    roles: ["approver"],
  };
  const tools = h.workspace.tools();
  const engine = new Engine({
    dbPath: ":memory:",
    tools,
    principals: [principal, approver],
    policies: [
      {
        tenantId: principal.tenantId,
        name: "Pinned policy test",
        version: "1",
        allowedTools: tools.map((tool) => tool.id),
        approvalTools: [],
        allowSelfApproval: false,
      },
    ],
  });
  t.after(() => engine.close());
  const run = engine.createRun(
    principal,
    "Execute the already prepared scoped plan",
    {
      title: "Sealed employment plan",
      summary: "Version was chosen before company settings changed",
      steps: [
        {
          id: "start",
          title: "Start employment",
          toolId: adapter.id,
          input: prepared,
        },
      ],
    },
    randomUUID(),
  );
  assert.deepEqual(run.steps[0]!.input, original);
  engine.start(principal, run.id);
  await engine.tick();
  const approval = engine.getRun(principal, run.id).steps[0]!.approval!;
  engine.approve(approver, run.id, {
    approvalId: approval.id,
    bindingHash: approval.bindingHash,
    decision: "approved",
  });
  for (let i = 0; i < 4; i++) await engine.tick();
  assert.equal(engine.getRun(principal, run.id).status, "needs_reconciliation");
  assert.equal(engine.getRun(principal, run.id).steps[0]!.status, "unknown");
  assert.equal(h.episodes(person).length, 0);
  assert.deepEqual(engine.getRun(principal, run.id).steps[0]!.input, original);
});
