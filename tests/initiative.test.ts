import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  DomainError,
  hasToolAccess,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "../src/contracts.js";
import { InitiativeStore, type CompanySettings } from "../src/initiative.js";
import { WorkspaceStore, type Entity } from "../src/workspace.js";

const principal = (tenantId = "tenant-a", scopes = ["*"]): Principal => ({
  id: "requester",
  tenantId,
  roles: ["operator", "approver"],
  scopes,
});
const context = (
  tenantId = "tenant-a",
  operationKey = randomUUID(),
): ToolContext => ({
  tenantId,
  actorId: "requester",
  approvedBy: "reviewer",
  operationKey,
  runId: "trusted-run",
  stepId: "trusted-step",
  signal: new AbortController().signal,
});
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
function fixture(durable = false) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-initiative-test-"));
  const workspace = new WorkspaceStore(
    durable ? join(directory, "operations.sqlite") : ":memory:",
  );
  const path = durable ? join(directory, "initiatives.sqlite") : ":memory:";
  let now = Date.parse("2099-01-02T12:00:00.000Z");
  let initiatives = new InitiativeStore(path, workspace, { clock: () => now });
  const invoke = async (
    module: string,
    action: string,
    input: JsonObject,
    tenantId = "tenant-a",
  ) => {
    const tool = workspace
      .tools()
      .find((entry) => entry.id === `ops.${module}.${action}`)!;
    const result = await tool.execute(context(tenantId), input);
    return workspace.get(
      principal(tenantId),
      module,
      String(result.data.entityId),
    );
  };
  return {
    directory,
    workspace,
    path,
    get initiatives() {
      return initiatives;
    },
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    invoke,
    create: (
      module: string,
      title: string,
      data: JsonObject,
      tenantId = "tenant-a",
    ) => invoke(module, "create", { title, data }, tenantId),
    change: (
      entity: Entity,
      action: string,
      input: JsonObject,
      tenantId = "tenant-a",
    ) =>
      invoke(
        entity.module,
        action,
        { id: entity.id, expectedVersion: entity.version, ...input },
        tenantId,
      ),
    reopen() {
      initiatives.close();
      initiatives = new InitiativeStore(path, workspace, { clock: () => now });
    },
    close() {
      initiatives.close();
      workspace.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function settings(
  store: InitiativeStore,
  tenantId = "tenant-a",
): CompanySettings {
  const profile = store.profile(principal(tenantId));
  return {
    companyName: profile.companyName,
    timezone: profile.timezone,
    licenseReminderDays: profile.licenseReminderDays,
    quietHours: profile.quietHours,
    rules: profile.rules,
    processTemplates: profile.processTemplates,
  };
}
async function configure(
  store: InitiativeStore,
  changes: Partial<CompanySettings>,
  tenantId = "tenant-a",
  operationKey = randomUUID(),
) {
  const tool = store
    .tools()
    .find((entry) => entry.id === "initiatives.configure")!;
  const input = {
    ...settings(store, tenantId),
    ...changes,
    expectedVersion: store.profile(principal(tenantId)).version,
  } as unknown as JsonObject;
  const ctx = context(tenantId, operationKey);
  const result = await tool.execute(ctx, input);
  assert.equal((await tool.verify(ctx, input, result)).ok, true);
  return { tool, input, result, ctx };
}

test("two company profiles actually drive different expiry windows and retain distinct requester/approver", async () => {
  const ctx = fixture();
  try {
    await configure(ctx.initiatives, {
      companyName: "Firma A",
      licenseReminderDays: 5,
    });
    await configure(
      ctx.initiatives,
      { companyName: "Firma B", licenseReminderDays: 20 },
      "tenant-b",
    );
    for (const tenant of ["tenant-a", "tenant-b"])
      await ctx.create(
        "licenses",
        "Produkt",
        { product: "Test", totalSeats: 2, expiresOn: "2099-01-12" },
        tenant,
      );
    assert.equal(ctx.initiatives.scan(principal()).created, 0);
    assert.equal(ctx.initiatives.scan(principal("tenant-b")).created, 1);
    assert.equal(ctx.initiatives.list(principal()).length, 0);
    assert.equal(
      ctx.initiatives.list(principal("tenant-b"))[0]?.dueDate,
      "2099-01-12",
    );
    const profile = ctx.initiatives.profile(principal());
    assert.equal(profile.companyName, "Firma A");
    assert.equal(profile.updatedBy, "requester");
    assert.equal(profile.updatedApprovedBy, "reviewer");
    assert.equal(profile.version, 1);
  } finally {
    ctx.close();
  }
});

test("scans real overdue tasks/cases, expired reservations, licenses and severe incidents without duplicates", async () => {
  const ctx = fixture();
  try {
    let person = await ctx.create("people", "Osoba", {
      personCategory: "internal",
    });
    person = await ctx.change(person, "startEmployment", {
      employmentKind: "internal",
      startDate: "2099-01-01",
      role: "Test",
      humanDecision: true,
    });
    let caseItem = await ctx.create("cases", "Sprawa", {
      caseType: "general",
      brief: "Zakres",
      acceptanceCriteria: "Gotowe",
      dueDate: "2099-01-01",
      ownerId: person.id,
    });
    caseItem = await ctx.change(caseItem, "addTask", {
      title: "Weryfikacja człowieka",
      dueDate: "2099-01-01",
      assigneeId: person.id,
      required: true,
    });
    let asset = await ctx.create("assets", "Laptop", {
      assetType: "laptop",
      serial: "TEST-1",
      location: "Biuro",
      condition: "good",
    });
    asset = await ctx.change(asset, "reserve", {
      personId: person.id,
      purpose: "Test",
      until: "2099-01-01",
    });
    const license = await ctx.create("licenses", "Licencja", {
      product: "Test",
      totalSeats: 2,
      expiresOn: "2099-01-01",
    });
    const incident = await ctx.create("it", "Awaria", {
      kind: "incident",
      description: "Lokalny incydent",
      severity: "critical",
      environment: "local",
    });
    const first = ctx.initiatives.scan(principal());
    assert.ok(first.created >= 5);
    const ids = [caseItem.id, asset.id, license.id, incident.id];
    const proposals = ctx.initiatives
      .list(principal())
      .filter((item) => ids.includes(item.sourceId));
    assert.deepEqual(
      proposals.map((item) => item.rule).sort(),
      [
        "overdue_case",
        "overdue_task",
        "expired_reservation",
        "license_expiry",
        "high_severity_incident",
      ].sort(),
    );
    const task = proposals.find((item) => item.rule === "overdue_task")!;
    assert.equal(task.ownerId, person.id);
    assert.equal(task.dueDate, "2099-01-01");
    assert.equal(
      task.sourceItemId,
      (caseItem.data.tasks as JsonObject[])[0]?.id,
    );
    ctx.advance(60_000);
    const repeated = ctx.initiatives.scan(principal());
    assert.equal(repeated.created, 0);
    assert.equal(repeated.updated, 0);
    const reread = ctx.initiatives
      .list(principal())
      .find((item) => item.id === task.id)!;
    assert.equal(reread.version, task.version);
    assert.notEqual(reread.lastObservedAt, task.lastObservedAt);
    assert.equal(
      ctx.workspace.get(principal(), "assets", asset.id).status,
      "reserved",
      "proposal does not release the source reservation",
    );
  } finally {
    ctx.close();
  }
});

test("snooze survives repeated scans and restart, expires once, dismissal survives unrelated source versions", async () => {
  const ctx = fixture(true);
  try {
    let license = await ctx.create("licenses", "Licencja", {
      product: "Test",
      totalSeats: 2,
      expiresOn: "2099-01-06",
    });
    ctx.initiatives.scan(principal());
    let item = ctx.initiatives.list(principal())[0]!;
    let snooze = ctx.initiatives
      .tools()
      .find((tool) => tool.id === "initiatives.snooze")!;
    const input = {
      id: item.id,
      expectedVersion: item.version,
      until: new Date(ctx.now + 86_400_000).toISOString(),
      reason: "Ustalono termin jutro",
    };
    const operation = context();
    const receipt = await snooze.execute(operation, input);
    ctx.initiatives.scan(principal());
    ctx.reopen();
    snooze = ctx.initiatives
      .tools()
      .find((tool) => tool.id === "initiatives.snooze")!;
    assert.deepEqual(await snooze.execute(operation, input), receipt);
    assert.equal((await snooze.verify(operation, input, receipt)).ok, true);
    assert.equal(ctx.initiatives.list(principal())[0]?.status, "snoozed");
    ctx.advance(86_400_001);
    assert.equal(ctx.initiatives.scan(principal()).updated, 1);
    item = ctx.initiatives.list(principal())[0]!;
    assert.equal(item.status, "open");
    const dismiss = ctx.initiatives
      .tools()
      .find((tool) => tool.id === "initiatives.dismiss")!;
    await dismiss.execute(context(), {
      id: item.id,
      expectedVersion: item.version,
      reason: "Obsługiwane w innym terminie",
    });
    license = await ctx.change(license, "resize", { totalSeats: 3 });
    ctx.initiatives.scan(principal());
    const dismissed = ctx.initiatives.list(principal())[0]!;
    assert.equal(dismissed.status, "dismissed");
    assert.equal(dismissed.sourceVersion, license.version);
    license = await ctx.change(license, "renew", {
      expiresOn: "2099-01-07",
      evidenceNote: "Potwierdzony dokument",
      humanConfirmed: true,
    });
    ctx.initiatives.scan(principal());
    assert.equal(
      ctx.initiatives.list(principal())[0]?.status,
      "open",
      "meaningful expiry change reopens proposal",
    );
    await assert.rejects(
      dismiss.execute(context(), {
        id: item.id,
        expectedVersion: item.version,
        reason: "Stara wersja",
      }),
      code("VERSION_CONFLICT"),
    );
    assert.equal(
      (await snooze.verify(operation, input, receipt)).ok,
      true,
      "historical effect stays verified after legitimate later state changes",
    );
  } finally {
    ctx.close();
  }
});

test("forbidden scopes cannot see, act on, or auto-resolve another scanner's protected source", async () => {
  const ctx = fixture();
  try {
    const person = await ctx.create("people", "Osoba", {
      personCategory: "internal",
    });
    let caseItem = await ctx.create("cases", "Poufna sprawa", {
      caseType: "general",
      brief: "Zakres",
      acceptanceCriteria: "Gotowe",
      ownerId: person.id,
      dueDate: "2099-01-01",
    });
    ctx.initiatives.scan(principal());
    const item = ctx.initiatives.list(principal())[0]!;
    const weak = principal("tenant-a", ["initiatives", "cases"]);
    assert.equal(ctx.initiatives.list(weak).length, 0);
    const dismiss = ctx.initiatives
      .tools()
      .find((tool) => tool.id === "initiatives.dismiss")!;
    assert.equal(
      hasToolAccess(weak, dismiss, {
        id: item.id,
        expectedVersion: item.version,
        reason: "Test",
      }),
      false,
    );
    assert.equal(
      hasToolAccess(principal(), dismiss, {
        id: item.id,
        expectedVersion: item.version,
        reason: "Test",
      }),
      true,
    );
    assert.equal(ctx.initiatives.list(principal("tenant-b")).length, 0);
    await assert.rejects(
      dismiss.execute(context("tenant-b"), {
        id: item.id,
        expectedVersion: item.version,
        reason: "Test",
      }),
      code("INITIATIVE_NOT_FOUND"),
    );
    caseItem = await ctx.change(caseItem, "cancel", {
      reason: "Wycofano zakres",
    });
    const partial = ctx.initiatives.scan(weak);
    assert.equal(partial.resolved, 0);
    assert.equal(partial.observed, 0);
    assert.equal(ctx.initiatives.list(principal())[0]?.status, "open");
    assert.equal(ctx.initiatives.scan(principal()).resolved, 1);
    assert.equal(ctx.initiatives.list(principal())[0]?.status, "resolved");
    assert.equal(caseItem.status, "cancelled");
  } finally {
    ctx.close();
  }
});

test("quiet hours use company timezone without suppressing source observation", async () => {
  const ctx = fixture();
  try {
    await configure(ctx.initiatives, {
      timezone: "Europe/Warsaw",
      quietHours: { enabled: true, start: "12:00", end: "14:00" },
    });
    await ctx.create("it", "Awaria", {
      kind: "incident",
      description: "Lokalny incydent",
      severity: "high",
      environment: "local",
    });
    const during = ctx.initiatives.scan(principal());
    assert.equal(during.quietHours, true);
    assert.equal(during.created, 1);
    assert.equal(during.actionable, 0);
    assert.equal(
      ctx.initiatives.list(principal())[0]?.deliveryState,
      "quiet_hours",
    );
    ctx.advance(2 * 3_600_000);
    const after = ctx.initiatives.scan(principal());
    assert.equal(after.quietHours, false);
    assert.equal(after.created, 0);
    assert.equal(after.actionable, 1);
  } finally {
    ctx.close();
  }
});

test("profile templates are strict, versioned and approved; replay reconciles while actual tampering fails verification", async () => {
  const ctx = fixture(true);
  try {
    const defaults = settings(ctx.initiatives);
    const custom = {
      ...defaults.processTemplates,
      onboarding: [
        {
          key: "access",
          title: "Sprawdź dostęp dzień wcześniej",
          required: true,
          offsetDays: -1,
          dependsOn: [],
        },
        {
          key: "ready",
          title: "Odbierz gotowość",
          required: true,
          offsetDays: 0,
          dependsOn: ["access"],
        },
      ],
    };
    const command = await configure(ctx.initiatives, {
      processTemplates: custom,
    });
    assert.deepEqual(
      ctx.initiatives.profile(principal()).processTemplates.onboarding,
      custom.onboarding,
    );
    ctx.reopen();
    const configureTool = ctx.initiatives
      .tools()
      .find((tool) => tool.id === "initiatives.configure")!;
    assert.deepEqual(
      await configureTool.reconcile!(command.ctx, command.input),
      { status: "applied", result: command.result },
    );
    assert.equal(
      hasToolAccess(
        principal("tenant-a", ["initiatives", "people"]),
        configureTool,
        command.input,
      ),
      false,
    );
    await assert.rejects(
      configureTool.execute(
        { ...context(), approvedBy: undefined },
        { ...command.input, expectedVersion: 1 },
      ),
      code("TRUSTED_CONTEXT_REQUIRED"),
    );
    await assert.rejects(
      configureTool.execute(context(), {
        ...command.input,
        tenantId: "spoofed",
        expectedVersion: 1,
      }),
      code("INVALID_INITIATIVE_INPUT"),
    );
    await assert.rejects(
      configureTool.execute(context(), {
        ...command.input,
        expectedVersion: 1,
        processTemplates: {
          ...custom,
          onboarding: [
            { ...custom.onboarding[0]!, dependsOn: ["ready"] },
            custom.onboarding[1]!,
          ],
        },
      }),
      code("INVALID_INITIATIVE_INPUT"),
    );
    await assert.rejects(
      configureTool.execute(command.ctx, {
        ...command.input,
        companyName: "Different",
      }),
      code("IDEMPOTENCY_CONFLICT"),
    );
    await configure(ctx.initiatives, { companyName: "Nowsza wersja" });
    assert.equal(
      (await configureTool.verify(command.ctx, command.input, command.result))
        .ok,
      true,
    );
    const db = new DatabaseSync(ctx.path);
    const current = JSON.parse(
      String(
        db
          .prepare(
            "SELECT record_json FROM initiative_profiles WHERE tenant_id='tenant-a'",
          )
          .get()!.record_json,
      ),
    );
    current.companyName = "Zmienione poza rejestrem";
    db.prepare(
      "UPDATE initiative_profiles SET record_json=? WHERE tenant_id='tenant-a'",
    ).run(JSON.stringify(current));
    db.close();
    assert.equal(
      (await configureTool.verify(command.ctx, command.input, command.result))
        .ok,
      false,
    );
  } finally {
    ctx.close();
  }
});
