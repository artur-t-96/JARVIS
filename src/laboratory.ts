import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { hash } from "./engine.js";
import { migrateDatabase } from "./migrations.js";
import {
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  type JsonObject,
  type Verification,
  DomainError,
} from "./contracts.js";
import {
  laboratoryCaseInputSchema,
  laboratoryFreshnessMs,
  laboratoryTarget,
  type LaboratoryCasePolicy,
  type LaboratoryProofSource,
  type StepEvidenceReader,
} from "./laboratory-contract.js";

interface Observation extends JsonObject {
  id: string;
  fixture: typeof laboratoryTarget;
  healthy: boolean;
  version: number;
  httpStatus: number | null;
  observedAt: string;
  environment: "jarvis-laboratory";
  check: "http" | "unreachable";
}
interface StoredObservation {
  observation: Observation;
  runId: string;
  stepId: string;
  operationKey: string;
  toolId: string;
  toolVersion: string;
  actorId: string | null;
  approvedBy: string | null;
  caseId: string | null;
  scopeRevision: number | null;
  scopeHash: string | null;
  inputHash: string;
  input: JsonObject;
  outputHash: string;
  verificationHash: string;
}

/** A real HTTP fixture owned entirely by this JARVIS installation, never another application. */
export class LocalLaboratory {
  private db: DatabaseSync;
  private server: Server;
  private token = randomBytes(32).toString("hex");
  private origin = "";
  private casePolicy?: LaboratoryCasePolicy;
  private outcome?: StepEvidenceReader;
  constructor(
    path: string,
    private options: { clock?: () => number } = {},
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    migrateDatabase(this.db, {
      namespace: "laboratory",
      migrations: [
        {
          version: 1,
          name: "isolated service fixture and effect ledger",
          up: (db) =>
            db.exec(
              "CREATE TABLE IF NOT EXISTS laboratory_state(tenant_id TEXT PRIMARY KEY,healthy INTEGER NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS laboratory_effects(tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(tenant_id,operation_key));",
            ),
        },
        {
          version: 2,
          name: "Immutable observations and scoped case test provenance",
          up: (db) =>
            db.exec(`
            CREATE TABLE laboratory_observations(
              tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT,
              record_json TEXT NOT NULL,record_hash TEXT NOT NULL,
              PRIMARY KEY(tenant_id,id));
            CREATE INDEX laboratory_case_observations ON laboratory_observations(tenant_id,case_id);
          `),
        },
      ],
    });
    this.server = createServer((req, res) => {
      if (
        req.headers.authorization !== `Bearer ${this.token}` ||
        req.method !== "GET"
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let tenant: string;
      try {
        tenant = decodeURIComponent((req.url ?? "").replace(/^\/health\//, ""));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const row = this.state(tenant);
      res.writeHead(row.healthy ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ fixture: "jarvis-local-service", ...row }));
    });
  }
  setCasePolicy(policy: LaboratoryCasePolicy) {
    this.casePolicy = policy;
  }
  setOutcomeReader(reader: StepEvidenceReader) {
    this.outcome = reader;
  }
  private now() {
    return new Date(this.options.clock?.() ?? Date.now()).toISOString();
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Lab failed");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  private state(tenantId: string) {
    const r = this.db
      .prepare("SELECT * FROM laboratory_state WHERE tenant_id=?")
      .get(tenantId) as { healthy: number; version: number } | undefined;
    return { healthy: Boolean(r?.healthy), version: r?.version ?? 0 };
  }
  private async inspect(ctx: ToolContext): Promise<Observation> {
    ctx.signal.throwIfAborted();
    const base = {
      id: randomUUID(),
      fixture: laboratoryTarget,
      environment: "jarvis-laboratory" as const,
    };
    try {
      const response = await fetch(
        `${this.origin}/health/${encodeURIComponent(ctx.tenantId)}`,
        {
          redirect: "error",
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(3000)]),
          headers: { authorization: `Bearer ${this.token}` },
        },
      );
      const body = z
        .object({
          fixture: z.literal("jarvis-local-service"),
          healthy: z.boolean(),
          version: z.number().int().nonnegative(),
        })
        .parse(await response.json());
      if (response.status !== (body.healthy ? 200 : 503))
        throw new Error("Inconsistent lab health");
      return {
        ...base,
        ...body,
        httpStatus: response.status,
        observedAt: this.now(),
        check: "http",
      };
    } catch {
      ctx.signal.throwIfAborted();
      return {
        ...base,
        healthy: false,
        version: this.state(ctx.tenantId).version,
        httpStatus: null,
        observedAt: this.now(),
        check: "unreachable",
      };
    }
  }
  private record(
    ctx: ToolContext,
    input: JsonObject,
    result: ToolResult,
    verification: Verification,
    observation: Observation,
    toolId: string,
    toolVersion: string,
  ) {
    const record: StoredObservation = {
      observation,
      runId: ctx.runId,
      stepId: ctx.stepId,
      operationKey: ctx.operationKey,
      toolId,
      toolVersion,
      actorId: ctx.actorId ?? null,
      approvedBy: ctx.approvedBy ?? null,
      caseId: toolId === "lab.repairCase" ? String(input.caseId) : null,
      scopeRevision:
        toolId === "lab.repairCase" ? Number(input.scopeRevision) : null,
      scopeHash: toolId === "lab.repairCase" ? String(input.scopeHash) : null,
      input,
      inputHash: hash(input),
      outputHash: hash(result),
      verificationHash: hash(verification),
    };
    this.db
      .prepare("INSERT INTO laboratory_observations VALUES(?,?,?,?,?)")
      .run(
        ctx.tenantId,
        observation.id,
        record.caseId,
        JSON.stringify(record),
        hash(record),
      );
  }
  private readObservation(tenant: string, id: string) {
    const row = this.db
      .prepare(
        "SELECT record_json,record_hash FROM laboratory_observations WHERE tenant_id=? AND id=?",
      )
      .get(tenant, id) as
      { record_json: string; record_hash: string } | undefined;
    if (!row)
      throw new DomainError(
        "LAB_OBSERVATION_NOT_FOUND",
        "Brak obserwacji w tej firmie.",
        404,
      );
    const record = JSON.parse(row.record_json) as StoredObservation;
    if (
      record.observation.id !== id ||
      hash(record) !== row.record_hash ||
      hash(record.input) !== record.inputHash
    )
      throw new DomainError(
        "LAB_OBSERVATION_INVALID",
        "Niespójny zapis obserwacji laboratorium.",
        409,
      );
    return { record, hash: row.record_hash };
  }
  private verified(tenant: string, record: StoredObservation) {
    const outcome = this.outcome?.(tenant, record.runId, record.stepId);
    return !!outcome?.succeeded && this.matchesOutcome(tenant, record);
  }
  private matchesOutcome(tenant: string, record: StoredObservation) {
    const outcome = this.outcome?.(tenant, record.runId, record.stepId);
    return (
      !!outcome &&
      outcome.toolId === record.toolId &&
      outcome.requestedBy === record.actorId &&
      outcome.approvedBy === record.approvedBy &&
      outcome.operationKey === record.operationKey &&
      outcome.toolVersion === record.toolVersion &&
      outcome.inputHash === record.inputHash &&
      outcome.outputHash === record.outputHash &&
      outcome.verificationHash === record.verificationHash
    );
  }
  private fresh(observation: Observation, now: string) {
    const age = Date.parse(now) - Date.parse(observation.observedAt);
    return age >= 0 && age <= laboratoryFreshnessMs && this.server.listening;
  }
  view(tenant: string, now = this.now()) {
    const row = this.db
      .prepare(
        "SELECT id FROM laboratory_observations WHERE tenant_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(tenant) as { id: string } | undefined;
    const saved = row ? this.readObservation(tenant, row.id) : undefined;
    const current = this.state(tenant);
    return {
      targetId: laboratoryTarget,
      title: "Usługa HTTP laboratorium JARVIS",
      protocol: "HTTP",
      procedureId: "lab.repairCase",
      procedureVersion: "1",
      freshnessSeconds: laboratoryFreshnessMs / 1000,
      observed: saved
        ? {
            ...saved.record.observation,
            hash: saved.hash,
            runId: saved.record.runId,
            current:
              this.fresh(saved.record.observation, now) &&
              current.version === saved.record.observation.version,
            verified: this.verified(tenant, saved.record),
          }
        : null,
    };
  }
  diagnosis(
    tenant: string,
    id: string,
    expectedHash: string,
    now: string,
  ): JsonObject {
    const saved = this.readObservation(tenant, id),
      observation = saved.record.observation;
    if (
      saved.hash !== expectedHash ||
      !this.verified(tenant, saved.record) ||
      !this.fresh(observation, now) ||
      this.state(tenant).version !== observation.version ||
      observation.healthy
    )
      throw new DomainError(
        "LAB_DIAGNOSIS_STALE",
        "Sprawa wymaga aktualnej, zweryfikowanej obserwacji awarii tej usługi.",
        409,
      );
    return {
      ...observation,
      hash: saved.hash,
      runId: saved.record.runId,
      stepId: saved.record.stepId,
    };
  }
  proof(
    tenant: string,
    id: string,
    caseId: string,
    revision: number,
    now: string,
  ): LaboratoryProofSource {
    const saved = this.readObservation(tenant, id),
      r = saved.record,
      observation = r.observation;
    const effect = this.db
      .prepare(
        "SELECT input_hash,result_json FROM laboratory_effects WHERE tenant_id=? AND operation_key=?",
      )
      .get(tenant, r.operationKey) as
      { input_hash: string; result_json: string } | undefined;
    if (
      r.toolId !== "lab.repairCase" ||
      r.toolVersion !== "1" ||
      r.caseId !== caseId ||
      r.scopeRevision !== revision ||
      !r.approvedBy ||
      !r.actorId ||
      !effect ||
      effect.input_hash !== hash({ healthy: true, input: r.input }) ||
      hash(JSON.parse(effect.result_json)) !== r.outputHash ||
      !this.verified(tenant, r)
    )
      throw new DomainError(
        "LAB_PROOF_UNVERIFIED",
        "Dowód nie potwierdza zatwierdzonej naprawy i zakończonej weryfikacji tej sprawy.",
        409,
      );
    const state = this.state(tenant),
      last = this.view(tenant, now).observed;
    const current =
      this.fresh(observation, now) &&
      observation.healthy &&
      observation.httpStatus === 200 &&
      state.healthy &&
      state.version === observation.version &&
      !!last?.healthy &&
      last.version === state.version;
    return {
      title: `Test HTTP po naprawie · ${observation.observedAt}`,
      version: 1,
      revision,
      hash: saved.hash,
      identity: {
        ...observation,
        caseId,
        scopeRevision: revision,
        scopeHash: r.scopeHash,
        procedureId: r.toolId,
        procedureVersion: r.toolVersion,
        runId: r.runId,
        stepId: r.stepId,
        requestedBy: r.actorId,
        approvedBy: r.approvedBy,
        current,
      },
    };
  }
  proofs(tenant: string, caseId: string, revision: number, now: string) {
    const rows = this.db
      .prepare(
        "SELECT id FROM laboratory_observations WHERE tenant_id=? AND case_id=? ORDER BY rowid DESC LIMIT 20",
      )
      .all(tenant, caseId) as { id: string }[];
    return rows.flatMap(({ id }) => {
      try {
        return [{ id, ...this.proof(tenant, id, caseId, revision, now) }];
      } catch {
        return [];
      }
    });
  }
  testHistory(tenant: string, caseId: string) {
    const rows = this.db
      .prepare(
        "SELECT id FROM laboratory_observations WHERE tenant_id=? AND case_id=? ORDER BY rowid DESC LIMIT 20",
      )
      .all(tenant, caseId) as { id: string }[];
    return rows.map(({ id }) => {
      const r = this.readObservation(tenant, id).record;
      return {
        id,
        runId: r.runId,
        scopeRevision: r.scopeRevision,
        observedAt: r.observation.observedAt,
        httpStatus: r.observation.httpStatus,
        result: this.verified(tenant, r)
          ? "positive"
          : this.matchesOutcome(tenant, r)
            ? "negative"
            : "unconfirmed",
      };
    });
  }
  private effect(ctx: ToolContext, input: unknown) {
    const r = this.db
      .prepare(
        "SELECT * FROM laboratory_effects WHERE tenant_id=? AND operation_key=?",
      )
      .get(ctx.tenantId, ctx.operationKey) as
      { input_hash: string; result_json: string } | undefined;
    if (r && r.input_hash !== hash(input))
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Konflikt operacji laboratorium.",
        409,
      );
    return r ? (JSON.parse(r.result_json) as ToolResult) : undefined;
  }
  tools(): ToolDefinition[] {
    const inspect: ToolDefinition = {
      id: "lab.inspect",
      scope: "it",
      version: "1",
      description: "Sprawdź HTTP własnego laboratorium JARVIS",
      effect: "read",
      recovery: "idempotent",
      inputSchema: z.object({}).strict(),
      execute: async (ctx) => ({ data: await this.inspect(ctx) }),
      verify: async (ctx, input, result) => {
        const verification: Verification = {
          ok: result.data.fixture === "jarvis-local-service",
          summary: "Odczytano faktyczny status HTTP lokalnej usługi testowej.",
          evidence: [
            {
              source: "jarvis-laboratory/http",
              summary: `HTTP ${result.data.httpStatus}`,
              observedAt: String(result.data.observedAt),
              data: result.data,
            },
          ],
        };
        this.record(
          ctx,
          input,
          result,
          verification,
          result.data as Observation,
          "lab.inspect",
          "1",
        );
        return verification;
      },
    };
    const change = (healthy: boolean, forCase = false): ToolDefinition => ({
      id: forCase
        ? "lab.repairCase"
        : healthy
          ? "lab.repair"
          : "lab.simulateFailure",
      scope: "it",
      version: forCase ? "1" : "2",
      ...(forCase
        ? {
            requiredScopes: ["cases"],
            canAccess: (principal, input) =>
              this.casePolicy?.canAccess(principal, input) ?? false,
          }
        : {}),
      description: forCase
        ? "Napraw własną usługę w zatwierdzonym zakresie sprawy IT"
        : healthy
          ? "Przywróć usługę w laboratorium JARVIS"
          : "Wprowadź kontrolowaną awarię własnego laboratorium",
      effect: "write",
      recovery: "idempotent",
      inputSchema: forCase
        ? laboratoryCaseInputSchema
        : z
            .object({ expectedVersion: z.number().int().nonnegative() })
            .strict(),
      execute: async (ctx, input) => {
        ctx.signal.throwIfAborted();
        if (forCase) this.authorizeCase(ctx, input);
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const existing = this.effect(ctx, { healthy, input });
          if (existing) {
            this.db.exec("COMMIT");
            return existing;
          }
          if (forCase) {
            const observed = this.view(ctx.tenantId).observed;
            if (
              !observed?.current ||
              !observed.verified ||
              observed.version !== input.expectedVersion
            )
              throw new DomainError(
                "LAB_OBSERVATION_STALE",
                "Przed naprawą odczytaj aktualny stan usługi i przygotuj nowy plan.",
                409,
              );
          }
          const current = this.state(ctx.tenantId);
          if (current.version !== input.expectedVersion)
            throw new DomainError(
              "VERSION_CONFLICT",
              "Stan laboratorium zmienił się. Sprawdź go ponownie.",
              409,
            );
          const version = current.version + 1;
          this.db
            .prepare(
              "INSERT INTO laboratory_state VALUES(?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET healthy=excluded.healthy,version=excluded.version",
            )
            .run(ctx.tenantId, healthy ? 1 : 0, version);
          const result = {
            data: {
              fixture: "jarvis-local-service",
              healthy,
              version,
              environment: "jarvis-laboratory",
              ...(forCase
                ? {
                    caseId: input.caseId!,
                    scopeRevision: input.scopeRevision!,
                    scopeHash: input.scopeHash!,
                  }
                : {}),
            },
          };
          this.db
            .prepare("INSERT INTO laboratory_effects VALUES(?,?,?,?)")
            .run(
              ctx.tenantId,
              ctx.operationKey,
              hash({ healthy, input }),
              JSON.stringify(result),
            );
          this.db.exec("COMMIT");
          return result;
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      },
      reconcile: async (ctx, input) => {
        if (forCase) this.authorizeCase(ctx, input, "reconcile");
        const result = this.effect(ctx, { healthy, input });
        return result
          ? { status: "applied", result }
          : { status: "not_applied" };
      },
      verify: async (ctx, input, result) => {
        if (forCase) this.authorizeCase(ctx, input);
        const observed = await this.inspect(ctx);
        const verification: Verification = {
          ok:
            observed.check === "http" &&
            observed.healthy === healthy &&
            observed.version === result.data.version,
          summary: "Niezależny test HTTP lokalnej usługi po operacji.",
          evidence: [
            {
              source: "jarvis-laboratory/http",
              summary: `HTTP ${observed.httpStatus}`,
              observedAt: observed.observedAt,
              data: observed,
            },
          ],
        };
        this.record(
          ctx,
          input,
          result,
          verification,
          observed,
          forCase
            ? "lab.repairCase"
            : healthy
              ? "lab.repair"
              : "lab.simulateFailure",
          forCase ? "1" : "2",
        );
        return verification;
      },
    });
    return [
      inspect,
      change(true),
      change(false),
      ...(this.casePolicy ? [change(true, true)] : []),
    ];
  }
  private authorizeCase(
    ctx: ToolContext,
    input: JsonObject,
    purpose: "execute" | "reconcile" = "execute",
  ) {
    if (!this.casePolicy || !ctx.actorId || !ctx.approvedBy)
      throw new DomainError(
        "LAB_CASE_AUTHORITY_REQUIRED",
        "Naprawa sprawy wymaga operatora i zgody aktywnego konta.",
        403,
      );
    this.casePolicy.authorize(ctx, input, purpose);
  }
  async close() {
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
    this.db.close();
  }
}
