import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  DomainError,
  planSchema,
  type JsonObject,
  type Principal,
} from "./contracts.js";
import { hash } from "./engine.js";
import { migrateDatabase } from "./migrations.js";

const short = z.string().trim().min(1).max(240);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (value) =>
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
  );
const choiceSchema = z
  .object({ ref: short, label: short, detail: z.string().max(1000).optional() })
  .strict();
export const needDraftSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    intent: z.string().min(1).max(80),
    phase: z.enum([
      "collecting",
      "needs_choice",
      "ready_to_plan",
      "planned",
      "awaiting_approval",
      "in_progress",
      "blocked",
      "completed",
      "cancelled",
    ]),
    person: choiceSchema.optional(),
    episode: choiceSchema.optional(),
    asset: choiceSchema.optional(),
    case: choiceSchema.optional(),
    readyOn: date.optional(),
    reservationUntil: z
      .string()
      .max(40)
      .refine((value) => Number.isFinite(Date.parse(value)))
      .optional(),
    assetType: z.enum(["laptop", "phone", "monitor", "other"]).optional(),
    missingFields: z.array(z.string().min(1).max(80)).max(30),
    clarification: z
      .object({
        kind: z.string().min(1).max(80),
        question: z.string().min(1).max(2000),
        options: z.array(choiceSchema).max(5),
        hasNextPage: z.boolean().optional(),
      })
      .strict()
      .optional(),
    linkedRuns: z
      .array(
        z
          .object({
            runId: z.string().uuid(),
            status: z.string().min(1).max(50),
            title: short,
          })
          .strict(),
      )
      .max(100),
    blockedReason: z.string().max(2000).optional(),
    sources: z
      .array(
        z
          .object({
            label: short,
            module: z.string().min(1).max(80),
            version: z.number().int().nonnegative(),
            observedAt: z.string().datetime({ offset: true }),
            updatedAt: z.string().datetime({ offset: true }).optional(),
            freshness: z.enum(["current", "stale", "unavailable"]),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    scopeHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type NeedDraft = z.infer<typeof needDraftSchema>;
export const draftTurnBodySchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    choiceRef: short.optional(),
    expectedDraftVersion: z.number().int().nonnegative().optional(),
  })
  .strict();
export type DraftTurnBody = z.infer<typeof draftTurnBodySchema>;
const proposalSchema = z
  .object({
    draft: needDraftSchema,
    message: z.string().min(1).max(12000),
    kind: z.enum(["answer", "needs_input", "ready", "unsupported"]),
    plan: planSchema.optional(),
    state: z.record(z.string(), z.json()).optional(),
  })
  .strict();
export type PreparedProposal = z.infer<typeof proposalSchema>;
export interface DraftClaim {
  token: string;
  turnId: string;
  conversationId: string;
  engineKey: string;
  principal: Principal;
  baseVersion: number;
  baseHash: string;
  inputHash: string;
  body: DraftTurnBody;
  draft: NeedDraft;
  state: JsonObject;
  prepared?: PreparedProposal;
  replay: boolean;
}
type Row = Record<string, unknown>;
function fault(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
export const conversationAuthority = (p: Principal) =>
  hash({ roles: [...p.roles].sort(), scopes: [...(p.scopes ?? [])].sort() });
const engineKey = (id: string) => `assistant:${id}`;
const boundedJson = (value: unknown, max = 256 * 1024) => {
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > max)
    fault("DRAFT_TOO_LARGE", "Szkic przekracza dopuszczalny rozmiar.", 400);
  return result;
};

/** Owns leases and private proposals; Core still owns plan execution and authorization. */
export class AssistantDraftStore {
  private provider?: (
    tenantId: string,
    actorId: string,
  ) => Principal | undefined;
  private clock: () => number;
  private leaseMs: number;
  constructor(
    private db: DatabaseSync,
    options: { clock?: () => number; leaseMs?: number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.leaseMs = options.leaseMs ?? 60_000;
    if (
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 100 ||
      this.leaseMs > 300_000
    )
      throw Error("Invalid assistant lease duration.");
    this.db
      .prepare(
        "SELECT id,tenant_id,actor_id,authority_hash FROM conversations LIMIT 0",
      )
      .all();
    migrateDatabase(db, {
      namespace: "assistant_work",
      migrations: [
        {
          version: 1,
          name: "durable drafts and fenced conversation turns",
          up: (db) =>
            db.exec(`
      CREATE TABLE assistant_need_drafts(conversation_id TEXT PRIMARY KEY,draft_json TEXT NOT NULL,state_json TEXT NOT NULL,version INTEGER NOT NULL,draft_hash TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE assistant_draft_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,authority_hash TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,input_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('pending','completed','abandoned')),base_version INTEGER NOT NULL,base_hash TEXT NOT NULL,proposal_json TEXT,proposal_hash TEXT,lease_token_hash TEXT NOT NULL,lease_expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,run_id TEXT,UNIQUE(conversation_id,request_key));
      CREATE UNIQUE INDEX assistant_one_pending_turn ON assistant_draft_turns(conversation_id) WHERE status='pending';
      CREATE INDEX assistant_active_actor_turns ON assistant_draft_turns(tenant_id,actor_id,status,lease_expires_at);
      CREATE TABLE assistant_draft_history(conversation_id TEXT NOT NULL,version INTEGER NOT NULL,draft_json TEXT NOT NULL,state_json TEXT NOT NULL,turn_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(conversation_id,version));
    `),
        },
      ],
    });
  }
  setPrincipalProvider(
    provider: (tenantId: string, actorId: string) => Principal | undefined,
  ) {
    this.provider = provider;
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private row(p: Principal, conversationId: string): Row {
    const live = this.provider?.(p.tenantId, p.id);
    if (
      !live ||
      live.id !== p.id ||
      live.tenantId !== p.tenantId ||
      !live.roles.includes("operator")
    )
      fault("FORBIDDEN", "Brak aktualnego uprawnienia do rozmowy.", 403);
    if (conversationAuthority(live) !== conversationAuthority(p))
      fault(
        "CONVERSATION_AUTHORITY_CHANGED",
        "Uprawnienia zmieniły się. Rozpocznij nową rozmowę.",
        403,
      );
    const row = this.db
      .prepare(
        "SELECT * FROM conversations WHERE id=? AND tenant_id=? AND actor_id=?",
      )
      .get(conversationId, p.tenantId, p.id) as Row | undefined;
    if (!row) fault("NOT_FOUND", "Nie znaleziono rozmowy.", 404);
    if (row.authority_hash !== conversationAuthority(live))
      fault(
        "CONVERSATION_AUTHORITY_CHANGED",
        "Uprawnienia zmieniły się. Rozpocznij nową rozmowę.",
        403,
      );
    return row;
  }
  private stored(conversationId: string): Row | undefined {
    return this.db
      .prepare("SELECT * FROM assistant_need_drafts WHERE conversation_id=?")
      .get(conversationId) as Row | undefined;
  }
  get(p: Principal, conversationId: string): NeedDraft | undefined {
    this.row(p, conversationId);
    const row = this.stored(conversationId);
    return row
      ? needDraftSchema.parse(JSON.parse(String(row.draft_json)))
      : undefined;
  }
  getState(p: Principal, conversationId: string): JsonObject {
    this.row(p, conversationId);
    const row = this.stored(conversationId);
    return row ? (JSON.parse(String(row.state_json)) as JsonObject) : {};
  }
  private initial(): NeedDraft {
    return {
      id: randomUUID(),
      version: 0,
      intent: "unknown",
      phase: "collecting",
      missingFields: [],
      linkedRuns: [],
    };
  }
  private currentDraft(conversationId: string): NeedDraft {
    const row = this.stored(conversationId);
    if (!row) fault("DRAFT_NOT_FOUND", "Nie znaleziono szkicu.");
    return needDraftSchema.parse(JSON.parse(String(row.draft_json)));
  }
  private claimView(
    row: Row,
    p: Principal,
    token: string,
    replay: boolean,
  ): DraftClaim {
    return {
      token,
      turnId: String(row.id),
      conversationId: String(row.conversation_id),
      engineKey: engineKey(String(row.id)),
      principal: structuredClone(p),
      baseVersion: Number(row.base_version),
      baseHash: String(row.base_hash),
      inputHash: String(row.input_hash),
      body: JSON.parse(String(row.input_json)) as DraftTurnBody,
      draft: this.currentDraft(String(row.conversation_id)),
      state: this.getState(p, String(row.conversation_id)),
      ...(row.proposal_json
        ? {
            prepared: proposalSchema.parse(
              JSON.parse(String(row.proposal_json)),
            ),
          }
        : {}),
      replay,
    };
  }
  claim(
    p: Principal,
    conversationId: string,
    key: string,
    body: DraftTurnBody,
  ): DraftClaim {
    const input = draftTurnBodySchema.parse(body);
    if (!/^[a-zA-Z0-9_:.-]{8,128}$/.test(key))
      fault("INVALID_MESSAGE", "Niepoprawny klucz wiadomości.", 400);
    const inputHash = hash(input);
    return this.transaction(() => {
      this.row(p, conversationId);
      const now = this.clock(),
        stamp = new Date(now).toISOString();
      const old = this.db
        .prepare(
          "SELECT * FROM assistant_draft_turns WHERE conversation_id=? AND request_key=?",
        )
        .get(conversationId, key) as Row | undefined;
      if (old) {
        if (old.input_hash !== inputHash)
          fault(
            "IDEMPOTENCY_CONFLICT",
            "Klucz wiadomości wykorzystano do innej treści, wyboru lub wersji.",
          );
        if (old.status === "completed") return this.claimView(old, p, "", true);
        if (old.status === "abandoned")
          fault(
            "TURN_ABANDONED",
            "Ta próba została zakończona bez propozycji. Użyj nowego klucza wiadomości.",
          );
        if (Number(old.lease_expires_at) > now)
          fault("TURN_IN_PROGRESS", "Ta wiadomość jest jeszcze przetwarzana.");
      } else {
        const legacy = this.db
          .prepare(
            "SELECT input_hash,status FROM chat_requests WHERE conversation_id=? AND request_key=?",
          )
          .get(conversationId, key) as Row | undefined;
        if (legacy) {
          if (
            input.choiceRef ||
            input.expectedDraftVersion !== undefined ||
            legacy.input_hash !== hash(input.message) ||
            legacy.status !== "completed"
          )
            fault(
              "IDEMPOTENCY_CONFLICT",
              "Klucz należy do wcześniejszej wiadomości o innym zakresie.",
            );
          const draft = this.stored(conversationId)
            ? this.currentDraft(conversationId)
            : this.initial();
          const turnId = `legacy:${hash({ conversationId, key })}`;
          return {
            token: "",
            turnId,
            conversationId,
            engineKey: engineKey(turnId),
            principal: structuredClone(p),
            baseVersion: draft.version,
            baseHash: hash(draft),
            inputHash,
            body: input,
            draft,
            state: {},
            replay: true,
          };
        }
        const pending = this.db
          .prepare(
            "SELECT id FROM assistant_draft_turns WHERE conversation_id=? AND status='pending'",
          )
          .get(conversationId);
        if (pending)
          fault(
            "TURN_RECOVERY_REQUIRED",
            "Dokończ poprzednią wiadomość przed wysłaniem nowej.",
          );
      }
      const active = this.db
        .prepare(
          "SELECT id FROM assistant_draft_turns WHERE tenant_id=? AND actor_id=? AND status='pending' AND lease_expires_at>? AND id!=? LIMIT 1",
        )
        .get(p.tenantId, p.id, now, old ? String(old.id) : "");
      if (active)
        fault(
          "TURN_IN_PROGRESS",
          "Zaczekaj na odpowiedź w poprzedniej rozmowie.",
        );
      let stored = this.stored(conversationId);
      if (!old) {
        const version = stored ? Number(stored.version) : 0;
        if (
          (stored && input.expectedDraftVersion !== version) ||
          (!stored &&
            input.expectedDraftVersion !== undefined &&
            input.expectedDraftVersion !== 0)
        )
          fault(
            "DRAFT_VERSION_CONFLICT",
            "Szkic zmienił się. Odczytaj bieżącą wersję przed kolejną wiadomością.",
          );
        if (input.choiceRef) {
          const draft = stored ? this.currentDraft(conversationId) : undefined;
          const selected = draft?.clarification?.options.find(
            (option) => option.ref === input.choiceRef,
          );
          if (!selected || selected.label !== input.message)
            fault(
              "INVALID_CHOICE",
              "Wybierz jeden z bieżących wariantów tej rozmowy.",
            );
        }
      }
      if (!stored) {
        const draft = this.initial(),
          json = boundedJson(draft);
        this.db
          .prepare(
            "INSERT INTO assistant_need_drafts(conversation_id,draft_json,state_json,version,draft_hash,updated_at) VALUES(?,?,?,0,?,?)",
          )
          .run(conversationId, json, "{}", hash(draft), stamp);
        stored = this.stored(conversationId)!;
      }
      if (
        old &&
        (Number(stored.version) !== Number(old.base_version) ||
          stored.draft_hash !== old.base_hash)
      )
        fault(
          "DRAFT_VERSION_CONFLICT",
          "Zakres szkicu zmienił się od przygotowania tej wiadomości.",
        );
      const token = randomBytes(32).toString("hex"),
        turnId = old ? String(old.id) : randomUUID();
      if (old)
        this.db
          .prepare(
            "UPDATE assistant_draft_turns SET lease_token_hash=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='pending'",
          )
          .run(hash(token), now + this.leaseMs, stamp, turnId);
      else
        this.db
          .prepare(
            "INSERT INTO assistant_draft_turns(id,conversation_id,tenant_id,actor_id,authority_hash,request_key,input_hash,input_json,status,base_version,base_hash,lease_token_hash,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?,?,?,?)",
          )
          .run(
            turnId,
            conversationId,
            p.tenantId,
            p.id,
            conversationAuthority(p),
            key,
            inputHash,
            boundedJson(input),
            Number(stored.version),
            String(stored.draft_hash),
            hash(token),
            now + this.leaseMs,
            stamp,
            stamp,
          );
      return this.claimView(
        this.db
          .prepare("SELECT * FROM assistant_draft_turns WHERE id=?")
          .get(turnId) as Row,
        p,
        token,
        false,
      );
    });
  }
  private validateClaim(claim: DraftClaim): Row {
    if (claim.replay)
      fault("TURN_REPLAY", "Ta wiadomość ma już zapisany wynik.");
    this.row(claim.principal, claim.conversationId);
    const row = this.db
      .prepare("SELECT * FROM assistant_draft_turns WHERE id=?")
      .get(claim.turnId) as Row | undefined;
    if (
      !row ||
      row.status !== "pending" ||
      row.conversation_id !== claim.conversationId ||
      row.tenant_id !== claim.principal.tenantId ||
      row.actor_id !== claim.principal.id ||
      row.authority_hash !== conversationAuthority(claim.principal) ||
      row.lease_token_hash !== hash(claim.token) ||
      Number(row.lease_expires_at) <= this.clock()
    )
      fault(
        "TURN_LEASE_LOST",
        "Ta próba utraciła prawo do zapisu. Wznów wiadomość z bieżącego stanu.",
      );
    if (
      claim.engineKey !== engineKey(String(row.id)) ||
      claim.baseVersion !== Number(row.base_version) ||
      claim.baseHash !== row.base_hash ||
      claim.inputHash !== row.input_hash ||
      hash(claim.body) !== row.input_hash
    )
      fault(
        "TURN_CLAIM_MISMATCH",
        "Zakres próby nie odpowiada zapisanej wiadomości.",
      );
    const draft = this.stored(claim.conversationId);
    if (
      !draft ||
      Number(draft.version) !== Number(row.base_version) ||
      draft.draft_hash !== row.base_hash
    )
      fault(
        "DRAFT_VERSION_CONFLICT",
        "Bieżący szkic nie odpowiada wersji tej próby.",
      );
    if (
      claim.prepared &&
      (!row.proposal_hash || hash(claim.prepared) !== row.proposal_hash)
    )
      fault(
        "PREPARED_PROPOSAL_CHANGED",
        "Przygotowana propozycja różni się od zapisanego zakresu.",
      );
    return row;
  }
  assertCurrent(claim: DraftClaim): void {
    this.validateClaim(claim);
  }
  prepare(claim: DraftClaim, proposal: PreparedProposal): PreparedProposal {
    return this.transaction(() => {
      const row = this.validateClaim(claim),
        parsed = proposalSchema.parse(proposal);
      const original = this.currentDraft(claim.conversationId);
      if (
        parsed.draft.id !== original.id ||
        parsed.draft.version !== Number(row.base_version)
      )
        fault(
          "DRAFT_VERSION_CONFLICT",
          "Propozycja musi dotyczyć bieżącego szkicu i jego wersji.",
        );
      // Scope is derived from concrete selections and expectations, never a model's claimed hash.
      parsed.draft.scopeHash = hash({
        intent: parsed.draft.intent,
        person: parsed.draft.person?.ref ?? null,
        episode: parsed.draft.episode?.ref ?? null,
        asset: parsed.draft.asset?.ref ?? null,
        case: parsed.draft.case?.ref ?? null,
        readyOn: parsed.draft.readyOn ?? null,
        reservationUntil: parsed.draft.reservationUntil ?? null,
        assetType: parsed.draft.assetType ?? null,
      });
      const json = boundedJson(parsed),
        proposalHash = hash(parsed);
      if (row.proposal_json && row.proposal_hash !== proposalHash)
        fault(
          "PREPARED_PROPOSAL_CHANGED",
          "Ta wiadomość ma już inną zapisaną propozycję.",
        );
      if (!row.proposal_json)
        this.db
          .prepare(
            "UPDATE assistant_draft_turns SET proposal_json=?,proposal_hash=?,updated_at=? WHERE id=?",
          )
          .run(
            json,
            proposalHash,
            new Date(this.clock()).toISOString(),
            claim.turnId,
          );
      claim.prepared = structuredClone(parsed);
      return structuredClone(parsed);
    });
  }
  finish(claim: DraftClaim, runId?: string): NeedDraft {
    return this.transaction(() => {
      const row = this.validateClaim(claim);
      if (!row.proposal_json)
        fault(
          "PROPOSAL_REQUIRED",
          "Zapisz propozycję przed zakończeniem wiadomości.",
        );
      const prepared = proposalSchema.parse(
        JSON.parse(String(row.proposal_json)),
      );
      if (Boolean(prepared.plan) !== Boolean(runId))
        fault(
          "PLAN_RESULT_REQUIRED",
          "Wynik przygotowania planu nie odpowiada zapisanej propozycji.",
        );
      if (runId && !z.string().uuid().safeParse(runId).success)
        fault("INVALID_RUN", "Niepoprawny identyfikator wykonania.", 400);
      const next: NeedDraft = {
        ...prepared.draft,
        version: Number(row.base_version) + 1,
      };
      if (runId && prepared.plan) {
        next.phase = "planned";
        next.linkedRuns = [
          ...next.linkedRuns.filter((run) => run.runId !== runId),
          { runId, status: "planned", title: prepared.plan.title },
        ].slice(-100);
      }
      const parsed = needDraftSchema.parse(next),
        json = boundedJson(parsed),
        stateJson = boundedJson(
          prepared.state ??
            this.getState(claim.principal, claim.conversationId),
          64 * 1024,
        ),
        now = new Date(this.clock()).toISOString();
      const changed = this.db
        .prepare(
          "UPDATE assistant_need_drafts SET draft_json=?,state_json=?,version=?,draft_hash=?,updated_at=? WHERE conversation_id=? AND version=? AND draft_hash=?",
        )
        .run(
          json,
          stateJson,
          parsed.version,
          hash(parsed),
          now,
          claim.conversationId,
          Number(row.base_version),
          String(row.base_hash),
        );
      if (changed.changes !== 1)
        fault("DRAFT_VERSION_CONFLICT", "Inna próba zmieniła szkic.");
      this.db
        .prepare(
          "INSERT INTO assistant_draft_history(conversation_id,version,draft_json,state_json,turn_id,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          claim.conversationId,
          parsed.version,
          json,
          stateJson,
          claim.turnId,
          now,
        );
      const message = this.db.prepare(
        "INSERT INTO chat_messages(id,conversation_id,role,content,kind,run_id,created_at) VALUES(?,?,?,?,?,?,?)",
      );
      message.run(
        randomUUID(),
        claim.conversationId,
        "user",
        claim.body.message,
        null,
        null,
        now,
      );
      message.run(
        randomUUID(),
        claim.conversationId,
        "assistant",
        prepared.message,
        prepared.kind,
        runId ?? null,
        now,
      );
      this.db
        .prepare(
          "INSERT INTO chat_requests(conversation_id,request_key,input_hash,status) VALUES(?,?,?,'completed')",
        )
        .run(
          claim.conversationId,
          String(row.request_key),
          String(row.input_hash),
        );
      this.db
        .prepare(
          "UPDATE conversations SET title=CASE WHEN title='Nowa rozmowa' THEN ? ELSE title END,updated_at=? WHERE id=?",
        )
        .run(claim.body.message.slice(0, 100), now, claim.conversationId);
      // Authority may live in a separate accounts DB; check it again at commit.
      this.row(claim.principal, claim.conversationId);
      if (Number(row.lease_expires_at) <= this.clock())
        fault(
          "TURN_LEASE_LOST",
          "Próba utraciła prawo do finalnego zapisu. Wznów wiadomość.",
        );
      this.db
        .prepare(
          "UPDATE assistant_draft_turns SET status='completed',run_id=?,lease_token_hash='',lease_expires_at=0,updated_at=? WHERE id=?",
        )
        .run(runId ?? null, now, claim.turnId);
      return parsed;
    });
  }
  release(claim: DraftClaim): void {
    this.transaction(() => {
      this.validateClaim(claim);
      this.db
        .prepare(
          "UPDATE assistant_draft_turns SET lease_token_hash='',lease_expires_at=0,updated_at=? WHERE id=?",
        )
        .run(new Date(this.clock()).toISOString(), claim.turnId);
    });
  }
  abandonBeforePlan(claim: DraftClaim): void {
    this.transaction(() => {
      const row = this.validateClaim(claim);
      if (row.proposal_json)
        fault(
          "PREPARED_TURN_CANNOT_BE_ABANDONED",
          "Zapisana propozycja może mieć już powiązane wykonanie. Wznów i uzgodnij jej wynik.",
        );
      this.db
        .prepare(
          "UPDATE assistant_draft_turns SET status='abandoned',lease_token_hash='',lease_expires_at=0,updated_at=? WHERE id=?",
        )
        .run(new Date(this.clock()).toISOString(), claim.turnId);
    });
  }
  pending(
    p: Principal,
    conversationId: string,
  ):
    | (DraftTurnBody & { idempotencyKey: string; leaseExpiresAt: string })
    | undefined {
    this.row(p, conversationId);
    const row = this.db
      .prepare(
        "SELECT input_json,request_key,lease_expires_at FROM assistant_draft_turns WHERE conversation_id=? AND status='pending'",
      )
      .get(conversationId) as Row | undefined;
    return row
      ? {
          ...draftTurnBodySchema.parse(JSON.parse(String(row.input_json))),
          idempotencyKey: String(row.request_key),
          leaseExpiresAt: new Date(Number(row.lease_expires_at)).toISOString(),
        }
      : undefined;
  }
}
