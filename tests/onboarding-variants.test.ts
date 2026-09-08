import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { onboardingVariantsSchema } from "../src/onboarding-profile.js";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import {
  configureVariants,
  profileInput,
  startVariant,
  variants,
} from "./helpers/onboarding-variants-fixture.js";
import { seedOnboarding } from "./helpers/onboarding-fixture.js";
import type { JsonObject } from "../src/contracts.js";

test("onboarding variants keep mandatory typed results, matching roles and known dependencies; personal evidence is not a company default", () => {
  assert.equal(onboardingVariantsSchema.safeParse(variants()).success, true);
  const bad = (change: (v: ReturnType<typeof variants>) => void) => {
    const v = variants();
    change(v);
    assert.equal(onboardingVariantsSchema.safeParse(v).success, false);
  };
  bad((v) => {
    v.internal.requirements = v.internal.requirements.filter(
      (r) => r.kind !== "asset_issued",
    );
  });
  bad((v) => {
    v.contractor.tasks[0]!.requirementKeys = ["unknown"];
  });
  bad((v) => {
    v.contractor.tasks[0]!.assigneeRole = "it";
  });
  bad((v) => {
    v.internal.tasks[1]!.dependsOn = ["readiness"];
  });
  bad((v) => {
    const r = v.internal.requirements.find(
      (r) => r.kind === "document_approved",
    )!;
    if (r.kind === "document_approved")
      r.expected.documentId = "42eeb80c-637f-44ab-9ccd-1b21d78feaba";
  });
});

test("one company has separate pinned employee and consultant requirements; legacy cases and other tenants survive profile changes and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-onboarding-variants-"));
  let f = custodyFixture(directory);
  try {
    const legacy = await startVariant(f, "internal");
    const legacyCase = f.get("cases", legacy.caseId);
    const v = variants();
    v.internal.tasks[0]!.offsetDays = -5;
    v.contractor.tasks[0]!.title = "Dokumenty projektu klienta";
    const doc = v.internal.requirements.find(
      (r) => r.kind === "document_approved",
    )!;
    if (doc.kind === "document_approved") doc.expected.fileRequired = true;
    const asset = v.contractor.requirements.find(
      (r) => r.kind === "asset_issued",
    )!;
    if (asset.kind === "asset_issued") asset.expected.assetType = "phone";
    await configureVariants(f, v);
    const a = await startVariant(f, "internal"),
      b = await startVariant(f, "contractor");
    const internal = f.get("cases", a.caseId),
      contractor = f.get("cases", b.caseId);
    assert.equal(f.initiatives.profile(f.actor()).definitionVersion, "4");
    assert.deepEqual(f.get("cases", legacy.caseId), legacyCase);
    assert.equal(
      f.workspace.onboarding(f.actor(), a.caseId).tasks[0]!.dueDate,
      "2026-09-03",
    );
    assert.equal(
      f.workspace.onboarding(f.actor(), b.caseId).tasks[0]!.title,
      "Dokumenty projektu klienta",
    );
    const byKey = <T extends { key: string }>(items: T[]) =>
      [...items].sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(
      f.workspace.readiness(f.actor(), a.caseId).definitions,
      byKey(v.internal.requirements),
    );
    assert.deepEqual(
      f.workspace.readiness(f.actor(), b.caseId).definitions,
      byKey(v.contractor.requirements),
    );
    assert.equal(internal.data.profileVersion, 1);
    assert.equal(
      (contractor.data.processTemplateSnapshot as JsonObject).employmentKind,
      "contractor",
    );
    await configureVariants(f, variants());
    assert.deepEqual(f.get("cases", a.caseId), internal);
    assert.deepEqual(f.get("cases", b.caseId), contractor);
    assert.equal(
      f.initiatives.profile(f.actor("manager", "synthetic-b")).version,
      0,
    );
    assert.throws(
      () => f.workspace.onboarding(f.actor("manager", "synthetic-b"), a.caseId),
      /Nie znaleziono/,
    );
    f.close();
    f = custodyFixture(directory);
    assert.deepEqual(f.get("cases", a.caseId), internal);
    assert.deepEqual(f.get("cases", b.caseId), contractor);
    assert.equal(f.initiatives.profile(f.actor()).version, 2);
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("profile changes block a previously prepared start; an older client cannot erase configured variants", async () => {
  const directory = mkdtempSync(
      join(tmpdir(), "jarvis-onboarding-profile-change-"),
    ),
    f = custodyFixture(directory);
  try {
    const created = await f.complete("ops.people.create", {
      title: "Synthetic pending start",
      data: { personCategory: "internal" },
    });
    const personId = String(created.steps[0]!.output!.data.entityId);
    const start = await f.stage("ops.people.startEmployment", {
      id: personId,
      expectedVersion: 1,
      employmentKind: "internal",
      startDate: "2026-09-08",
      role: "Synthetic role",
      humanDecision: true,
    });
    await configureVariants(f);
    f.approve(start);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    const failed = f.engine.getRun(f.actor(), start.id);
    assert.equal(failed.status, "needs_reconciliation");
    assert.match(failed.steps[0]!.error!, /Szablon firmy zmienił wersję/);
    assert.equal(
      f.workspace.listEmploymentEpisodes(f.actor(), personId).length,
      0,
    );
    const downgrade = profileInput(f);
    delete downgrade.onboardingVariants;
    const run = await f.stage("initiatives.configure", downgrade);
    f.approve(run);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor(), run.id).steps[0]!.error!,
      /Profil ma osobne warianty/,
    );
    assert.equal(f.initiatives.profile(f.actor()).version, 1);
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("full onboarding of both kinds uses the same configured company; date revision invalidates acceptance and recreates work without inheriting evidence", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "jarvis-onboarding-date-change-"),
  );
  let now = custodyNow,
    f = custodyFixture(directory, { domainClock: () => now });
  try {
    await configureVariants(f);
    for (const kind of ["internal", "contractor"] as const) {
      const a = await seedOnboarding(f, { kind, keepProfile: true });
      await a.documents();
      await a.equipment();
      await a.access();
      await a.managerReview();
      await a.accept();
      assert.equal(a.readiness().acceptanceCurrent, true);
      if (kind === "internal") {
        const oldCase = a.getCase(),
          oldTasks = f.workspace.onboarding(f.actor(), a.caseId).tasks;
        const activation = await f.stage(
          "ops.people.activate",
          a.activationInput(),
        );
        await a.complete("ops.cases.revise", {
          id: a.caseId,
          expectedVersion: oldCase.version,
          startDate: "2026-09-10",
          expectedEpisodeVersion: 1,
          brief: String(oldCase.data.brief),
          acceptanceCriteria: String(oldCase.data.acceptanceCriteria),
          reason: "Explicit changed synthetic start",
        });
        f.approve(activation);
        for (let i = 0; i < 4; i++) await f.engine.tick();
        assert.equal(
          f.engine.getRun(f.actor(), activation.id).status,
          "needs_reconciliation",
        );
        assert.equal(
          f.workspace.listEmploymentEpisodes(f.actor(), a.personId)[0]!.status,
          "onboarding",
        );
        const overview = f.workspace.onboarding(f.actor(), a.caseId);
        assert.equal(overview.episode.startDate, "2026-09-10");
        assert.equal(overview.acceptanceCurrent, false);
        assert.equal(overview.ready, false);
        assert.ok(
          overview.tasks.every(
            (t) =>
              t.status === "offered" &&
              !oldTasks.some((old) => old.id === t.id),
          ),
        );
        assert.ok(
          a.readiness().requirements.every((r) => r.status === "missing"),
        );
        assert.equal((a.getCase().data.acceptances as unknown[]).length, 1);
        const task = a.task("equipment");
        await a.complete(
          "ops.cases.declineTask",
          {
            id: a.caseId,
            expectedVersion: a.getCase().version,
            taskId: task.id,
            expectedTaskVersion: task.version,
            reason: "Synthetic IT delay",
            humanConfirmed: true,
          },
          "it-one",
        );
        now += 5 * 86400000;
        const delayed = f.workspace.onboarding(f.actor(), a.caseId);
        assert.ok(
          delayed.tasks.some((t) => t.status === "declined" && t.overdue),
        );
        now = custodyNow;
      } else {
        await a.complete("ops.people.activate", a.activationInput());
        assert.equal(
          f.workspace.onboarding(f.actor(), a.caseId).stage.id,
          "active",
        );
      }
    }
    const before = f.initiatives.profile(f.actor());
    f.close();
    f = custodyFixture(directory);
    assert.deepEqual(f.initiatives.profile(f.actor()), before);
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
