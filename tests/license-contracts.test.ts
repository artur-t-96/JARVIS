import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { licenseFixture } from "./helpers/license-fixture.js";
import type { JsonObject, ToolContext, ToolResult } from "../src/contracts.js";
import { custodyNow } from "./helpers/custody-fixture.js";

test("license terms require a cost decision and independent human confirmation in two firms", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-")),
    f = licenseFixture(dir);
  try {
    for (const tenant of ["synthetic-a", "synthetic-b"]) {
      const { pool, terms } = await f.seedLicense(tenant);
      assert.equal(f.licenseView(pool.id, tenant).costKnown, false);
      const proposal = await f.licenseAction(
        pool.id,
        "proposeTerms",
        { terms },
        tenant,
      );
      assert.equal(f.get("licenses", pool.id, tenant).data.totalSeats, 2);
      await f.decision(proposal.id, tenant);
      assert.equal(
        f.get("licenses", pool.id, tenant).data.expiresOn,
        "2026-09-20",
      );
      const run = await f.complete(
        "ops.licenses.confirmTerms",
        f.confirmInput(proposal.id, tenant),
        "manager",
        tenant,
      );
      const view = f.licenseView(pool.id, tenant);
      assert.equal(view.costKnown, true);
      assert.equal(view.pool.data.totalSeats, 3);
      assert.equal(view.pool.data.expiresOn, "2027-08-31");
      assert.equal(view.pool.data.provisioning, "local_register_only");
      assert.equal(view.usedSeats, 0);
      assert.equal(run.steps[0]!.attempts, 1);
      const record = view.terms[0]!.record;
      assert.equal((record.data.costDecision as JsonObject).actorId, "manager");
      assert.equal(
        (record.data.confirmation as JsonObject).approvedBy,
        "reviewer",
      );
      assert.equal((record.data.terms as JsonObject).totalCostMinor, 12345);
      assert.throws(() =>
        f.workspace.licenseContracts(
          f.actor(
            "manager",
            tenant === "synthetic-a" ? "synthetic-b" : "synthetic-a",
          ),
          pool.id,
        ),
      );
      assert.throws(() =>
        f.workspace.licenseContracts(
          { ...f.actor("manager", tenant), scopes: ["licenses"] },
          pool.id,
        ),
      );
      assert.deepEqual(
        f.workspace
          .list(
            { ...f.actor("manager", tenant), scopes: ["licenses"] },
            "licenses",
          )
          .map((e) => e.id),
        [pool.id],
      );
    }
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revised price invalidates the exact approved plan; rejection and cancellation preserve current entitlements", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-price-")),
    f = licenseFixture(dir);
  try {
    const { pool, terms } = await f.seedLicense();
    let p = await f.licenseAction(pool.id, "proposeTerms", { terms });
    await f.decision(p.id);
    const stale = f.confirmInput(p.id);
    const waiting = await f.stage("ops.licenses.confirmTerms", stale);
    p = await f.licenseAction(p.id, "reviseTerms", {
      terms: { ...terms, totalCostMinor: 45678 },
      reason: "New supplier price",
    });
    assert.equal(p.status, "draft");
    assert.equal(p.data.costDecision, null);
    f.approve(waiting);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), waiting.id).status, "completed");
    assert.equal(f.get("licenses", pool.id).data.totalSeats, 2);
    await f.failRun("ops.licenses.confirmTerms", {
      ...stale,
      expectedVersion: p.version,
    });
    await f.licenseAction(p.id, "decideTerms", {
      decision: "rejected",
      note: "Synthetic refusal",
      humanDecision: true,
    });
    await f.licenseAction(p.id, "cancelTerms", { reason: "Do not renew" });
    assert.equal(f.get("licenses", pool.id).data.expiresOn, "2026-09-20");
    assert.equal(f.get("licenses", pool.id).data.pendingTermsId, null);
    for (const [action, data] of [
      ["resize", { totalSeats: 10 }],
      [
        "renew",
        {
          expiresOn: "2028-01-01",
          evidenceNote: "Bypass",
          humanConfirmed: true,
        },
      ],
    ] as const)
      await f.failRun(`ops.licenses.${action}`, {
        id: pool.id,
        expectedVersion: f.get("licenses", pool.id).version,
        ...data,
      });
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("future period stays pending; the owner and supplier must still be authorized when activating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-future-"));
  let now = custodyNow;
  const f = licenseFixture(dir, { domainClock: () => now });
  try {
    const { pool, terms, supplier } = await f.seedLicense();
    const p = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, validFrom: "2026-10-01" },
    });
    await f.decision(p.id);
    await f.failRun("ops.licenses.confirmTerms", f.confirmInput(p.id));
    assert.match(f.licenseView(pool.id).terms[0]!.problem!, /2026-10-01/);
    now = Date.parse("2026-10-01T10:00:00Z");
    await f.action(supplier.id, "deactivate", { reason: "Supplier inactive" });
    await f.failRun("ops.licenses.confirmTerms", f.confirmInput(p.id));
    const manager = f.principals.find(
      (p) => p.id === "manager" && p.tenantId === "synthetic-a",
    )!;
    manager.scopes = ["licenses"];
    assert.throws(() =>
      f.engine.createRun(
        manager,
        "Forbidden costs",
        {
          title: "x",
          summary: "x",
          steps: [
            {
              id: "s",
              title: "s",
              toolId: "ops.licenses.confirmTerms",
              input: f.confirmInput(p.id),
            },
          ],
        },
        "scope-test",
      ),
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmed source identity is unique and a new proposal cannot bypass accepted limits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-identity-")),
    f = licenseFixture(dir);
  try {
    const { pool, terms } = await f.seedLicense();
    const p = await f.licenseAction(pool.id, "proposeTerms", { terms });
    await f.decision(p.id);
    await f.complete("ops.licenses.confirmTerms", f.confirmInput(p.id));
    const next = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, totalSeats: 4, totalCostMinor: 78900 },
    });
    await f.decision(next.id);
    await f.failRun(
      "ops.licenses.confirmTerms",
      f.confirmInput(next.id, "synthetic-a", "  synthetic-doc-1  "),
    );
    assert.equal(f.get("licenses", pool.id).data.totalSeats, 3);
    await f.complete(
      "ops.licenses.confirmTerms",
      f.confirmInput(next.id, "synthetic-a", "SYNTHETIC-AMENDMENT-2"),
    );
    assert.equal(f.get("licenses", p.id).status, "superseded");
    assert.equal(f.get("licenses", pool.id).data.totalSeats, 4);
    await f.failRun("ops.licenses.proposeTerms", {
      id: next.id,
      expectedVersion: f.get("licenses", next.id).version,
      terms,
    });
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("confirmed license receipt reconciles after lost response and rejects corrupted evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-recovery-"));
  let saved:
    { ctx: ToolContext; input: JsonObject; result: ToolResult } | undefined;
  let now = Date.now();
  const f = licenseFixture(dir, {
    clock: () => now,
    wrap: (tool) =>
      tool.id === "ops.licenses.confirmTerms"
        ? {
            ...tool,
            execute: async (ctx, input) => {
              const result = await tool.execute(ctx, input);
              saved = { ctx, input, result };
              throw Error("Synthetic response lost after domain commit");
            },
          }
        : tool,
  });
  try {
    const { pool, terms } = await f.seedLicense();
    const p = await f.licenseAction(pool.id, "proposeTerms", { terms });
    await f.decision(p.id);
    const run = await f.stage(
      "ops.licenses.confirmTerms",
      f.confirmInput(p.id),
    );
    f.approve(run);
    await f.engine.tick();
    assert.ok(saved);
    now += 5000;
    f.engine.retry(f.actor(), run.id);
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), run.id).status, "completed");
    const tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.licenses.confirmTerms")!;
    assert.equal(
      (await tool.reconcile!(saved.ctx, saved.input)).status,
      "applied",
    );
    assert.equal(f.licenseView(pool.id).terms.length, 1);
    const db = new DatabaseSync(join(dir, "operations.sqlite"));
    db.prepare(
      "UPDATE ops_entities SET data_json=json_set(data_json,'$.terms.totalCostMinor',999) WHERE id=?",
    ).run(p.id);
    db.close();
    await assert.rejects(() => tool.reconcile!(saved!.ctx, saved!.input), {
      code: "LICENSE_STATE_INCONSISTENT",
    });
    await assert.rejects(
      () => tool.verify!(saved!.ctx, saved!.input, saved!.result),
      { code: "LICENSE_STATE_INCONSISTENT" },
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two contenders for the last licensed seat and a lower renewal limit cannot remove a live assignment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-capacity-")),
    f = licenseFixture(dir);
  try {
    const { pool, terms } = await f.seedLicense();
    const p = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, totalSeats: 1 },
    });
    await f.decision(p.id);
    await f.complete("ops.licenses.confirmTerms", f.confirmInput(p.id));
    const inputs: JsonObject[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await f.complete("ops.people.create", {
        title: `Synthetic person ${i}`,
        data: { personCategory: "internal" },
      });
      const personId = String(r.steps[0]!.output!.data.entityId);
      await f.complete("ops.people.startEmployment", {
        id: personId,
        expectedVersion: 1,
        employmentKind: "internal",
        startDate: "2026-09-08",
        role: "Synthetic",
        humanDecision: true,
      });
      const episode = f.workspace.listEmploymentEpisodes(
        f.actor(),
        personId,
      )[0]!;
      inputs.push({
        id: pool.id,
        expectedVersion: f.get("licenses", pool.id).version,
        personId,
        employmentEpisodeId: episode.id,
        expectedEpisodeVersion: episode.version,
        note: "Synthetic seat only",
      });
    }
    const first = await f.stage("ops.licenses.assign", inputs[0]!);
    const second = await f.stage("ops.licenses.assign", inputs[1]!);
    f.approve(first);
    f.approve(second);
    for (let i = 0; i < 6; i++) await f.engine.tick();
    assert.equal(
      [first, second]
        .map((r) => f.engine.getRun(f.actor(), r.id))
        .filter((r) => r.status === "completed").length,
      1,
    );
    assert.equal(f.licenseView(pool.id).usedSeats, 1);
    await f.failRun("ops.licenses.assign", {
      ...inputs[1]!,
      expectedVersion: f.get("licenses", pool.id).version,
    });
    const next = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, totalSeats: 2 },
    });
    await f.decision(next.id);
    await f.complete(
      "ops.licenses.confirmTerms",
      f.confirmInput(next.id, "synthetic-a", "SYNTHETIC-INCREASE"),
    );
    await f.complete("ops.licenses.assign", {
      ...inputs[1]!,
      expectedVersion: f.get("licenses", pool.id).version,
    });
    const lower = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, totalSeats: 1 },
    });
    await f.failRun("ops.licenses.decideTerms", {
      id: lower.id,
      expectedVersion: lower.version,
      decision: "approved",
      note: "Must not reduce below usage",
      humanDecision: true,
    });
    assert.equal(f.licenseView(pool.id).usedSeats, 2);
    assert.equal(f.licenseView(pool.id).pool.data.totalSeats, 2);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner transfer invalidates the pending cost decision and live reviewer revocation blocks the write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-owner-")),
    f = licenseFixture(dir);
  try {
    const { pool, terms } = await f.seedLicense();
    const p = await f.licenseAction(pool.id, "proposeTerms", { terms });
    await f.decision(p.id);
    f.actor("it-one").scopes = ["licenses", "purchases"];
    await f.licenseAction(pool.id, "assignOwner", {
      ownerPrincipalId: "it-one",
      reason: "Synthetic responsibility transfer",
    });
    const changed = f.get("licenses", p.id);
    assert.equal(changed.status, "draft");
    assert.equal(changed.data.costDecision, null);
    await f.failRun("ops.licenses.decideTerms", {
      id: p.id,
      expectedVersion: changed.version,
      decision: "approved",
      note: "Old owner must fail",
      humanDecision: true,
    });
    await f.licenseAction(
      p.id,
      "decideTerms",
      { decision: "approved", note: "New owner approves", humanDecision: true },
      "synthetic-a",
      "it-one",
    );
    const run = await f.stage(
      "ops.licenses.confirmTerms",
      f.confirmInput(p.id),
    );
    f.approve(run);
    const history = f.workspace.licenseTermsHistory(f.actor(), p.id, {
      limit: 2,
      offset: 0,
    });
    assert.equal(history.total, 4);
    assert.deepEqual(
      history.items.map((i) => i.record.version),
      [4, 3],
    );
    assert.equal(
      (history.items[0]!.record.data.costDecision as JsonObject).actorId,
      "it-one",
    );
    const previous = f.workspace.licenseTermsHistory(f.actor(), p.id, {
      limit: 2,
      offset: 2,
    });
    assert.equal(
      (previous.items[0]!.record.data.costDecision as JsonObject).actorId,
      "manager",
    );
    assert.equal(
      (previous.items[0]!.record.data.terms as JsonObject).ownerPrincipalId,
      "manager",
    );
    assert.throws(() =>
      f.workspace.licenseTermsHistory(
        { ...f.actor(), scopes: ["licenses"] },
        p.id,
        { limit: 2, offset: 0 },
      ),
    );
    f.actor("reviewer").scopes = ["licenses"];
    for (let i = 0; i < 4; i++) await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), run.id).status, "completed");
    assert.equal(f.get("licenses", pool.id).data.totalSeats, 2);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renewal initiative has the actual owner, preserves a pause and never activates or purchases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-license-reminder-"));
  let now = custodyNow;
  const f = licenseFixture(dir, { domainClock: () => now });
  try {
    const { pool, terms } = await f.seedLicense();
    const p = await f.licenseAction(pool.id, "proposeTerms", {
      terms: { ...terms, expiresOn: "2026-10-01", renewalLeadDays: 10 },
    });
    await f.decision(p.id);
    await f.complete("ops.licenses.confirmTerms", f.confirmInput(p.id));
    f.initiatives.scan(f.actor());
    assert.equal(
      f.initiatives.list(f.actor()).filter((i) => i.rule === "license_expiry")
        .length,
      0,
    );
    now = Date.parse("2026-09-21T10:00:00Z");
    f.initiatives.scan(f.actor());
    f.initiatives.scan(f.actor());
    const found = f.initiatives
      .list(f.actor())
      .filter((i) => i.rule === "license_expiry");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.ownerPrincipalId, "manager");
    assert.equal(found[0]!.sourceId, pool.id);
    await f.complete("initiatives.snooze", {
      id: found[0]!.id,
      expectedVersion: found[0]!.version,
      until: "2026-09-25T10:00:00.000Z",
      reason: "Wait for supplier terms",
    });
    f.initiatives.scan(f.actor());
    assert.equal(
      f.initiatives.list(f.actor()).find((i) => i.id === found[0]!.id)!.status,
      "snoozed",
    );
    assert.equal(f.get("licenses", pool.id).data.expiresOn, "2026-10-01");
    assert.equal(f.licenseView(pool.id).terms.length, 1);
    assert.equal(
      f.workspace
        .list(f.actor(), "purchases")
        .filter((e) => e.data.kind === "order").length,
      0,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
