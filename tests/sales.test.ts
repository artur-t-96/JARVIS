import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DomainError,
  type JsonObject,
  type ToolContext,
} from "../src/contracts.js";
import { salesFixture } from "./helpers/sales-fixture.js";
const code = (c: string) => (e: unknown) =>
  e instanceof DomainError && e.code === c;
const raw = (
  f: ReturnType<typeof salesFixture>,
  action: string,
  input: JsonObject,
  tenant = "synthetic-a",
  actor = "manager",
) => {
  const ctx: ToolContext = {
    tenantId: tenant,
    actorId: actor,
    approvedBy: "reviewer",
    operationKey: randomUUID(),
    runId: "synthetic",
    stepId: "action",
    signal: new AbortController().signal,
  };
  return f.tools
    .find((t) => t.id === `ops.sales.${action}`)!
    .execute(ctx, input);
};
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sales-")),
    f = salesFixture(dir);
  return {
    dir,
    f,
    close: () => {
      f.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("sales requires internal review, attested delivery, client decision and an accepted next step", async () => {
  const { f, close } = fixture();
  try {
    const a = await f.salesSeed(),
      b = await f.salesSeed("synthetic-b");
    const invoke = (action: string, fields: JsonObject) =>
      raw(f, action, {
        id: a.offer.id,
        expectedVersion: f.get("sales", a.offer.id).version,
        ...fields,
      });
    await assert.rejects(
      invoke("acceptOffer", {
        acceptedOn: "2026-09-08",
        acceptanceNote: "Synthetic",
        evidenceReference: "TEST",
        humanDecision: true,
      }),
      code("INVALID_TRANSITION"),
    );
    const sent = await f.salesSend(a.offer.id);
    assert.equal(sent.status, "sent");
    assert.equal(
      (sent.data.dispatch as JsonObject).method,
      "human_attestation",
    );
    const accepted = await f.salesAccept(a.offer.id);
    assert.equal(accepted.status, "accepted");
    assert.equal(f.get("sales", a.deal.id).data.acceptedOfferId, a.offer.id);
    await assert.rejects(
      invoke("handoff", { acceptanceCriteria: "Odbiór klienta" }),
      code("SALES_NEXT_STEP_REQUIRED"),
    );
    const step = await f.salesNext(a.deal.id);
    assert.equal(step.status, "accepted");
    const delivered = await f.salesAction(a.offer.id, "handoff", {
      acceptanceCriteria: "Odbiór syntetycznej realizacji",
    });
    const c = f.get("cases", String(delivered.data.deliveryCaseId));
    assert.deepEqual(
      (c.data.sourceOfferSnapshot as JsonObject).offer,
      accepted.data.offer,
    );
    assert.equal(f.get("sales", a.deal.id).status, "won");
    assert.deepEqual(f.get("sales", b.offer.id, "synthetic-b"), b.offer);
    assert.throws(
      () =>
        f.workspace.salesView(f.actor("manager", "synthetic-b"), a.offer.id),
      code("ENTITY_NOT_FOUND"),
    );
  } finally {
    close();
  }
});

test("offer revisions preserve old decisions, invalidate pending approval and enforce one accepted offer", async () => {
  const { f, close } = fixture();
  try {
    const { deal, offer } = await f.salesSeed();
    const sent = await f.salesSend(offer.id),
      first = sent.data.offer;
    const pending = await f.stage("ops.sales.acceptOffer", {
      id: sent.id,
      expectedVersion: sent.version,
      acceptedOn: "2026-09-08",
      acceptanceNote: "Synthetic",
      evidenceReference: "TEST",
      humanDecision: true,
    });
    const revised = await f.salesAction(sent.id, "reviseOffer", {
      ...f.salesPins(deal.id),
      title: "SYNTHETIC zmieniony zakres",
      terms: { ...f.salesTerms, scope: "Nowy zakres po uzgodnieniu" },
      reason: "Klient zmienił zakres",
    });
    assert.equal(revised.data.revision, 2);
    assert.equal(revised.data.dispatch, undefined);
    assert.deepEqual(
      (revised.data.revisionHistory as JsonObject[])[0]!.offer,
      first,
    );
    f.approve(pending);
    await f.engine.tick();
    assert.equal(
      f.engine.getRun(f.actor(), pending.id).status,
      "needs_reconciliation",
    );
    assert.match(
      String(f.engine.getRun(f.actor(), pending.id).steps[0]!.error),
      /Rekord zmienił się/,
    );
    assert.equal(f.get("sales", offer.id).status, "draft");
    await f.salesSend(revised.id);
    await f.salesAccept(revised.id);
    const competing = await f.salesCreate("SYNTHETIC inna oferta", {
      kind: "offer",
      parentId: deal.id,
      ...f.salesPins(deal.id),
      terms: f.salesTerms,
    });
    const proposed = await f.salesSend(competing.id);
    await assert.rejects(
      raw(f, "acceptOffer", {
        id: proposed.id,
        expectedVersion: proposed.version,
        acceptedOn: "2026-09-08",
        acceptanceNote: "Synthetic",
        evidenceReference: "TEST",
        humanDecision: true,
      }),
      code("ACCEPTED_OFFER_EXISTS"),
    );
    await assert.rejects(
      raw(f, "update", {
        id: revised.id,
        expectedVersion: f.get("sales", revised.id).version,
        title: "Podmieniony zakres",
      }),
      code("REVISION_REQUIRED"),
    );
  } finally {
    close();
  }
});

test("sales owner, current source and revoked approval are rechecked before writes", async () => {
  const { f, close } = fixture();
  try {
    const { contact, deal, offer } = await f.salesSeed();
    await raw(f, "update", {
      id: contact.id,
      expectedVersion: contact.version,
      data: { contactEmail: "changed@example.invalid" },
    });
    await assert.rejects(
      raw(f, "submitOffer", { id: offer.id, expectedVersion: offer.version }),
      code("SALES_SOURCE_CHANGED"),
    );
    const view = f.workspace.salesView(f.actor(), offer.id);
    assert.equal(view.sourceCurrent, false);
    await f.salesAction(offer.id, "reviseOffer", {
      ...f.salesPins(deal.id),
      title: offer.title,
      terms: f.salesTerms,
      reason: "Aktualny kontakt",
    });
    const sent = await f.salesSend(offer.id);
    const staged = await f.stage("ops.sales.acceptOffer", {
      id: sent.id,
      expectedVersion: sent.version,
      acceptedOn: "2026-09-08",
      acceptanceNote: "Synthetic",
      evidenceReference: "TEST",
      humanDecision: true,
    });
    f.approve(staged);
    f.actor("reviewer").scopes = ["it"];
    await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), staged.id).status, "completed");
    assert.equal(f.get("sales", offer.id).status, "sent");
    await assert.rejects(
      raw(f, "submitOffer", { id: offer.id, expectedVersion: sent.version }),
      code("SALES_AUTHORITY_REQUIRED"),
    );
  } finally {
    close();
  }
});

test("next steps require their assignee and cannot be duplicated", async () => {
  const { f, close } = fixture();
  try {
    const { deal } = await f.salesSeed();
    f.principals.push({
      id: "sales-two",
      tenantId: "synthetic-a",
      roles: ["operator"],
      scopes: ["sales"],
    });
    const d = await f.salesAction(deal.id, "scheduleNextStep", {
      title: "Syntetyczny kontakt",
      description: "Potwierdzić następny krok",
      ownerPrincipalId: "sales-two",
      dueDate: "2026-09-09",
    });
    const step = f.get("sales", String(d.data.nextStepId));
    await assert.rejects(
      raw(f, "acceptNextStep", {
        id: step.id,
        expectedVersion: step.version,
        humanConfirmed: true,
      }),
      code("SALES_OWNER_REQUIRED"),
    );
    await assert.rejects(
      raw(f, "scheduleNextStep", {
        id: deal.id,
        expectedVersion: d.version,
        title: "Duplikat",
        description: "Duplikat",
        ownerPrincipalId: "manager",
        dueDate: "2026-09-10",
      }),
      code("SALES_NEXT_STEP_OPEN"),
    );
    await raw(
      f,
      "acceptNextStep",
      { id: step.id, expectedVersion: step.version, humanConfirmed: true },
      "synthetic-a",
      "sales-two",
    );
    const accepted = f.get("sales", step.id);
    assert.equal(
      (accepted.data.ownerAcceptance as JsonObject).actorId,
      "sales-two",
    );
    await raw(
      f,
      "completeNextStep",
      {
        id: step.id,
        expectedVersion: accepted.version,
        completedOn: "2026-09-08",
        evidenceReference: "SYNTHETIC",
        note: "Otrzymano termin",
        humanConfirmed: true,
      },
      "synthetic-a",
      "sales-two",
    );
    assert.equal(f.get("sales", deal.id).data.nextStepId, null);
    assert.equal(f.get("sales", step.id).status, "completed");
  } finally {
    close();
  }
});

test("sales cancellation preserves proof and corrupted domain state blocks reconciliation", async () => {
  const { dir, f, close } = fixture();
  try {
    const { offer } = await f.salesSeed();
    await f.salesSend(offer.id);
    const accepted = await f.salesAccept(offer.id);
    const cancelled = await f.salesAction(offer.id, "cancelOffer", {
      cancelledOn: "2026-09-08",
      evidenceReference: "SYNTHETIC-CANCEL",
      note: "Syntetyczne obustronne wycofanie ustaleń",
      humanConfirmed: true,
    });
    assert.deepEqual(cancelled.data.acceptance, accepted.data.acceptance);
    assert.equal(
      f.workspace.salesView(f.actor(), offer.id).acceptanceCurrent,
      false,
    );
    const db = new DatabaseSync(join(dir, "operations.sqlite"));
    db.prepare(
      "UPDATE ops_entities SET data_json=json_set(data_json,'$.offer.terms.scope','CORRUPTED') WHERE id=?",
    ).run(offer.id);
    db.close();
    assert.throws(
      () => f.workspace.salesView(f.actor(), offer.id),
      code("SALES_STATE_INCONSISTENT"),
    );
  } finally {
    close();
  }
});

test("ownership changes invalidate pending execution and declined next steps release only the work assignment", async () => {
  const { f, close } = fixture();
  try {
    const { deal, offer } = await f.salesSeed();
    const sent = await f.salesSend(offer.id);
    const pending = await f.stage("ops.sales.acceptOffer", {
      id: sent.id,
      expectedVersion: sent.version,
      acceptedOn: "2026-09-08",
      acceptanceNote: "Synthetic",
      evidenceReference: "TEST",
      humanDecision: true,
    });
    f.actor("it-one").scopes = ["sales"];
    await f.salesAction(deal.id, "assignSalesOwner", {
      ownerPrincipalId: "it-one",
      reason: "Syntetyczne przekazanie",
    });
    f.approve(pending);
    await f.engine.tick();
    assert.notEqual(f.engine.getRun(f.actor(), pending.id).status, "completed");
    assert.equal(f.get("sales", offer.id).status, "sent");
    const changed = f.get("sales", deal.id);
    await raw(
      f,
      "scheduleNextStep",
      {
        id: deal.id,
        expectedVersion: changed.version,
        title: "Syntetyczne zadanie",
        description: "Syntetyczny kontakt",
        ownerPrincipalId: "manager",
        dueDate: "2026-09-09",
      },
      "synthetic-a",
      "it-one",
    );
    const step = f.get(
      "sales",
      String(f.get("sales", deal.id).data.nextStepId),
    );
    await f.salesAction(step.id, "declineNextStep", {
      reason: "Brak dostępności",
      humanDecision: true,
    });
    assert.equal(f.get("sales", step.id).status, "declined");
    assert.equal(f.get("sales", deal.id).data.nextStepId, null);
    assert.equal(f.get("sales", offer.id).status, "sent");
  } finally {
    close();
  }
});

test("event dates use the company day and a late report cannot backdate acceptance beyond offer validity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sales-dates-"));
  let now = Date.parse("2026-09-09T00:30:00Z");
  const f = salesFixture(dir, { domainClock: () => now });
  try {
    const p = f.initiatives.profile(f.actor());
    await f.complete("initiatives.configure", {
      companyName: "SYNTHETIC New York",
      timezone: "America/New_York",
      licenseReminderDays: p.licenseReminderDays,
      quietHours: p.quietHours,
      rules: p.rules,
      roleBindings: p.roleBindings,
      processTemplates: p.processTemplates,
      employmentPolicy: p.employmentPolicy,
      expectedVersion: p.version,
    } as JsonObject);
    const { deal, offer } = await f.salesSeed();
    const sent = await f.salesSend(offer.id);
    assert.equal((sent.data.review as JsonObject).recordedOn, "2026-09-08");
    const other = await f.salesCreate("SYNTHETIC competing", {
      kind: "offer",
      parentId: deal.id,
      ...f.salesPins(deal.id),
      terms: f.salesTerms,
    });
    const otherSent = await f.salesSend(other.id);
    now = Date.parse("2026-10-02T15:00:00Z");
    await f.salesAccept(sent.id);
    assert.equal(
      f.workspace.salesView(f.actor(), sent.id).acceptanceCurrent,
      true,
    );
    await assert.rejects(
      raw(f, "acceptOffer", {
        id: other.id,
        expectedVersion: otherSent.version,
        acceptedOn: "2026-10-02",
        acceptanceNote: "Synthetic",
        evidenceReference: "TEST",
        humanDecision: true,
      }),
      code("OFFER_EXPIRED"),
    );
    await f.salesAction(other.id, "declineOffer", {
      decidedOn: "2026-10-02",
      evidenceReference: "TEST",
      note: "Syntetyczna odmowa po wygaśnięciu",
      humanConfirmed: true,
    });
    assert.equal(f.get("sales", other.id).status, "declined");
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed acceptance rolls back both records, versions, audit and outbox", async () => {
  const { dir, f, close } = fixture();
  try {
    const { offer } = await f.salesSeed();
    const sent = await f.salesSend(offer.id);
    const db = new DatabaseSync(join(dir, "operations.sqlite"));
    try {
      const snapshot = () =>
        [
          "ops_entities",
          "ops_entity_versions",
          "ops_audit",
          "ops_commands",
          "ops_outbox",
        ].map((table) =>
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        );
      const before = snapshot();
      db.exec(
        "CREATE TRIGGER synthetic_sales_failure BEFORE UPDATE OF status ON ops_entities WHEN NEW.module='sales' AND NEW.status='accepted' BEGIN SELECT RAISE(ABORT,'synthetic acceptance failure'); END;",
      );
      await assert.rejects(
        raw(f, "acceptOffer", {
          id: offer.id,
          expectedVersion: sent.version,
          acceptedOn: "2026-09-08",
          acceptanceNote: "Synthetic",
          evidenceReference: "TEST",
          humanDecision: true,
        }),
        /synthetic acceptance failure/,
      );
      assert.deepEqual(snapshot(), before);
    } finally {
      db.close();
    }
  } finally {
    close();
  }
});

test("negative independent verification prevents the next execution from creating a delivery case", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-sales-negative-"));
  const f = salesFixture(dir, {
    wrap: (tool) =>
      tool.id !== "ops.sales.acceptOffer"
        ? tool
        : {
            ...tool,
            async verify() {
              return {
                ok: false,
                summary: "Synthetic independent rejection",
                evidence: [],
              };
            },
          },
  });
  try {
    const { deal, offer } = await f.salesSeed();
    const sent = await f.salesSend(offer.id);
    await f.salesNext(deal.id);
    const run = f.engine.createRun(
      f.actor(),
      "Synthetic sales only",
      {
        title: "Synthetic acceptance and delivery",
        summary: "Second write must not execute if verification fails",
        steps: [
          {
            id: "accept",
            title: "Synthetic decision",
            toolId: "ops.sales.acceptOffer",
            input: {
              id: offer.id,
              expectedVersion: sent.version,
              acceptedOn: "2026-09-08",
              acceptanceNote: "Synthetic",
              evidenceReference: "TEST",
              humanDecision: true,
            },
          },
          {
            id: "handoff",
            title: "Synthetic handoff",
            toolId: "ops.sales.handoff",
            input: {
              id: offer.id,
              expectedVersion: sent.version + 1,
              acceptanceCriteria: "Synthetic only",
            },
          },
        ],
      },
      randomUUID(),
    );
    f.engine.start(f.actor(), run.id);
    await f.engine.tick();
    f.approve(f.engine.getRun(f.actor(), run.id));
    for (let i = 0; i < 5; i++) await f.engine.tick();
    const stopped = f.engine.getRun(f.actor(), run.id);
    assert.equal(stopped.steps[0]!.verification?.ok, false);
    assert.equal(stopped.steps[1]!.attempts, 0);
    assert.equal(f.get("sales", offer.id).data.deliveryCaseId, undefined);
    assert.equal(f.workspace.list(f.actor(), "cases").length, 0);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
