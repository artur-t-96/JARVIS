import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  AssistantDraftStore,
  conversationAuthority,
  type DraftClaim,
  type PreparedProposal,
} from "../src/assistant-drafts.js";
import { DomainError, type Principal } from "../src/contracts.js";

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-assistant-drafts-")),
    path = join(directory, "assistant.sqlite");
  const connections: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(path);
    db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100;",
    );
    connections.push(db);
    return db;
  };
  const db = open();
  db.exec(`CREATE TABLE conversations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,title TEXT NOT NULL,slots_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,authority_hash TEXT NOT NULL DEFAULT '');
  CREATE TABLE chat_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,kind TEXT,run_id TEXT,created_at TEXT NOT NULL);
  CREATE TABLE chat_requests(conversation_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(conversation_id,request_key));`);
  const p: Principal = {
    id: "operator-a",
    tenantId: "company-a",
    roles: ["operator", "approver"],
    scopes: ["assets", "people", "cases"],
  };
  let now = Date.parse("2026-09-09T08:00:00Z");
  const principals = new Map<string, Principal>([[`${p.tenantId}:${p.id}`, p]]);
  const provider = (tenant: string, actor: string) =>
    principals.get(`${tenant}:${actor}`);
  const create = (principal = p) => {
    const id = randomUUID(),
      stamp = new Date(now).toISOString();
    db.prepare(
      "INSERT INTO conversations(id,tenant_id,actor_id,title,slots_json,created_at,updated_at,authority_hash) VALUES(?,?,?,'Nowa rozmowa','{}',?,?,?)",
    ).run(
      id,
      principal.tenantId,
      principal.id,
      stamp,
      stamp,
      conversationAuthority(principal),
    );
    return id;
  };
  const store = (connection = db) => {
    const result = new AssistantDraftStore(connection, {
      clock: () => now,
      leaseMs: 1000,
    });
    result.setPrincipalProvider(provider);
    return result;
  };
  t.after(() => {
    for (const connection of connections) {
      try {
        connection.close();
      } catch {}
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    db,
    p,
    principals,
    provider,
    create,
    store,
    open,
    advance: (ms: number) => {
      now += ms;
    },
    count: (table: string) =>
      Number(
        (
          db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
      ),
  };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof DomainError && error.code === expected;
function proposal(claim: DraftClaim): PreparedProposal {
  return {
    draft: {
      ...claim.draft,
      intent: "equipment_request",
      phase: "needs_choice",
      missingFields: ["personRef"],
      clarification: {
        kind: "person",
        question: "O którą Anię chodzi?",
        options: [
          { ref: "choice-anna-a", label: "Anna Kowalska", detail: "Operacje" },
          { ref: "choice-anna-b", label: "Anna Kowalska", detail: "Sprzedaż" },
        ],
      },
    },
    message: "Wybierz właściwą osobę.",
    kind: "needs_input",
    state: { profileVersion: 2, creationState: "collecting" },
  };
}

test("one SQLite transaction finalizes draft history, both messages and replay; replay precedes the newer draft CAS", (t) => {
  const f = fixture(t),
    store = f.store(),
    id = f.create(),
    body = { message: "Przygotuj laptop dla Ani" };
  assert.equal(store.get(f.p, id), undefined);
  const claim = store.claim(f.p, id, "message-key-1", body);
  assert.equal(claim.draft.version, 0);
  assert.equal(claim.replay, false);
  store.prepare(claim, proposal(claim));
  const done = store.finish(claim);
  assert.equal(done.version, 1);
  assert.equal(done.phase, "needs_choice");
  assert.equal(f.count("chat_messages"), 2);
  assert.equal(f.count("chat_requests"), 1);
  assert.equal(f.count("assistant_draft_history"), 1);
  assert.deepEqual(store.getState(f.p, id), {
    profileVersion: 2,
    creationState: "collecting",
  });
  assert.equal(store.pending(f.p, id), undefined);
  const replay = f.store(f.open()).claim(f.p, id, "message-key-1", body);
  assert.equal(replay.replay, true);
  assert.equal(replay.turnId, claim.turnId);
  assert.equal(replay.draft.version, 1);
  assert.equal(f.count("chat_messages"), 2);
  assert.throws(
    () =>
      store.claim(f.p, id, "message-key-1", {
        ...body,
        expectedDraftVersion: 1,
      }),
    code("IDEMPOTENCY_CONFLICT"),
  );
  assert.throws(
    () => store.claim(f.p, id, "next-message", { message: "Co dalej?" }),
    code("DRAFT_VERSION_CONFLICT"),
  );
});

test("two database connections fence an active turn, protect other actor conversations, and recover an expired prepared plan after restart", (t) => {
  const f = fixture(t),
    a = f.store(),
    b = f.store(f.open()),
    id = f.create(),
    other = f.create();
  const body = { message: "Przygotuj rezerwację" };
  const claim = a.claim(f.p, id, "request-one", body);
  const prepared = a.prepare(claim, {
    ...proposal(claim),
    draft: {
      ...claim.draft,
      intent: "equipment_request",
      phase: "ready_to_plan",
      missingFields: [],
    },
    kind: "ready",
    message: "Przygotowano zakres rezerwacji.",
    plan: {
      title: "Rezerwacja laptopa",
      summary: "Syntetyczny plan",
      steps: [
        {
          id: "reserve",
          title: "Zarezerwuj laptop",
          toolId: "ops.assets.reserve",
          input: {
            id: randomUUID(),
            personId: randomUUID(),
            expectedVersion: 1,
          },
        },
      ],
    },
  });
  assert.throws(
    () => b.claim(f.p, id, "request-one", body),
    code("TURN_IN_PROGRESS"),
  );
  assert.throws(
    () => b.claim(f.p, id, "request-two", { message: "Inna potrzeba" }),
    code("TURN_RECOVERY_REQUIRED"),
  );
  assert.throws(
    () => b.claim(f.p, other, "other-request", { message: "Inna rozmowa" }),
    code("TURN_IN_PROGRESS"),
  );
  f.advance(1001);
  const otherClaim = b.claim(f.p, other, "other-request", {
    message: "Inna rozmowa",
  });
  b.abandonBeforePlan(otherClaim);
  const recovered = b.claim(f.p, id, "request-one", body);
  assert.equal(recovered.turnId, claim.turnId);
  assert.equal(recovered.engineKey, claim.engineKey);
  assert.notEqual(recovered.token, claim.token);
  assert.deepEqual(recovered.prepared, prepared);
  assert.throws(() => a.finish(claim, randomUUID()), code("TURN_LEASE_LOST"));
  assert.throws(() => b.finish(recovered), code("PLAN_RESULT_REQUIRED"));
  const runId = randomUUID(),
    done = b.finish(recovered, runId);
  assert.equal(done.phase, "planned");
  assert.equal(done.version, 1);
  assert.deepEqual(done.linkedRuns.at(-1), {
    runId,
    status: "planned",
    title: "Rezerwacja laptopa",
  });
  assert.equal(f.count("chat_messages"), 2);
  const fresh = f.store(f.open());
  assert.equal(fresh.claim(f.p, id, "request-one", body).replay, true);
});

test("release keeps exact pending input and sealed proposal for explicit resume; abandonment is permitted only before preparing", (t) => {
  const f = fixture(t),
    store = f.store(),
    id = f.create();
  const first = store.claim(f.p, id, "bad-message-key", {
    message: "Niewłaściwy opis",
  });
  store.abandonBeforePlan(first);
  assert.equal(store.pending(f.p, id), undefined);
  assert.equal(f.count("chat_messages"), 0);
  const claim = store.claim(f.p, id, "good-message-key", {
    message: "Laptop dla Ani",
    expectedDraftVersion: 0,
  });
  store.prepare(claim, proposal(claim));
  assert.throws(
    () => store.abandonBeforePlan(claim),
    code("PREPARED_TURN_CANNOT_BE_ABANDONED"),
  );
  store.release(claim);
  assert.deepEqual(store.pending(f.p, id), {
    message: "Laptop dla Ani",
    expectedDraftVersion: 0,
    idempotencyKey: "good-message-key",
    leaseExpiresAt: "1970-01-01T00:00:00.000Z",
  });
  const resumed = f.store(f.open()).claim(f.p, id, "good-message-key", {
    message: "Laptop dla Ani",
    expectedDraftVersion: 0,
  });
  assert.ok(resumed.prepared);
  assert.throws(() => store.assertCurrent(claim), code("TURN_LEASE_LOST"));
  store.finish(resumed);
});

test("choice ownership, label, body version, claim hashes and prepared data cannot be forged", (t) => {
  const f = fixture(t),
    store = f.store(),
    id = f.create();
  const first = store.claim(f.p, id, "first-message", {
    message: "Laptop dla Ani",
  });
  store.prepare(first, proposal(first));
  store.finish(first);
  assert.throws(
    () =>
      store.claim(f.p, id, "forged-choice", {
        message: "Anna Kowalska",
        choiceRef: "other-conversation-token",
        expectedDraftVersion: 1,
      }),
    code("INVALID_CHOICE"),
  );
  assert.throws(
    () =>
      store.claim(f.p, id, "forged-label", {
        message: "Inna osoba",
        choiceRef: "choice-anna-a",
        expectedDraftVersion: 1,
      }),
    code("INVALID_CHOICE"),
  );
  assert.throws(
    () =>
      store.claim(f.p, id, "old-version", {
        message: "Anna Kowalska",
        choiceRef: "choice-anna-a",
        expectedDraftVersion: 0,
      }),
    code("DRAFT_VERSION_CONFLICT"),
  );
  const second = store.claim(f.p, id, "second-message", {
    message: "Anna Kowalska",
    choiceRef: "choice-anna-a",
    expectedDraftVersion: 1,
  });
  assert.throws(
    () => store.assertCurrent({ ...second, baseHash: "f".repeat(64) }),
    code("TURN_CLAIM_MISMATCH"),
  );
  assert.throws(
    () =>
      store.assertCurrent({
        ...second,
        body: { ...second.body, choiceRef: "choice-anna-b" },
      }),
    code("TURN_CLAIM_MISMATCH"),
  );
  const proposed = proposal(second);
  proposed.draft.scopeHash = "0".repeat(64);
  const sealed = store.prepare(second, proposed);
  assert.notEqual(sealed.draft.scopeHash, "0".repeat(64));
  assert.throws(
    () => store.prepare(second, { ...proposed, message: "Inny plan" }),
    code("PREPARED_PROPOSAL_CHANGED"),
  );
  const tampered = structuredClone(second);
  tampered.prepared!.message = "Wykonałem operację";
  assert.throws(
    () => store.assertCurrent(tampered),
    code("PREPARED_PROPOSAL_CHANGED"),
  );
  assert.equal(store.get(f.p, id)!.version, 1);
});

test("live principal revocation, authority drift, tenant and actor mismatch fail closed, including final commit", (t) => {
  const f = fixture(t),
    store = f.store(),
    id = f.create();
  const unconfigured = new AssistantDraftStore(f.open());
  assert.throws(() => unconfigured.get(f.p, id), code("FORBIDDEN"));
  const stranger: Principal = { ...f.p, id: "operator-b" },
    foreign: Principal = { ...f.p, tenantId: "company-b" };
  f.principals.set("company-a:operator-b", stranger);
  f.principals.set("company-b:operator-a", foreign);
  assert.throws(() => store.get(stranger, id), code("NOT_FOUND"));
  assert.throws(() => store.get(foreign, id), code("NOT_FOUND"));
  const claim = store.claim(f.p, id, "safe-message", {
    message: "Laptop dla Ani",
  });
  store.prepare(claim, proposal(claim));
  f.principals.delete("company-a:operator-a");
  assert.throws(() => store.finish(claim), code("FORBIDDEN"));
  assert.equal(f.count("chat_messages"), 0);
  f.principals.set("company-a:operator-a", { ...f.p, scopes: ["assets"] });
  assert.throws(
    () => store.assertCurrent(claim),
    code("CONVERSATION_AUTHORITY_CHANGED"),
  );
  f.principals.set("company-a:operator-a", f.p);
  let checks = 0;
  store.setPrincipalProvider(() => (++checks === 1 ? f.p : undefined));
  assert.throws(() => store.finish(claim), code("FORBIDDEN"));
  assert.equal(f.count("chat_messages"), 0);
  assert.equal(f.count("assistant_draft_history"), 0);
  store.setPrincipalProvider(f.provider);
  assert.equal(store.get(f.p, id)!.version, 0);
});

test("lease expiration during finalization rolls back messages and draft together", (t) => {
  const f = fixture(t),
    store = f.store(),
    id = f.create();
  const claim = store.claim(f.p, id, "deadline-key", {
    message: "Laptop dla Ani",
  });
  store.prepare(claim, proposal(claim));
  let calls = 0;
  store.setPrincipalProvider(() => {
    if (++calls === 2) f.advance(1001);
    return f.p;
  });
  assert.throws(() => store.finish(claim), code("TURN_LEASE_LOST"));
  assert.equal(f.count("chat_messages"), 0);
  assert.equal(f.count("chat_requests"), 0);
  assert.equal(f.count("assistant_draft_history"), 0);
  store.setPrincipalProvider(f.provider);
  assert.equal(store.get(f.p, id)!.version, 0);
});
