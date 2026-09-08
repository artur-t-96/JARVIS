import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrateDatabase } from "./migrations.js";
import {
  DomainError,
  hasToolAccess,
  planSchema,
  type Evidence,
  type Json,
  type JsonObject,
  type Plan,
  type Policy,
  type Principal,
  type RunStatus,
  type StepStatus,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  type Verification,
} from "./contracts.js";

export function canonical(value: unknown): string {
  if (value === undefined)
    throw new DomainError("INVALID_JSON", "Wartość nie jest poprawnym JSON.");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export interface ApprovalDetail {
  id: string;
  status: string;
  bindingHash: string;
  requestedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
}
export interface StepDetail {
  id: string;
  title: string;
  toolId: string;
  input: JsonObject;
  status: StepStatus;
  attempts: number;
  output: ToolResult | null;
  verification: Verification | null;
  error: string | null;
  approval: ApprovalDetail | null;
}
export interface RunDetail {
  id: string;
  tenantId: string;
  requestedBy: string;
  title: string;
  request: string;
  status: RunStatus;
  plan: Plan;
  planHash: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
  cancellationRequested: boolean;
  steps: StepDetail[];
  events: {
    id: number;
    type: string;
    createdAt: string;
    details: JsonObject;
  }[];
}
interface EngineOptions {
  dbPath: string;
  tools: ToolDefinition[];
  policies: Policy[];
  principals: Principal[];
  clock?: () => number;
  leaseMs?: number;
  maxAttempts?: number;
  workerId?: string;
  onEvent?: (event: string, details: JsonObject) => void;
}

export class Engine {
  private db: DatabaseSync;
  private tools: Map<string, ToolDefinition>;
  private policies: Map<string, Policy>;
  private principals: Map<string, Principal>;
  private clock: () => number;
  private leaseMs: number;
  private maxAttempts: number;
  private workerId: string;
  private busy = false;
  private closed = false;
  private onEvent?: (event: string, details: JsonObject) => void;
  constructor(options: EngineOptions) {
    if (options.dbPath !== ":memory:")
      mkdirSync(dirname(options.dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(options.dbPath);
    // Rollback journal is deliberate: one host, short transactions, full durability.
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;",
    );
    this.onEvent = options.onEvent;
    migrateDatabase(this.db, {
      namespace: "core",
      migrations: [
        {
          version: 1,
          name: "durable execution core",
          up: (db) =>
            db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, requested_by TEXT NOT NULL,
        title TEXT NOT NULL, request TEXT NOT NULL, plan_json TEXT NOT NULL, plan_hash TEXT NOT NULL,
        policy_version TEXT NOT NULL, policy_hash TEXT NOT NULL, tool_versions TEXT NOT NULL,
        status TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        cancellation_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS steps (
        run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        title TEXT NOT NULL, tool_id TEXT NOT NULL, input_json TEXT NOT NULL, resolved_input TEXT,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, operation_key TEXT NOT NULL UNIQUE,
        lease_token TEXT, lease_until INTEGER, output_json TEXT, verification_json TEXT, error TEXT,
        PRIMARY KEY(run_id,id), UNIQUE(run_id,ordinal)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_id TEXT NOT NULL, binding_hash TEXT NOT NULL,
        status TEXT NOT NULL, requested_at TEXT NOT NULL, decided_by TEXT, decided_at TEXT,
        FOREIGN KEY(run_id,step_id) REFERENCES steps(run_id,id), UNIQUE(run_id,step_id,binding_hash)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id),
        type TEXT NOT NULL, created_at TEXT NOT NULL, details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_tenant_created ON runs(tenant_id,created_at);
      CREATE INDEX IF NOT EXISTS steps_status ON steps(status,lease_until);
    `),
        },
        {
          version: 2,
          name: "execution history indexes",
          up: (db) =>
            db.exec(
              "CREATE INDEX IF NOT EXISTS events_run_id ON events(run_id,id); CREATE INDEX IF NOT EXISTS runs_status_updated ON runs(status,updated_at);",
            ),
        },
        {
          version: 3,
          name: "requester authority snapshot",
          up: (db) =>
            db.exec("ALTER TABLE runs ADD COLUMN requester_authority TEXT;"),
        },
      ],
    });
    this.tools = new Map(options.tools.map((t) => [t.id, t]));
    if (this.tools.size !== options.tools.length)
      throw new Error("Duplicate tool registration");
    this.policies = new Map(options.policies.map((p) => [p.tenantId, p]));
    this.principals = new Map(
      options.principals.map((p) => [`${p.tenantId}:${p.id}`, p]),
    );
    this.clock = options.clock ?? Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.workerId = options.workerId ?? randomUUID();
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private event(runId: string, type: string, details: JsonObject = {}) {
    this.db
      .prepare(
        "INSERT INTO events(run_id,type,created_at,details_json) VALUES(?,?,?,?)",
      )
      .run(runId, type, this.now(), canonical(details));
    try {
      this.onEvent?.(type, { runId, ...details });
    } catch {
      /* diagnostics must not interrupt effects */
    }
  }
  private actor(principal: Principal, role?: "operator" | "approver") {
    const configured = this.principals.get(
      `${principal.tenantId}:${principal.id}`,
    );
    if (!configured || (role && !configured.roles.includes(role)))
      throw new DomainError(
        "FORBIDDEN",
        "Brak uprawnienia do tej operacji.",
        403,
      );
    return configured;
  }
  setPrincipals(principals: Principal[]) {
    this.principals = new Map(
      principals.map((p) => [`${p.tenantId}:${p.id}`, p]),
    );
  }
  private canUse(
    principal: Principal,
    tool: ToolDefinition,
    input?: JsonObject,
  ) {
    return hasToolAccess(principal, tool, input);
  }
  private policy(tenantId: string) {
    const policy = this.policies.get(tenantId);
    if (!policy)
      throw new DomainError("FORBIDDEN", "Brak konfiguracji firmy.", 403);
    return policy;
  }
  private runRow(principal: Principal, id: string): Row {
    const actor = this.actor(principal);
    const run = this.db
      .prepare("SELECT * FROM runs WHERE id=? AND tenant_id=?")
      .get(id, principal.tenantId) as Row | undefined;
    if (!run)
      throw new DomainError("NOT_FOUND", "Nie znaleziono zadania.", 404);
    const plan = parse<Plan>(run.plan_json);
    if (
      plan.steps.some((step) => {
        const tool = this.tools.get(step.toolId);
        if (!tool) return true;
        const persisted = this.db
          .prepare("SELECT resolved_input FROM steps WHERE run_id=? AND id=?")
          .get(String(run.id), step.id) as Row | undefined;
        if (persisted?.resolved_input)
          return !this.canUse(
            actor,
            tool,
            parse<JsonObject>(persisted.resolved_input),
          );
        if (this.hasRefs(step.input))
          return (
            Boolean(
              tool.requiredScopesForInput &&
              !actor.scopes?.includes("*") &&
              !(
                run.requested_by === actor.id &&
                run.requester_authority ===
                  hash({
                    roles: [...actor.roles].sort(),
                    scopes: [...(actor.scopes ?? [])].sort(),
                  })
              ),
            ) || !this.canUse(actor, tool)
          );
        return !this.canUse(actor, tool, step.input);
      })
    )
      throw new DomainError(
        "FORBIDDEN",
        "Brak dostępu do obszaru tej sprawy.",
        403,
      );
    return run;
  }
  private setStatus(id: string, status: RunStatus) {
    this.db
      .prepare("UPDATE runs SET status=?,updated_at=? WHERE id=?")
      .run(status, this.now(), id);
  }
  createRun(
    principal: Principal,
    request: string,
    inputPlan: Plan,
    idempotencyKey: string,
  ): RunDetail {
    const actor = this.actor(principal, "operator");
    const policy = this.policy(actor.tenantId);
    if (
      !request.trim() ||
      request.length > 4000 ||
      !/^[a-zA-Z0-9_:.-]{8,128}$/.test(idempotencyKey)
    ) {
      throw new DomainError(
        "INVALID_REQUEST",
        "Podaj zadanie i poprawny klucz żądania.",
      );
    }
    const plan = planSchema.parse(inputPlan);
    const seen = new Set<string>();
    const versions: Record<string, string> = {};
    for (const step of plan.steps) {
      if (seen.has(step.id))
        throw new DomainError(
          "INVALID_PLAN",
          "Identyfikatory kroków muszą być unikalne.",
        );
      const tool = this.tools.get(step.toolId);
      if (
        !tool ||
        !policy.allowedTools.includes(tool.id) ||
        !this.canUse(actor, tool)
      )
        throw new DomainError(
          "FORBIDDEN_TOOL",
          "Plan zawiera niedozwoloną operację.",
          403,
        );
      this.validateRefs(step.input, seen);
      if (tool.prepareInput) {
        step.input = tool.prepareInput(step.input, actor.tenantId);
        this.validateRefs(step.input, seen);
      }
      if (!this.hasRefs(step.input)) {
        tool.inputSchema.parse(step.input);
        if (!this.canUse(actor, tool, step.input))
          throw new DomainError(
            "FORBIDDEN_TOOL",
            "Brak dostępu do danych operacji.",
            403,
          );
      }
      seen.add(step.id);
      versions[tool.id] = tool.version;
    }
    const requestHash = hash({ request, plan, actor: actor.id });
    const id = this.tx(() => {
      const existing = this.db
        .prepare(
          "SELECT id,request_hash FROM runs WHERE tenant_id=? AND idempotency_key=?",
        )
        .get(actor.tenantId, idempotencyKey) as Row | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash)
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Klucz został już użyty dla innego zadania.",
            409,
          );
        return String(existing.id);
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO runs(id,tenant_id,requested_by,title,request,plan_json,plan_hash,policy_version,policy_hash,tool_versions,status,idempotency_key,request_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          actor.tenantId,
          actor.id,
          plan.title,
          request,
          canonical(plan),
          hash(plan),
          policy.version,
          hash(policy),
          canonical(versions),
          "planned",
          idempotencyKey,
          requestHash,
          this.now(),
          this.now(),
        );
      this.db.prepare("UPDATE runs SET requester_authority=? WHERE id=?").run(
        hash({
          roles: [...actor.roles].sort(),
          scopes: [...(actor.scopes ?? [])].sort(),
        }),
        id,
      );
      plan.steps.forEach((step, i) =>
        this.db
          .prepare(
            "INSERT INTO steps(run_id,id,ordinal,title,tool_id,input_json,status,operation_key) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            id,
            step.id,
            i,
            step.title,
            step.toolId,
            canonical(step.input),
            "pending",
            hash({ tenant: actor.tenantId, run: id, step: step.id }),
          ),
      );
      this.event(id, "plan_created", {
        actor: actor.id,
        planHash: hash(plan),
        policyVersion: policy.version,
      });
      return id;
    });
    return this.getRun(actor, id);
  }
  private validateRefs(value: unknown, previous: Set<string>) {
    if (!value || typeof value !== "object") return;
    if ("$step" in value) {
      const ref = value as Record<string, unknown>;
      if (
        typeof ref.$step !== "string" ||
        !previous.has(ref.$step) ||
        typeof ref.path !== "string" ||
        !/^[a-zA-Z0-9_.]+$/.test(ref.path) ||
        Object.keys(ref).length !== 2
      ) {
        throw new DomainError(
          "INVALID_REFERENCE",
          "Referencja musi wskazywać wcześniejszy krok.",
        );
      }
      return;
    }
    for (const v of Object.values(value)) this.validateRefs(v, previous);
  }
  private hasRefs(value: unknown): boolean {
    return (
      !!value &&
      typeof value === "object" &&
      ("$step" in value || Object.values(value).some((v) => this.hasRefs(v)))
    );
  }
  private resolve(runId: string, value: Json): Json {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((v) => this.resolve(runId, v));
    if ("$step" in value) {
      const prior = this.db
        .prepare(
          "SELECT output_json FROM steps WHERE run_id=? AND id=? AND status='succeeded'",
        )
        .get(runId, String(value.$step)) as Row | undefined;
      if (!prior)
        throw new DomainError(
          "MISSING_REFERENCE",
          "Brak potwierdzonego wyniku wcześniejszego kroku.",
        );
      let result: unknown = parse<ToolResult>(prior.output_json).data;
      for (const part of String(value.path).split(".")) {
        if (
          !result ||
          typeof result !== "object" ||
          !Object.hasOwn(result, part) ||
          ["__proto__", "constructor", "prototype"].includes(part)
        )
          throw new DomainError(
            "MISSING_REFERENCE",
            "Brak wymaganej wartości źródłowej.",
          );
        result = (result as Record<string, unknown>)[part];
      }
      return result as Json;
    }
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, this.resolve(runId, v)]),
    );
  }
  getRun(principal: Principal, id: string): RunDetail {
    const r = this.runRow(principal, id);
    const steps = (
      this.db
        .prepare("SELECT * FROM steps WHERE run_id=? ORDER BY ordinal")
        .all(id) as Row[]
    ).map((s) => {
      const a = this.db
        .prepare(
          "SELECT * FROM approvals WHERE run_id=? AND step_id=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(id, String(s.id)) as Row | undefined;
      return {
        id: String(s.id),
        title: String(s.title),
        toolId: String(s.tool_id),
        input: parse<JsonObject>(s.resolved_input ?? s.input_json),
        status: s.status as StepStatus,
        attempts: Number(s.attempts),
        output: s.output_json ? parse<ToolResult>(s.output_json) : null,
        verification: s.verification_json
          ? parse<Verification>(s.verification_json)
          : null,
        error: s.error ? String(s.error) : null,
        approval: a
          ? {
              id: String(a.id),
              status: String(a.status),
              bindingHash: String(a.binding_hash),
              requestedAt: String(a.requested_at),
              decidedBy: a.decided_by ? String(a.decided_by) : null,
              decidedAt: a.decided_at ? String(a.decided_at) : null,
            }
          : null,
      };
    });
    return {
      id: String(r.id),
      tenantId: String(r.tenant_id),
      requestedBy: String(r.requested_by),
      title: String(r.title),
      request: String(r.request),
      status: r.status as RunStatus,
      plan: parse<Plan>(r.plan_json),
      planHash: String(r.plan_hash),
      policyVersion: String(r.policy_version),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      cancellationRequested: Boolean(r.cancellation_requested),
      steps,
      events: (
        this.db
          .prepare("SELECT * FROM events WHERE run_id=? ORDER BY id")
          .all(id) as Row[]
      ).map((e) => ({
        id: Number(e.id),
        type: String(e.type),
        createdAt: String(e.created_at),
        details: parse<JsonObject>(e.details_json),
      })),
    };
  }
  listRuns(
    principal: Principal,
    options: { limit?: number; offset?: number } = {},
  ) {
    this.actor(principal);
    return (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE tenant_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
        )
        .all(
          principal.tenantId,
          Math.max(1, Math.min(100, options.limit ?? 50)),
          Math.max(0, options.offset ?? 0),
        ) as Row[]
    ).flatMap((r) => {
      try {
        return [this.getRun(principal, String(r.id))];
      } catch (e) {
        if (e instanceof DomainError && e.statusCode === 403) return [];
        throw e;
      }
    });
  }
  replayRun(
    principal: Principal,
    request: string,
    idempotencyKey: string,
  ): RunDetail | null {
    this.actor(principal, "operator");
    const row = this.db
      .prepare(
        "SELECT id,request,requested_by FROM runs WHERE tenant_id=? AND idempotency_key=?",
      )
      .get(principal.tenantId, idempotencyKey) as Row | undefined;
    if (!row) return null;
    if (row.request !== request || row.requested_by !== principal.id)
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Klucz został już użyty dla innego zadania.",
        409,
      );
    return this.getRun(principal, String(row.id));
  }
  start(principal: Principal, id: string) {
    this.actor(principal, "operator");
    this.tx(() => {
      const run = this.runRow(principal, id);
      if (run.status !== "planned") return;
      this.checkPolicy(run);
      this.setStatus(id, "running");
      this.event(id, "run_started", { actor: principal.id });
    });
    return this.getRun(principal, id);
  }
  private checkPolicy(run: Row, tool?: ToolDefinition) {
    const policy = this.policy(String(run.tenant_id));
    const requester = this.principals.get(
      `${run.tenant_id}:${run.requested_by}`,
    );
    if (!requester?.roles.includes("operator"))
      throw new DomainError(
        "AUTHORITY_REVOKED",
        "Zleceniodawca utracił uprawnienia.",
        403,
      );
    if (
      hash(policy) !== run.policy_hash ||
      policy.version !== run.policy_version
    )
      throw new DomainError(
        "POLICY_CHANGED",
        "Zasady zmieniły się. Przygotuj nowy plan.",
        409,
      );
    if (
      tool &&
      (!policy.allowedTools.includes(tool.id) ||
        !this.canUse(requester, tool) ||
        parse<Record<string, string>>(run.tool_versions)[tool.id] !==
          tool.version)
    )
      throw new DomainError(
        "TOOL_CHANGED",
        "Operacja lub jej uprawnienia zmieniły się.",
        409,
      );
    return policy;
  }
  private binding(
    run: Row,
    step: Row,
    tool: ToolDefinition,
    input: JsonObject,
  ) {
    return hash({
      tenant: run.tenant_id,
      requester: run.requested_by,
      run: run.id,
      step: step.id,
      planHash: run.plan_hash,
      policyHash: run.policy_hash,
      tool: tool.id,
      toolVersion: tool.version,
      input,
    });
  }
  private executionAuthority(
    runId: string,
    step: Row,
    tool: ToolDefinition,
    input: JsonObject,
    token: string,
  ) {
    const run = this.db
      .prepare("SELECT * FROM runs WHERE id=?")
      .get(runId) as Row;
    const policy = this.checkPolicy(run, tool);
    const requester = this.principals.get(
      `${run.tenant_id}:${run.requested_by}`,
    )!;
    if (!this.canUse(requester, tool, input))
      throw new DomainError(
        "AUTHORITY_REVOKED",
        "Brak uprawnienia do danych operacji.",
        403,
      );
    if (run.cancellation_requested || !this.owns(runId, String(step.id), token))
      throw new DomainError(
        "EXECUTION_STOPPED",
        "Wykonanie zatrzymano lub wygasło prawo do tej próby.",
        409,
      );
    if (tool.effect === "write" || policy.approvalTools.includes(tool.id)) {
      const binding = this.binding(run, step, tool, input);
      const approval = this.db
        .prepare(
          "SELECT * FROM approvals WHERE run_id=? AND step_id=? AND binding_hash=? AND status='approved'",
        )
        .get(runId, String(step.id), binding) as Row | undefined;
      const actor = approval?.decided_by
        ? this.principals.get(`${run.tenant_id}:${approval.decided_by}`)
        : undefined;
      if (
        !actor?.roles.includes("approver") ||
        !this.canUse(actor, tool, input) ||
        (!policy.allowSelfApproval && actor.id === run.requested_by)
      )
        throw new DomainError(
          "APPROVAL_REVOKED",
          "Brak aktualnego uprawnienia zatwierdzającego tę operację.",
          403,
        );
    }
  }
  approve(
    principal: Principal,
    id: string,
    decision: {
      approvalId: string;
      bindingHash: string;
      decision: "approved" | "rejected";
    },
  ) {
    const actor = this.actor(principal, "approver");
    this.tx(() => {
      const run = this.runRow(actor, id);
      const policy = this.checkPolicy(run);
      if (!policy.allowSelfApproval && run.requested_by === actor.id)
        throw new DomainError(
          "SELF_APPROVAL_FORBIDDEN",
          "Decyzję musi podjąć inna uprawniona osoba.",
          403,
        );
      const approval = this.db
        .prepare("SELECT * FROM approvals WHERE id=? AND run_id=?")
        .get(decision.approvalId, id) as Row | undefined;
      if (!approval || approval.binding_hash !== decision.bindingHash)
        throw new DomainError(
          "STALE_APPROVAL",
          "Decyzja nie dotyczy aktualnie pokazanej operacji.",
          409,
        );
      if (approval.status === decision.decision) return;
      if (
        approval.status !== "pending" ||
        run.status !== "waiting_approval" ||
        run.cancellation_requested
      )
        throw new DomainError(
          "APPROVAL_CONFLICT",
          "Ta decyzja została już rozstrzygnięta lub zadanie zatrzymane.",
          409,
        );
      const step = this.db
        .prepare("SELECT * FROM steps WHERE run_id=? AND id=?")
        .get(id, String(approval.step_id)) as Row;
      const tool = this.tools.get(String(step.tool_id));
      if (!tool)
        throw new DomainError(
          "TOOL_MISSING",
          "Operacja jest niedostępna.",
          409,
        );
      this.checkPolicy(run, tool);
      if (!this.canUse(actor, tool, parse<JsonObject>(step.resolved_input)))
        throw new DomainError(
          "FORBIDDEN",
          "Brak uprawnienia do tego obszaru.",
          403,
        );
      if (
        this.binding(
          run,
          step,
          tool,
          parse<JsonObject>(step.resolved_input),
        ) !== approval.binding_hash
      )
        throw new DomainError(
          "STALE_APPROVAL",
          "Zakres operacji zmienił się.",
          409,
        );
      const changed = this.db
        .prepare(
          "UPDATE approvals SET status=?,decided_by=?,decided_at=? WHERE id=? AND status='pending'",
        )
        .run(decision.decision, actor.id, this.now(), decision.approvalId);
      if (!changed.changes)
        throw new DomainError(
          "APPROVAL_CONFLICT",
          "Decyzję rozstrzygnięto równolegle.",
          409,
        );
      this.db
        .prepare("UPDATE steps SET status=?,error=? WHERE run_id=? AND id=?")
        .run(
          decision.decision === "approved" ? "pending" : "blocked",
          decision.decision === "approved"
            ? null
            : "Odmowa wykonania operacji.",
          id,
          String(step.id),
        );
      this.setStatus(
        id,
        decision.decision === "approved" ? "running" : "cancelled",
      );
      this.event(id, `approval_${decision.decision}`, {
        actor: actor.id,
        stepId: String(step.id),
        bindingHash: decision.bindingHash,
      });
    });
    return this.getRun(actor, id);
  }
  cancel(principal: Principal, id: string) {
    this.actor(principal, "operator");
    this.tx(() => {
      const run = this.runRow(principal, id);
      if (["completed", "cancelled"].includes(String(run.status))) return;
      const active = this.db
        .prepare(
          "SELECT id FROM steps WHERE run_id=? AND status IN ('executing','verifying','unknown') LIMIT 1",
        )
        .get(id);
      this.db
        .prepare("UPDATE runs SET cancellation_requested=1 WHERE id=?")
        .run(id);
      this.db
        .prepare(
          "UPDATE approvals SET status='cancelled',decided_by=?,decided_at=? WHERE run_id=? AND status='pending'",
        )
        .run(principal.id, this.now(), id);
      this.setStatus(id, active ? "needs_reconciliation" : "cancelled");
      this.event(id, "cancellation_requested", {
        actor: principal.id,
        effectMayBeInFlight: !!active,
      });
    });
    return this.getRun(principal, id);
  }
  retry(principal: Principal, id: string) {
    this.actor(principal, "operator");
    this.tx(() => {
      const run = this.runRow(principal, id);
      this.checkPolicy(run);
      if (
        !["needs_reconciliation", "failed", "blocked"].includes(
          String(run.status),
        )
      )
        return;
      const step = this.db
        .prepare(
          "SELECT * FROM steps WHERE run_id=? AND status!='succeeded' ORDER BY ordinal LIMIT 1",
        )
        .get(id) as Row | undefined;
      if (!step) return;
      // A persisted result is only re-verified; an ambiguous effect is only reconciled.
      const status = step.output_json
        ? "verifying"
        : step.status === "unknown"
          ? "executing"
          : null;
      if (!status)
        throw new DomainError(
          "NEW_PLAN_REQUIRED",
          "Przyczyna blokady wymaga nowego planu. Nie ponawiamy skutku w ciemno.",
          409,
        );
      this.db
        .prepare(
          "UPDATE steps SET status=?,lease_until=0,lease_token=NULL,error=NULL WHERE run_id=? AND id=?",
        )
        .run(status, id, String(step.id));
      this.setStatus(id, "running");
      this.event(id, "reconciliation_requested", {
        actor: principal.id,
        stepId: String(step.id),
      });
    });
    return this.getRun(principal, id);
  }
  private block(
    runId: string,
    stepId: string,
    message: string,
    unknown = false,
  ) {
    this.db
      .prepare(
        "UPDATE steps SET status=?,error=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND id=?",
      )
      .run(unknown ? "unknown" : "blocked", message, runId, stepId);
    this.setStatus(runId, unknown ? "needs_reconciliation" : "blocked");
    this.event(runId, unknown ? "outcome_unknown" : "step_blocked", {
      stepId,
      message,
    });
  }
  private claim(): {
    run: Row;
    step: Row;
    tool: ToolDefinition;
    input: JsonObject;
    token: string;
    mode: "execute" | "reconcile" | "verify";
  } | null {
    return this.tx(() => {
      const candidates = this.db
        .prepare(
          "SELECT * FROM runs WHERE status IN ('running','needs_reconciliation') ORDER BY created_at",
        )
        .all() as Row[];
      for (const run of candidates) {
        const id = String(run.id);
        const step = this.db
          .prepare(
            "SELECT * FROM steps WHERE run_id=? AND status!='succeeded' ORDER BY ordinal LIMIT 1",
          )
          .get(id) as Row | undefined;
        if (!step) {
          this.setStatus(
            id,
            run.cancellation_requested ? "cancelled" : "completed",
          );
          this.event(id, "run_completed");
          continue;
        }
        if (
          !["pending", "executing", "verifying"].includes(String(step.status))
        )
          continue;
        if (
          step.status !== "pending" &&
          Number(step.lease_until ?? 0) > this.clock()
        )
          continue;
        const tool = this.tools.get(String(step.tool_id));
        if (!tool) {
          this.block(
            id,
            String(step.id),
            "Narzędzie nie jest dostępne.",
            step.status === "executing" || step.status === "verifying",
          );
          continue;
        }
        let input: JsonObject;
        try {
          const policy = this.checkPolicy(run, tool);
          input = step.resolved_input
            ? parse<JsonObject>(step.resolved_input)
            : (this.resolve(
                id,
                parse<JsonObject>(step.input_json),
              ) as JsonObject);
          input = tool.inputSchema.parse(input) as JsonObject;
          if (!step.resolved_input)
            this.db
              .prepare(
                "UPDATE steps SET resolved_input=? WHERE run_id=? AND id=?",
              )
              .run(canonical(input), id, String(step.id));
          if (step.status === "pending") {
            if (run.cancellation_requested) {
              this.setStatus(id, "cancelled");
              continue;
            }
            if (
              tool.effect === "write" ||
              policy.approvalTools.includes(tool.id)
            ) {
              const bindingHash = this.binding(run, step, tool, input);
              const approval = this.db
                .prepare(
                  "SELECT * FROM approvals WHERE run_id=? AND step_id=? AND binding_hash=?",
                )
                .get(id, String(step.id), bindingHash) as Row | undefined;
              const approvingActor = approval?.decided_by
                ? this.principals.get(`${run.tenant_id}:${approval.decided_by}`)
                : undefined;
              if (
                approval?.status === "approved" &&
                !approvingActor?.roles.includes("approver")
              )
                throw new DomainError(
                  "APPROVER_REVOKED",
                  "Zatwierdzający utracił uprawnienia.",
                  403,
                );
              if (!approval || approval.status !== "approved") {
                if (approval && approval.status !== "pending")
                  throw new DomainError(
                    "APPROVAL_REVOKED",
                    "Zgoda nie jest aktywna.",
                    409,
                  );
                if (!approval)
                  this.db
                    .prepare(
                      "INSERT INTO approvals(id,run_id,step_id,binding_hash,status,requested_at) VALUES(?,?,?,?,'pending',?)",
                    )
                    .run(
                      randomUUID(),
                      id,
                      String(step.id),
                      bindingHash,
                      this.now(),
                    );
                this.db
                  .prepare(
                    "UPDATE steps SET status='waiting_approval' WHERE run_id=? AND id=?",
                  )
                  .run(id, String(step.id));
                this.setStatus(id, "waiting_approval");
                this.event(id, "approval_requested", {
                  stepId: String(step.id),
                  bindingHash,
                });
                continue;
              }
            }
          }
        } catch (e) {
          this.block(
            id,
            String(step.id),
            e instanceof DomainError
              ? e.message
              : "Niepoprawne dane wejściowe operacji.",
            step.status === "executing" || step.status === "verifying",
          );
          continue;
        }
        const mode =
          step.status === "verifying"
            ? "verify"
            : step.status === "executing"
              ? "reconcile"
              : "execute";
        if (mode === "execute" && Number(step.attempts) >= this.maxAttempts) {
          this.block(id, String(step.id), "Osiągnięto limit prób.");
          continue;
        }
        const token = `${this.workerId}:${randomUUID()}`;
        this.db
          .prepare(
            "UPDATE steps SET status=?,lease_token=?,lease_until=?,attempts=attempts+?,error=NULL WHERE run_id=? AND id=?",
          )
          .run(
            mode === "verify" ? "verifying" : "executing",
            token,
            this.clock() + this.leaseMs,
            mode === "execute" ? 1 : 0,
            id,
            String(step.id),
          );
        this.event(
          id,
          mode === "execute"
            ? "step_started"
            : mode === "verify"
              ? "verification_resumed"
              : "reconciliation_started",
          { stepId: String(step.id) },
        );
        return { run, step, tool, input, token, mode };
      }
      return null;
    });
  }
  private owns(runId: string, stepId: string, token: string) {
    return !!this.db
      .prepare(
        "SELECT id FROM steps WHERE run_id=? AND id=? AND lease_token=? AND lease_until>?",
      )
      .get(runId, stepId, token, this.clock());
  }
  async tick(): Promise<boolean> {
    if (this.busy || this.closed) return false;
    this.busy = true;
    try {
      const job = this.claim();
      if (!job) return false;
      const { run, step, tool, input, token } = job;
      const runId = String(run.id),
        stepId = String(step.id);
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, this.leaseMs - 10),
      );
      const bounded = async <T>(fn: () => Promise<T>): Promise<T> => {
        controller.signal.throwIfAborted();
        let abort: () => void = () => {};
        const deadline = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error("Tool deadline exceeded"));
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        try {
          return await Promise.race([fn(), deadline]);
        } finally {
          controller.signal.removeEventListener("abort", abort);
        }
      };
      const boundApproval = this.db
        .prepare(
          "SELECT decided_by FROM approvals WHERE run_id=? AND step_id=? AND binding_hash=? AND status='approved'",
        )
        .get(runId, stepId, this.binding(run, step, tool, input)) as
        Row | undefined;
      const ctx: ToolContext = {
        tenantId: String(run.tenant_id),
        actorId: String(run.requested_by),
        ...(boundApproval?.decided_by
          ? { approvedBy: String(boundApproval.decided_by) }
          : {}),
        runId,
        stepId,
        operationKey: String(step.operation_key),
        signal: controller.signal,
      };
      try {
        let result: ToolResult;
        if (job.mode === "verify") result = parse<ToolResult>(step.output_json);
        else if (job.mode === "reconcile") {
          const recovered = tool.reconcile
            ? await bounded(() => tool.reconcile!(ctx, input))
            : tool.effect === "read"
              ? { status: "not_applied" as const }
              : {
                  status: "unknown" as const,
                  reason: "Brak narzędzia do uzgodnienia wyniku.",
                };
          if (recovered.status === "unknown") {
            this.finishUnknown(
              runId,
              stepId,
              token,
              "Nie można potwierdzić skutku operacji. Wymagane uzgodnienie.",
            );
            return true;
          }
          if (recovered.status === "applied") result = recovered.result;
          else {
            const current = this.db
              .prepare("SELECT * FROM runs WHERE id=?")
              .get(runId) as Row;
            if (current.cancellation_requested) {
              this.tx(() => {
                if (this.owns(runId, stepId, token)) {
                  this.db
                    .prepare(
                      "UPDATE steps SET status='blocked',error='Anulowano przed skutkiem.',lease_token=NULL,lease_until=NULL WHERE run_id=? AND id=?",
                    )
                    .run(runId, stepId);
                  this.setStatus(runId, "cancelled");
                  this.event(runId, "cancelled_without_effect", { stepId });
                }
              });
              return true;
            }
            this.checkPolicy(current, tool);
            // Definitely absent in a target with idempotency, or a pure read, permits a retry.
            if (tool.effect === "write" && tool.recovery === "manual") {
              this.finishUnknown(
                runId,
                stepId,
                token,
                "Narzędzie wymaga ręcznego wznowienia.",
              );
              return true;
            }
            const allowed = this.tx(() => {
              if (!this.owns(runId, stepId, token)) return false;
              const latest = this.db
                .prepare("SELECT attempts FROM steps WHERE run_id=? AND id=?")
                .get(runId, stepId) as Row;
              if (Number(latest.attempts) >= this.maxAttempts) {
                this.block(runId, stepId, "Osiągnięto limit prób.");
                return false;
              }
              this.db
                .prepare(
                  "UPDATE steps SET attempts=attempts+1 WHERE run_id=? AND id=?",
                )
                .run(runId, stepId);
              return true;
            });
            if (!allowed) return true;
            this.executionAuthority(runId, step, tool, input, token);
            result = await bounded(() => tool.execute(ctx, input));
          }
        } else {
          this.executionAuthority(runId, step, tool, input, token);
          result = await bounded(() => tool.execute(ctx, input));
        }
        if (
          !result ||
          typeof result.data !== "object" ||
          result.data === null ||
          Array.isArray(result.data)
        )
          throw new Error("Invalid tool result");
        if (canonical(result).length > 128_000)
          throw new Error("Tool result too large");
        const saved = this.tx(() => {
          if (!this.owns(runId, stepId, token)) return false;
          this.db
            .prepare(
              "UPDATE steps SET status='verifying',output_json=? WHERE run_id=? AND id=? AND lease_token=?",
            )
            .run(canonical(result), runId, stepId, token);
          this.event(runId, "effect_recorded", {
            stepId,
            reconciled: job.mode === "reconcile",
          });
          return true;
        });
        if (!saved) return true;
        const verified = await bounded(() => tool.verify(ctx, input, result));
        this.validateVerification(verified);
        this.tx(() => {
          if (!this.owns(runId, stepId, token)) return;
          this.db
            .prepare(
              "UPDATE steps SET status=?,verification_json=?,error=?,lease_token=NULL,lease_until=NULL WHERE run_id=? AND id=?",
            )
            .run(
              verified.ok ? "succeeded" : "blocked",
              canonical(verified),
              verified.ok ? null : "Weryfikacja nie potwierdziła wyniku.",
              runId,
              stepId,
            );
          const current = this.db
            .prepare("SELECT cancellation_requested FROM runs WHERE id=?")
            .get(runId) as Row;
          const remaining = this.db
            .prepare(
              "SELECT id FROM steps WHERE run_id=? AND status!='succeeded' LIMIT 1",
            )
            .get(runId);
          this.setStatus(
            runId,
            current.cancellation_requested
              ? "cancelled"
              : !verified.ok
                ? "blocked"
                : remaining
                  ? "running"
                  : "completed",
          );
          this.event(
            runId,
            verified.ok ? "step_verified" : "verification_failed",
            { stepId, summary: verified.summary },
          );
          if (!remaining && !current.cancellation_requested)
            this.event(runId, "run_completed");
        });
      } catch (e) {
        // Provider exception text is intentionally not persisted: it may contain secrets.
        this.finishUnknown(
          runId,
          stepId,
          token,
          e instanceof DomainError
            ? e.message
            : "Operacja została przerwana. Jej wynik wymaga uzgodnienia.",
        );
      } finally {
        clearTimeout(timer);
      }
      return true;
    } finally {
      this.busy = false;
    }
  }
  private validateVerification(v: Verification) {
    if (
      !v ||
      typeof v.ok !== "boolean" ||
      typeof v.summary !== "string" ||
      !Array.isArray(v.evidence) ||
      (v.ok && v.evidence.length === 0)
    )
      throw new Error("Invalid verification");
    for (const e of v.evidence as Evidence[])
      if (
        !e.source ||
        !e.summary ||
        !Number.isFinite(Date.parse(e.observedAt)) ||
        !e.data
      )
        throw new Error("Invalid evidence");
    if (canonical(v).length > 256_000) throw new Error("Evidence too large");
  }
  private finishUnknown(
    runId: string,
    stepId: string,
    token: string,
    message: string,
  ) {
    this.tx(() => {
      if (this.owns(runId, stepId, token))
        this.block(runId, stepId, message, true);
    });
  }
  queue(tenantId?: string) {
    const rows = this.db
      .prepare(
        "SELECT status,COUNT(*) AS n,MIN(updated_at) AS oldest FROM runs WHERE (? IS NULL OR tenant_id=?) GROUP BY status",
      )
      .all(tenantId ?? null, tenantId ?? null) as Row[];
    const count = (status: string) =>
      Number(rows.find((r) => r.status === status)?.n ?? 0);
    const oldest = rows.find((r) => r.status === "running")?.oldest;
    return {
      queued: count("planned"),
      running: count("running"),
      waitingApproval: count("waiting_approval"),
      blocked: count("blocked"),
      failed: count("failed"),
      needsReconciliation: count("needs_reconciliation"),
      oldestPendingAgeMs: oldest
        ? Math.max(0, this.clock() - Date.parse(String(oldest)))
        : null,
    };
  }
  health() {
    this.db.prepare("SELECT 1").get();
    return { database: "healthy", worker: this.busy ? "busy" : "ready" };
  }
  close() {
    if (this.busy) throw new Error("Stop worker before closing engine");
    this.closed = true;
    this.db.close();
  }
}
