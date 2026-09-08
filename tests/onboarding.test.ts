import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { custodyFixture, custodyNow } from "./helpers/custody-fixture.js";
import { seedOnboarding } from "./helpers/onboarding-fixture.js";
import { fileHash } from "../src/document-files.js";
import type { JsonObject } from "../src/contracts.js";

test("complete onboarding requires original document, witnessed laptop and exact access, then owner acceptance and activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-full-onboarding-"));
  let f = custodyFixture(directory);
  try {
    const a = await seedOnboarding(f);
    const view = () => f.workspace.onboarding(f.actor(), a.caseId);
    assert.equal(view().stage.id, "preparing");
    assert.equal(view().command, undefined);
    assert.equal(a.readiness().ready, false);
    const documentId = await a.documents();
    assert.equal(a.readiness().ready, false);
    await a.equipment();
    assert.equal(a.readiness().ready, false);
    await a.access();
    assert.ok(
      a.readiness().requirements.every((r) => r.status === "satisfied"),
    );
    assert.equal(a.readiness().ready, false, "manager task remains unfinished");
    await a.managerReview();
    assert.equal(a.readiness().ready, true, JSON.stringify(a.readiness()));
    assert.equal(a.readiness().acceptanceCurrent, false);
    assert.equal(view().command?.action, "submit");
    await a.accept();
    assert.equal(a.readiness().acceptanceCurrent, true);
    assert.equal(view().command?.action, "activate");
    const run = await a.complete("ops.people.activate", a.activationInput());
    assert.equal(run.steps[0]!.attempts, 1);
    f.close();
    f = custodyFixture(directory);
    assert.equal(
      f.workspace.listEmploymentEpisodes(f.actor(), a.personId)[0]!.status,
      "active",
    );
    assert.equal(
      f.workspace.readiness(f.actor(), a.caseId).acceptanceCurrent,
      true,
    );
    assert.equal(
      f.workspace.documentReadiness(f.actor(), documentId).approvalCurrent,
      true,
    );
    assert.equal(f.engine.getRun(f.actor(), run.id).status, "completed");
    assert.equal(view().stage.id, "active");
    assert.equal(view().command, undefined);
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("accepted onboarding loses activation eligibility when its original changes; a prepared command cannot bypass the new check", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-onboarding-stale-")),
    f = custodyFixture(directory);
  try {
    const a = await seedOnboarding(f),
      documentId = await a.documents();
    await a.equipment();
    await a.access();
    await a.managerReview();
    await a.accept();
    const run = await f.stage("ops.people.activate", a.activationInput()),
      original = (
        f.get("documents", documentId).data.files as JsonObject[]
      )[0]!;
    writeFileSync(
      join(
        directory,
        "attachments",
        "document-files",
        "saved",
        fileHash(a.tenant),
        String(original.id),
        "content.bin",
      ),
      "Synthetic changed bytes",
    );
    const overview = f.workspace.onboarding(f.actor(), a.caseId);
    assert.equal(overview.acceptanceCurrent, false);
    assert.equal(overview.stage.id, "changes_required");
    assert.equal(overview.command, undefined);
    f.approve(run);
    await f.engine.tick();
    const failed = f.engine.getRun(f.actor(), run.id);
    assert.equal(failed.status, "needs_reconciliation");
    assert.match(failed.steps[0]!.error!, /aktualnej gotowości/);
    assert.equal(
      f.workspace.listEmploymentEpisodes(f.actor(), a.personId)[0]!.status,
      "onboarding",
    );
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("future accepted start waits for the company's day and expired access prevents activation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-onboarding-date-"));
  let now = custodyNow;
  const f = custodyFixture(directory, { domainClock: () => now });
  try {
    const a = await seedOnboarding(f, { startDate: "2026-09-09" });
    await a.documents();
    await a.equipment();
    await a.access();
    await a.managerReview();
    await a.accept();
    const view = () => f.workspace.onboarding(f.actor(), a.caseId);
    assert.equal(view().stage.id, "waiting_start");
    assert.equal(view().command, undefined);
    const early = await f.stage("ops.people.activate", a.activationInput());
    f.approve(early);
    await f.engine.tick();
    assert.match(
      f.engine.getRun(f.actor(), early.id).steps[0]!.error!,
      /Data rozpoczęcia jeszcze/,
    );
    now = Date.parse("2026-09-08T22:01:00Z");
    assert.equal(view().today, "2026-09-09");
    assert.equal(view().stage.id, "ready_to_activate");
    now = Date.parse("2026-09-15T10:00:00Z");
    assert.equal(view().acceptanceCurrent, false);
    assert.equal(view().command, undefined);
    assert.equal(view().stage.id, "changes_required");
    assert.equal(
      f.workspace.listEmploymentEpisodes(f.actor(), a.personId)[0]!.status,
      "onboarding",
    );
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two companies and two parallel consultant projects keep separate tasks, licences, evidence and owner decisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-onboarding-projects-")),
    f = custodyFixture(directory);
  try {
    const employee = await seedOnboarding(f),
      first = await seedOnboarding(f, {
        tenant: "synthetic-b",
        kind: "contractor",
      }),
      second = await seedOnboarding(f, {
        tenant: "synthetic-b",
        kind: "contractor",
        personId: first.personId,
      });
    await first.documents();
    await first.equipment();
    await first.access();
    await first.managerReview();
    await first.accept("rejected");
    assert.equal(
      f.workspace.onboarding(f.actor("manager", "synthetic-b"), first.caseId)
        .stage.id,
      "changes_required",
    );
    assert.equal(first.readiness().acceptanceCurrent, false);
    const secondBefore = second.getCase();
    assert.equal(second.readiness().ready, false);
    assert.ok(
      second.readiness().requirements.every((r) => r.status === "missing"),
    );
    assert.equal(employee.readiness().ready, false);
    await first.accept();
    await first.complete("ops.people.activate", first.activationInput());
    assert.deepEqual(second.getCase(), secondBefore);
    const periods = f.workspace.listEmploymentEpisodes(
      f.actor("manager", "synthetic-b"),
      first.personId,
    );
    assert.equal(
      periods.find((e) => e.id === first.episodeId)!.status,
      "active",
    );
    assert.equal(
      periods.find((e) => e.id === second.episodeId)!.status,
      "onboarding",
    );
    assert.equal(
      f.workspace.onboarding(f.actor("manager", "synthetic-b"), first.caseId)
        .engagement!.id,
      first.projectId,
    );
    const access = JSON.stringify(
      f.workspace.caseAccess(f.actor("manager", "synthetic-b"), first.caseId),
    );
    assert.ok(!access.includes(second.licenseSeatId));
    assert.ok(!access.includes(employee.personId));
  } finally {
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
