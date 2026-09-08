import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  JsonObject,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from "../src/contracts.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import {
  configureVariants,
  startVariant,
} from "./helpers/onboarding-variants-fixture.js";
import { seedOnboarding } from "./helpers/onboarding-fixture.js";
import {
  cancellationInput,
  clearOnboardingResources,
} from "./helpers/cancellation-fixture.js";

test("cancelled starts preserve history in two firms, close outstanding human work and allow a fresh same-date period without inherited evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-start-"));
  let f = custodyFixture(dir);
  const cases: {
    tenant: string;
    caseId: string;
    personId: string;
    input: JsonObject;
  }[] = [];
  try {
    for (const [tenant, kind] of [
      ["synthetic-a", "internal"],
      ["synthetic-b", "contractor"],
    ] as const) {
      await configureVariants(f, undefined, tenant);
      const s = await startVariant(f, kind, tenant);
      const before = f.get("cases", s.caseId, tenant);
      await f.complete(
        "ops.people.cancelStart",
        cancellationInput(f, s.caseId, tenant),
        "manager",
        tenant,
      );
      const person = f.get("people", s.personId, tenant),
        episode = f.workspace.listEmploymentEpisodes(
          f.actor("manager", tenant),
          s.personId,
        )[0]!;
      assert.equal(person.status, "registered");
      assert.equal(episode.status, "cancelled");
      assert.equal(episode.endDate, null);
      assert.equal(episode.endReason, null);
      assert.equal(episode.startDate, s.episode.startDate);
      assert.equal(episode.version, 2);
      assert.equal(episode.cancellation?.requestedBy, "manager");
      assert.equal(episode.cancellation?.approvedBy, "reviewer");
      const c = f.get("cases", s.caseId, tenant);
      assert.equal(c.status, "cancelled");
      assert.deepEqual(c.data.scopeHistory, before.data.scopeHistory);
      assert.ok(
        (c.data.tasks as JsonObject[]).every((t) => t.status === "cancelled"),
      );
      assert.equal(
        f.workspace.onboarding(f.actor("manager", tenant), c.id).stage.id,
        "cancelled",
      );
      cases.push({
        tenant,
        caseId: c.id,
        personId: s.personId,
        input: s.input,
      });
    }
    f.close();
    f = custodyFixture(dir);
    for (const s of cases) {
      const old = f.get("cases", s.caseId, s.tenant);
      await f.complete(
        "ops.people.startEmployment",
        {
          ...s.input,
          expectedVersion: f.get("people", s.personId, s.tenant).version,
        },
        "manager",
        s.tenant,
      );
      const eps = f.workspace.listEmploymentEpisodes(
        f.actor("manager", s.tenant),
        s.personId,
      );
      assert.equal(eps.length, 2);
      const fresh = eps.find((e) => e.status === "onboarding")!;
      assert.notEqual(fresh.id, old.data.employmentEpisodeId);
      assert.deepEqual(f.get("cases", s.caseId, s.tenant), old);
      const r = f.workspace.readiness(
        f.actor("manager", s.tenant),
        fresh.onboardingCaseId!,
      );
      assert.equal(r.ready, false);
      assert.equal(r.acceptanceCurrent, false);
      assert.ok(r.requirements.every((r) => r.status !== "satisfied"));
      assert.ok(
        !(
          f.get("cases", fresh.onboardingCaseId!, s.tenant).data
            .tasks as JsonObject[]
        ).some((t) =>
          (old.data.tasks as JsonObject[]).some((x) => x.id === t.id),
        ),
      );
    }
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancellation requires returns, revoked licences and explicit access removal even after observation expiry; another project is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-resources-"));
  let now = custodyNow;
  const f = custodyFixture(dir, { domainClock: () => now });
  try {
    const a = await seedOnboarding(f, {
        kind: "contractor",
        startDate: "2026-09-10",
      }),
      b = await seedOnboarding(f, {
        kind: "contractor",
        personId: a.personId,
        startDate: "2026-09-11",
        keepProfile: true,
      });
    await a.documents();
    await a.equipment();
    await a.access();
    const bBefore = {
      case: b.getCase(),
      asset: f.get("assets", b.assetId),
      license: f.get("licenses", b.licenseId),
    };
    let o = f.workspace.onboarding(f.actor(), a.caseId);
    assert.deepEqual(o.cancellation!.blockers.map((b) => b.kind).sort(), [
      "access",
      "access",
      "equipment",
      "license",
    ]);
    assert.ok(!o.cancellation!.blockers.some((x) => x.id === b.assetId));
    assert.deepEqual(
      o
        .cancellation!.blockers.filter((b) => b.kind === "access")
        .map((b) => b.title)
        .sort(),
      ["Synthetic mail · member", "Synthetic wiki · reader"],
    );
    assert.equal(o.cancellation!.command, undefined);
    const blocked = await f.stage(
      "ops.people.cancelStart",
      cancellationInput(f, a.caseId),
    );
    f.approve(blocked);
    await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor(), blocked.id).steps[0]!.error!,
      /Najpierw rozlicz/,
    );
    assert.equal(a.getCase().status, "open");
    now = Date.parse("2026-09-16T10:00:00Z");
    o = f.workspace.onboarding(f.actor(), a.caseId);
    assert.equal(
      o.cancellation!.blockers.filter((b) => b.kind === "access").length,
      2,
    );
    now = custodyNow;
    await clearOnboardingResources(f, a);
    o = f.workspace.onboarding(f.actor(), a.caseId);
    assert.equal(o.cancellation!.ready, true);
    await a.complete("ops.people.cancelStart", cancellationInput(f, a.caseId));
    assert.deepEqual(b.getCase(), bBefore.case);
    assert.deepEqual(f.get("assets", b.assetId), bBefore.asset);
    assert.deepEqual(f.get("licenses", b.licenseId), bBefore.license);
    assert.equal(f.get("people", a.personId).status, "onboarding");
    assert.equal(
      f.workspace
        .listEmploymentEpisodes(f.actor(), a.personId)
        .find((e) => e.id === b.episodeId)!.status,
      "onboarding",
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an approved cancellation cannot ignore a later reservation or changed scope, and rejecting its approval leaves the period open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-race-")),
    f = custodyFixture(dir);
  try {
    await configureVariants(f);
    const s = await startVariant(f, "internal");
    const created = await f.complete("ops.assets.create", {
        title: "Synthetic new reservation",
        data: {
          assetType: "laptop",
          serial: "CANCEL-RACE",
          location: "Synthetic stock",
          condition: "good",
        },
      }),
      assetId = String(created.steps[0]!.output!.data.entityId);
    const ep = f.workspace
        .listEmploymentEpisodes(f.actor(), s.personId)
        .find((e) => e.status === "onboarding")!,
      caseId = ep.onboardingCaseId!;
    const late = await f.stage(
      "ops.people.cancelStart",
      cancellationInput(f, caseId),
    );
    await f.complete("ops.assets.reserve", {
      id: assetId,
      expectedVersion: 1,
      personId: s.personId,
      employmentEpisodeId: ep.id,
      expectedEpisodeVersion: ep.version,
      caseId,
      purpose: "Synthetic reservation arriving before approval execution",
      until: "2026-09-12",
    });
    f.approve(late);
    await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor(), late.id).steps[0]!.error!,
      /Stan rozliczenia zasobów zmienił/,
    );
    assert.equal(
      f.workspace
        .listEmploymentEpisodes(f.actor(), s.personId)
        .find((e) => e.id === ep.id)!.status,
      "onboarding",
    );
    const allocation = f.workspace.assetCustody(f.actor(), assetId)
      .allocations[0]!;
    await f.complete("ops.assets.release", {
      id: assetId,
      expectedVersion: f.get("assets", assetId).version,
      allocationId: allocation.id,
      expectedAllocationVersion: allocation.version,
      reason: "Synthetic release before scope change",
    });
    const changed = await f.stage(
      "ops.people.cancelStart",
      cancellationInput(f, caseId),
    );
    const c = f.get("cases", caseId);
    await f.complete("ops.cases.revise", {
      id: caseId,
      expectedVersion: c.version,
      brief: String(c.data.brief),
      acceptanceCriteria: "Synthetic revised expectations",
      reason: "Synthetic new scope",
    });
    f.approve(changed);
    await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor(), changed.id).steps[0]!.error!,
      /Zakres onboardingu zmienił/,
    );
    const declined = await f.stage(
        "ops.people.cancelStart",
        cancellationInput(f, caseId),
      ),
      a = declined.steps[0]!.approval!;
    f.engine.approve(f.actor("reviewer"), declined.id, {
      approvalId: a.id,
      bindingHash: a.bindingHash,
      decision: "rejected",
    });
    await f.engine.tick();
    assert.equal(f.get("cases", caseId).status, "open");
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committed cancellation can be reconciled after a new start, but corrupted resource history cannot prove clearance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cancel-replay-"));
  let capture:
    | {
        tool: ToolDefinition;
        ctx: ToolContext;
        input: JsonObject;
        result: ToolResult;
      }
    | undefined;
  const f = custodyFixture(dir, {
    wrap: (tool) =>
      tool.id !== "ops.people.cancelStart"
        ? tool
        : {
            ...tool,
            async execute(ctx, input) {
              const result = await tool.execute(ctx, input);
              capture = { tool, ctx, input, result };
              return result;
            },
          },
  });
  try {
    await configureVariants(f);
    const s = await startVariant(f, "internal");
    await f.complete("ops.people.cancelStart", cancellationInput(f, s.caseId));
    assert.ok(capture);
    await f.complete("ops.people.startEmployment", {
      ...s.input,
      expectedVersion: f.get("people", s.personId).version,
    });
    const before = f.get("people", s.personId);
    assert.equal(
      (await capture.tool.reconcile!(capture.ctx, capture.input)).status,
      "applied",
    );
    assert.deepEqual(
      await capture.tool.execute(capture.ctx, capture.input),
      capture.result,
    );
    assert.equal(
      (await capture.tool.verify(capture.ctx, capture.input, capture.result))
        .ok,
      true,
    );
    assert.deepEqual(f.get("people", s.personId), before);
    const tamper = new DatabaseSync(join(dir, "operations.sqlite"));
    tamper
      .prepare(
        "UPDATE ops_tasks SET evidence_note='Synthetic tampering' WHERE tenant_id=? AND case_id=?",
      )
      .run("synthetic-a", s.caseId);
    tamper.close();
    assert.equal(
      (await capture.tool.verify(capture.ctx, capture.input, capture.result))
        .ok,
      false,
    );
    await assert.rejects(
      capture.tool.reconcile!(capture.ctx, capture.input),
      /wymaga uzgodnienia/,
    );
    const t = await seedOnboarding(f, { tenant: "synthetic-b" }),
      db = new DatabaseSync(join(dir, "operations.sqlite"));
    db.prepare(
      "UPDATE ops_allocations SET status='released' WHERE tenant_id=? AND asset_id=?",
    ).run("synthetic-b", t.assetId);
    db.close();
    const o = f.workspace.onboarding(
      f.actor("manager", "synthetic-b"),
      t.caseId,
    );
    assert.equal(o.cancellation!.ready, false);
    assert.ok(o.cancellation!.blockers.some((b) => b.kind === "integrity"));
    const legacy = new DatabaseSync(join(dir, "operations.sqlite"));
    legacy
      .prepare(
        "UPDATE ops_license_seats SET employment_episode_id=NULL WHERE tenant_id=? AND license_id=?",
      )
      .run("synthetic-b", t.licenseId);
    legacy.close();
    assert.ok(
      f.workspace
        .onboarding(f.actor("manager", "synthetic-b"), t.caseId)
        .cancellation!.blockers.some((b) => b.kind === "unresolved"),
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
