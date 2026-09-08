import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { migrateDatabase } from "./migrations.js";
import {
  DomainError,
  type Json,
  type JsonObject,
  type Principal,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./contracts.js";
import {
  actionSchemas,
  createDataSchemas,
  moduleIds,
  workspaceCatalog,
  processTemplatesSchema,
  roleBindingsSchema,
  baselineProcessTemplates,
  type TaskRole,
  type RoleBindings,
  type ModuleDefinition,
  type ModuleId,
} from "./workspace-models.js";
import {
  CaseReadinessStore,
  migrateReadiness,
  type AcceptanceReadiness,
} from "./case-readiness.js";
import {
  WorkspaceTasks,
  taskTablesSql,
  roleScopes,
  type TaskAction,
  type TaskTransition,
} from "./workspace-tasks.js";
export type { ModuleDefinition } from "./workspace-models.js";

export interface Entity {
  id: string;
  module: ModuleId;
  title: string;
  status: string;
  version: number;
  data: JsonObject;
  createdAt: string;
  updatedAt: string;
}
type Row = Record<string, unknown>;
type CommandInput = {
  id?: string;
  expectedVersion?: number;
  title?: string;
  data?: JsonObject;
  [key: string]: unknown;
};
export interface LifecycleProfile {
  version: number;
  definitionVersion: string;
  timezone?: string;
  roleBindings: RoleBindings;
  processTemplates: z.infer<typeof processTemplatesSchema>;
}
const lifecycleProfileSchema = z
  .object({
    version: z.number().int().min(0),
    definitionVersion: z.literal("2"),
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      }),
    roleBindings: roleBindingsSchema,
    processTemplates: processTemplatesSchema,
  })
  .strict();
interface Command {
  profile?: LifecycleProfile;
  ctx: ToolContext;
  actor: string;
  now: string;
  toolId: string;
  changes: Entity[];
}
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
};
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const arr = (value: Json | undefined): JsonObject[] =>
  Array.isArray(value) ? (value as JsonObject[]) : [];
const asJson = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;
const editableSchemas: Record<ModuleId, z.ZodType> = {
  people: createDataSchemas.people
    .pick({ email: true, department: true, jobTitle: true })
    .partial(),
  cases: z.object({}).strict(),
  assets: z
    .object({ location: z.string().trim().min(1).max(200) })
    .strict()
    .partial(),
  purchases: createDataSchemas.purchases
    .pick({ description: true, expectedDelivery: true, supplierEmail: true })
    .partial(),
  licenses: z.object({}).strict(),
  sales: createDataSchemas.sales
    .pick({ contactEmail: true, scope: true })
    .partial(),
  recruitment: createDataSchemas.recruitment
    .pick({ description: true, requirements: true })
    .partial(),
  documents: z.object({}).strict(),
  it: createDataSchemas.it.pick({ description: true }).partial(),
};

export class WorkspaceStore {
  private readonly db: DatabaseSync;
  private profileProvider?: (tenantId: string) => LifecycleProfile;
  private principalProvider?: (tenantId: string) => Principal[];
  private readonly taskStore: WorkspaceTasks;
  private readonly readinessStore: CaseReadinessStore;
  constructor(
    dbPath: string,
    private readonly options: { clock?: () => number } = {},
  ) {
    if (dbPath !== ":memory:")
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      `PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`,
    );
    migrateDatabase(this.db, {
      namespace: "operations",
      migrations: [
        {
          version: 1,
          name: "Typed local operations and effect ledger",
          up: (db) =>
            db.exec(`
   CREATE TABLE IF NOT EXISTS ops_entities(tenant_id TEXT NOT NULL,id TEXT NOT NULL,module TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
   CREATE INDEX IF NOT EXISTS ops_entity_module ON ops_entities(tenant_id,module,updated_at);
   CREATE TABLE IF NOT EXISTS ops_entity_versions(tenant_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,PRIMARY KEY(tenant_id,entity_id,version),FOREIGN KEY(tenant_id,entity_id) REFERENCES ops_entities(tenant_id,id));
   CREATE TABLE IF NOT EXISTS ops_commands(tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,tool_id TEXT NOT NULL,input_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,changes_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,operation_key));
   CREATE TABLE IF NOT EXISTS ops_audit(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,run_id TEXT NOT NULL,step_id TEXT NOT NULL,actor_id TEXT NOT NULL,tool_id TEXT NOT NULL,entity_id TEXT NOT NULL,entity_version INTEGER NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ops_outbox(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','consumed')),created_at TEXT NOT NULL,UNIQUE(tenant_id,operation_key));
   CREATE TABLE IF NOT EXISTS ops_employment(tenant_id TEXT NOT NULL,id TEXT NOT NULL,person_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('internal','contractor')),start_date TEXT NOT NULL,end_date TEXT,status TEXT NOT NULL CHECK(status IN ('onboarding','active','offboarding','ended')),role TEXT NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
   CREATE UNIQUE INDEX IF NOT EXISTS ops_one_open_employment ON ops_employment(tenant_id,person_id) WHERE status!='ended';
   CREATE TABLE IF NOT EXISTS ops_tasks(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,title TEXT NOT NULL,assignee_id TEXT,required INTEGER NOT NULL CHECK(required IN (0,1)),status TEXT NOT NULL CHECK(status IN ('open','completed')),completed_by TEXT,completed_at TEXT,evidence_note TEXT,due_date TEXT,depends_on_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
   CREATE TABLE IF NOT EXISTS ops_evidence(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,title TEXT NOT NULL,reference TEXT NOT NULL,note TEXT NOT NULL,reported_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
   CREATE TABLE IF NOT EXISTS ops_acceptances(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),note TEXT NOT NULL,decided_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
   CREATE TABLE IF NOT EXISTS ops_allocations(tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,person_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','issued','released','returned')),reserved_until TEXT NOT NULL,issued_on TEXT,returned_on TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,asset_id) REFERENCES ops_entities(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
   CREATE UNIQUE INDEX IF NOT EXISTS ops_one_active_allocation ON ops_allocations(tenant_id,asset_id) WHERE status IN ('reserved','issued');
   CREATE TABLE IF NOT EXISTS ops_license_seats(tenant_id TEXT NOT NULL,id TEXT NOT NULL,license_id TEXT NOT NULL,person_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('assigned','revoked')),assigned_at TEXT NOT NULL,revoked_at TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,license_id) REFERENCES ops_entities(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
   CREATE UNIQUE INDEX IF NOT EXISTS ops_unique_seat ON ops_license_seats(tenant_id,license_id,person_id) WHERE status='assigned';
   CREATE TABLE IF NOT EXISTS ops_document_versions(tenant_id TEXT NOT NULL,document_id TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','review','approved','rejected')),decided_by TEXT,decision_note TEXT,decided_at TEXT,PRIMARY KEY(tenant_id,document_id,revision),FOREIGN KEY(tenant_id,document_id) REFERENCES ops_entities(tenant_id,id));
  `),
        },
        {
          version: 2,
          name: "Immutable case worklogs",
          up: (db) =>
            db.exec(
              `CREATE TABLE ops_worklogs(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,description TEXT NOT NULL,minutes INTEGER NOT NULL CHECK(minutes>=0),performed_on TEXT NOT NULL,amount_minor INTEGER,currency TEXT,reported_by TEXT NOT NULL,approved_by TEXT,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));`,
            ),
        },
        {
          version: 3,
          name: "Typed case readiness and human task identity",
          up: (db) => {
            db.exec("ALTER TABLE ops_tasks RENAME TO ops_tasks_legacy");
            db.exec(taskTablesSql);
            db.exec(`INSERT INTO ops_tasks(tenant_id,id,case_id,scope_revision,title,assignee_id,required,status,completed_by,completed_at,evidence_note,due_date,depends_on_json,kind,version,required_scopes_json,requirement_keys_json,provenance)
              SELECT tenant_id,id,case_id,scope_revision,title,assignee_id,required,CASE WHEN status='completed' THEN 'completed' ELSE 'unassigned' END,completed_by,completed_at,evidence_note,due_date,depends_on_json,'work',1,'["cases"]','[]','legacy' FROM ops_tasks_legacy;
              DROP TABLE ops_tasks_legacy;`);
            const legacyTasks = db
              .prepare(
                "SELECT t.tenant_id,t.id,t.assignee_id,e.data_json FROM ops_tasks t JOIN ops_entities e ON e.tenant_id=t.tenant_id AND e.id=t.case_id",
              )
              .all() as Row[];
            for (const task of legacyTasks) {
              const scopes = new Set([
                "cases",
                ...this.entityScopes(
                  "cases",
                  JSON.parse(String(task.data_json)),
                  String(task.tenant_id),
                ),
                ...(task.assignee_id ? ["people"] : []),
              ]);
              db.prepare(
                "UPDATE ops_tasks SET required_scopes_json=? WHERE tenant_id=? AND id=?",
              ).run(
                canonical([...scopes]),
                String(task.tenant_id),
                String(task.id),
              );
            }
            migrateReadiness(db);
          },
        },
      ],
    });
    this.readinessStore = new CaseReadinessStore(this.db, (tenant, e) => {
      const owner = this.livePrincipal(
        tenant,
        typeof e.data.ownerPrincipalId === "string"
          ? e.data.ownerPrincipalId
          : undefined,
      );
      return !!owner && this.canManageCase(owner, e.id);
    });
    this.taskStore = new WorkspaceTasks(
      this.db,
      undefined,
      (principal, caseId) => this.canManageCase(principal, caseId),
    );
  }
  setPrincipalProvider(provider: (tenantId: string) => Principal[]) {
    this.principalProvider = provider;
    this.taskStore.setPrincipalProvider(provider);
  }
  private livePrincipal(tenant: string, id?: string): Principal | undefined {
    const matches = (this.principalProvider?.(tenant) ?? []).filter(
      (p) => p.tenantId === tenant && p.id === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  private canManageCase(principal: Principal, caseId: string): boolean {
    if (!principal.roles.includes("operator")) return false;
    try {
      this.get(principal, "cases", caseId);
      return true;
    } catch {
      return false;
    }
  }
  listTasks(principal: Principal) {
    const today = this.companyDate({
      now: new Date(this.options.clock?.() ?? Date.now()).toISOString(),
      profile: this.currentProfile(principal.tenantId),
    });
    return this.taskStore.project(principal, { today });
  }
  taskAssignees(principal: Principal, taskId: string) {
    return this.taskStore.eligibleAssignees(principal, taskId);
  }
  readiness(principal: Principal, caseId: string) {
    const e = this.get(principal, "cases", caseId);
    const { bindings: _bindings, ...result } = this.readinessStore.evaluate(
      principal.tenantId,
      e,
      new Date(this.options.clock?.() ?? Date.now()).toISOString(),
    );
    return {
      ...result,
      requirements: result.requirements.map((requirement) => {
        if (!requirement.source) return requirement;
        try {
          this.get(principal, requirement.source.module, requirement.source.id);
          return requirement;
        } catch {
          const { source: _source, ...safe } = requirement;
          return safe;
        }
      }),
    };
  }
  setProfileProvider(provider: (tenantId: string) => LifecycleProfile) {
    this.profileProvider = provider;
  }
  private currentProfile(tenantId: string): LifecycleProfile | undefined {
    if (!this.profileProvider) return undefined;
    const profile = this.profileProvider(tenantId);
    if (profile.definitionVersion !== "2") return undefined;
    return lifecycleProfileSchema.parse({
      version: profile.version,
      definitionVersion: profile.definitionVersion,
      timezone: profile.timezone ?? "Europe/Warsaw",
      roleBindings: profile.roleBindings,
      processTemplates: profile.processTemplates,
    });
  }
  private companyDate(cmd: Pick<Command, "now" | "profile">): string {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: cmd.profile?.timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(cmd.now));
    const part = (type: string) =>
      parts.find((value) => value.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
  }
  private pinnedProfile(
    tenantId: string,
    input: JsonObject,
  ): LifecycleProfile | undefined {
    if (
      this.profileProvider &&
      this.profileProvider(tenantId).definitionVersion !== "2"
    )
      fail(
        "PROFILE_UPGRADE_REQUIRED",
        "Konfiguracja firmy wymaga zatwierdzonego uzupełnienia ról i typowanych zadań.",
      );
    const profile = this.currentProfile(tenantId);
    if (profile && input.profileVersion !== profile.version)
      fail(
        "PROFILE_CHANGED",
        "Szablon firmy zmienił wersję. Przygotuj nowy plan i zatwierdź jego zakres.",
      );
    return profile;
  }
  audit(principal: Principal, module: string, id: string) {
    this.get(principal, module, id);
    return (
      this.db
        .prepare(
          "SELECT id,operation_key AS operationKey,run_id AS runId,step_id AS stepId,actor_id AS initiatedBy,tool_id AS toolId,entity_version AS entityVersion,created_at AS createdAt FROM ops_audit WHERE tenant_id=? AND entity_id=? ORDER BY rowid",
        )
        .all(principal.tenantId, id) as Row[]
    ).map(asJson);
  }
  catalog(): ModuleDefinition[] {
    return workspaceCatalog();
  }
  private scope(principal: Principal, module: string) {
    if (
      !principal.id ||
      !principal.tenantId ||
      !principal.roles.length ||
      !(principal.scopes?.includes("*") || principal.scopes?.includes(module))
    )
      fail("SCOPE_REQUIRED", "Brak dostępu do tej kompetencji.", 403);
  }
  private module(value: string): ModuleId {
    if (!moduleIds.includes(value as ModuleId))
      fail("MODULE_NOT_FOUND", "Nieznana kompetencja.", 404);
    return value as ModuleId;
  }
  private fromRow(r: Row): Entity {
    return {
      id: String(r.id),
      module: r.module as ModuleId,
      title: String(r.title),
      status: String(r.status),
      version: Number(r.version),
      data: JSON.parse(String(r.data_json)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }
  private read(tenant: string, module: ModuleId, id: string): Entity {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module=? AND id=?",
      )
      .get(tenant, module, id) as Row | undefined;
    if (!row)
      fail(
        "ENTITY_NOT_FOUND",
        "Nie znaleziono rekordu w tej organizacji.",
        404,
      );
    return this.fromRow(row);
  }
  list(principal: Principal, module: string): Entity[] {
    const key = this.module(module);
    this.scope(principal, key);
    return (
      this.db
        .prepare(
          "SELECT * FROM ops_entities WHERE tenant_id=? AND module=? ORDER BY updated_at DESC,id DESC",
        )
        .all(principal.tenantId, key) as Row[]
    )
      .map((r) => this.fromRow(r))
      .filter((e) =>
        this.entityScopes(e.module, e.data, principal.tenantId).every(
          (s) =>
            principal.scopes?.includes("*") || principal.scopes?.includes(s),
        ),
      )
      .slice(0, 500)
      .map((entity) => this.projectEntity(principal.tenantId, entity));
  }
  get(principal: Principal, module: string, id: string): Entity {
    const key = this.module(module);
    this.scope(principal, key);
    const entity = this.read(principal.tenantId, key, id);
    for (const scope of this.entityScopes(
      entity.module,
      entity.data,
      principal.tenantId,
    ))
      this.scope(principal, scope);
    return this.projectEntity(principal.tenantId, entity);
  }
  private projectEntity(tenant: string, entity: Entity): Entity {
    // Project migrated rows without rewriting historical entity snapshots.
    if (entity.module === "cases")
      this.caseState({ ctx: { tenantId: tenant } }, entity);
    return entity;
  }
  summary(principal: Principal) {
    const modules = this.catalog()
      .filter(
        (m) =>
          principal.scopes?.includes("*") || principal.scopes?.includes(m.id),
      )
      .map((m) => {
        this.scope(principal, m.id as ModuleId);
        const rows = (
          this.db
            .prepare(
              "SELECT * FROM ops_entities WHERE tenant_id=? AND module=?",
            )
            .all(principal.tenantId, m.id) as Row[]
        )
          .map((r) => this.fromRow(r))
          .filter((e) =>
            this.entityScopes(e.module, e.data, principal.tenantId).every(
              (s) =>
                principal.scopes?.includes("*") ||
                principal.scopes?.includes(s),
            ),
          );
        const byStatus: Record<string, number> = {};
        for (const row of rows)
          byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
        return { id: m.id, label: m.label, total: rows.length, byStatus };
      });
    const cases = modules.find((m) => m.id === "cases")?.byStatus ?? {};
    const it = modules.find((m) => m.id === "it")?.byStatus ?? {};
    return {
      modules,
      openCases: (cases.open ?? 0) + (cases.needs_changes ?? 0),
      waitingAcceptance: cases.awaiting_acceptance ?? 0,
      incidents: (it.open ?? 0) + (it.triaged ?? 0) + (it.investigating ?? 0),
    };
  }
  private entityScopes(
    module: ModuleId,
    data: JsonObject,
    tenant?: string,
    depth = 0,
  ): string[] {
    if (depth > 25)
      fail("REFERENCE_DEPTH", "Zbyt głębokie powiązania źródłowe.");
    const scopes: string[] = [];
    if (module === "cases") {
      const area: Record<string, string> = {
        onboarding: "people",
        offboarding: "people",
        delivery: "sales",
        procurement: "purchases",
        it: "it",
      };
      if (area[String(data.caseType)])
        scopes.push(area[String(data.caseType)]!);
      if (
        data.personId ||
        data.ownerId ||
        arr(data.tasks).some((task) => task.assigneeId)
      )
        scopes.push("people");
    }
    if (module === "it" && data.ownerId) scopes.push("people");
    if (module === "documents") {
      if (tenant)
        for (const source of arr(data.sources)) {
          const sourceModule = this.module(String(source.module));
          const linked = this.read(tenant, sourceModule, String(source.id));
          scopes.push(
            sourceModule,
            ...this.entityScopes(sourceModule, linked.data, tenant, depth + 1),
          );
        }
      if (data.ownerId) scopes.push("people");
      if (data.linkedCaseId && tenant) {
        const linked = this.read(tenant, "cases", String(data.linkedCaseId));
        scopes.push(
          "cases",
          ...this.entityScopes("cases", linked.data, tenant, depth + 1),
        );
      }
      scopes.push(
        typeof data.accessScope === "string" ? data.accessScope : "people",
      );
    }
    if (module === "recruitment" && data.kind === "application")
      scopes.push("people");
    return [...new Set(scopes)];
  }
  private inputScopes(
    module: ModuleId,
    action: string,
    input: JsonObject,
    tenant: string,
  ): string[] {
    const scopes: string[] = [];
    const data =
      action === "create"
        ? ((input.data ?? {}) as JsonObject)
        : this.read(tenant, module, String(input.id)).data;
    scopes.push(...this.entityScopes(module, data, tenant));
    if (module === "cases" && action === "addTask" && input.assigneeId)
      scopes.push("people");
    if (module === "cases" && action === "bindEvidence") {
      const sourceModule = this.module(String(input.sourceModule));
      const source = this.read(tenant, sourceModule, String(input.sourceId));
      scopes.push(
        sourceModule,
        ...this.entityScopes(sourceModule, source.data, tenant),
      );
    }
    if (module === "cases" && (action === "create" || action === "revise")) {
      const definitions = (
        action === "create" ? data.requirements : input.requirements
      ) as JsonObject[] | undefined;
      for (const definition of definitions ?? []) {
        const expected = definition.expected as JsonObject;
        for (const [field, target] of [
          ["assetId", "assets"],
          ["documentId", "documents"],
          ["purchaseId", "purchases"],
        ] as const) {
          if (typeof expected[field] === "string") {
            const source = this.read(tenant, target, String(expected[field]));
            scopes.push(
              target,
              ...this.entityScopes(target, source.data, tenant),
            );
          }
        }
      }
    }
    if (module === "documents") {
      if (data.ownerId) scopes.push("people");
      if (data.linkedCaseId) {
        const linked = this.read(tenant, "cases", String(data.linkedCaseId));
        scopes.push(
          "cases",
          ...this.entityScopes("cases", linked.data, tenant),
        );
      }
    }
    if (action === "create" && module === "licenses" && data.supplierId)
      scopes.push("purchases");
    if (action === "create" && module === "it" && data.relatedAssetId)
      scopes.push("assets");
    if (module === "it" && action === "triage" && input.ownerId)
      scopes.push("people");
    if (module === "sales" && action === "handoff" && input.ownerId)
      scopes.push("people");
    return [...new Set(scopes)];
  }
  private state(entity: Entity, ...allowed: string[]) {
    if (!allowed.includes(entity.status))
      fail(
        "INVALID_TRANSITION",
        `Ta operacja nie jest dozwolona w stanie ${entity.status}.`,
      );
  }
  private kind(entity: Entity, ...allowed: string[]) {
    if (!allowed.includes(String(entity.data.kind)))
      fail(
        "WRONG_RECORD_KIND",
        "Ta operacja nie dotyczy tego rodzaju rekordu.",
      );
  }
  private human(cmd: Command, input: CommandInput) {
    if (
      !(input.humanDecision === true || input.humanConfirmed === true) ||
      !cmd.ctx.actorId
    )
      fail(
        "HUMAN_CONFIRMATION_REQUIRED",
        "Wymagana jawna decyzja człowieka i tożsamość wykonawcy.",
        403,
      );
    cmd.actor = cmd.ctx.actorId;
  }
  private ref(cmd: Command, module: ModuleId, value: unknown): Entity {
    if (typeof value !== "string")
      fail("REFERENCE_REQUIRED", "Wymagane powiązanie z rekordem.");
    return this.read(cmd.ctx.tenantId, module, value);
  }
  private optionalRef(cmd: Command, module: ModuleId, value: unknown) {
    if (value !== undefined && value !== null) this.ref(cmd, module, value);
  }
  private snapshot(cmd: Command, entity: Entity) {
    this.db
      .prepare("INSERT INTO ops_entity_versions VALUES(?,?,?,?,?)")
      .run(
        cmd.ctx.tenantId,
        entity.id,
        entity.version,
        canonical(entity),
        digest(entity),
      );
    this.db
      .prepare("INSERT INTO ops_audit VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        randomUUID(),
        cmd.ctx.tenantId,
        cmd.ctx.operationKey,
        cmd.ctx.runId,
        cmd.ctx.stepId,
        cmd.ctx.actorId ?? "system",
        cmd.toolId,
        entity.id,
        entity.version,
        cmd.now,
      );
    cmd.changes.push(JSON.parse(canonical(entity)) as Entity);
  }
  private insert(
    cmd: Command,
    module: ModuleId,
    title: string,
    data: JsonObject,
    status: string,
  ): Entity {
    const entity: Entity = {
      id: randomUUID(),
      module,
      title: title.slice(0, 160),
      data,
      status,
      version: 1,
      createdAt: cmd.now,
      updatedAt: cmd.now,
    };
    this.db
      .prepare("INSERT INTO ops_entities VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        cmd.ctx.tenantId,
        entity.id,
        module,
        entity.title,
        status,
        1,
        canonical(data),
        cmd.now,
        cmd.now,
      );
    return entity;
  }
  private saveNew(cmd: Command, entity: Entity) {
    this.db
      .prepare(
        "UPDATE ops_entities SET data_json=?,status=? WHERE tenant_id=? AND id=?",
      )
      .run(canonical(entity.data), entity.status, cmd.ctx.tenantId, entity.id);
    this.snapshot(cmd, entity);
    return entity;
  }
  private save(cmd: Command, entity: Entity): Entity {
    const previous = entity.version;
    entity.version++;
    entity.updatedAt = cmd.now;
    const changed = this.db
      .prepare(
        "UPDATE ops_entities SET title=?,status=?,version=?,data_json=?,updated_at=? WHERE tenant_id=? AND id=? AND version=?",
      )
      .run(
        entity.title,
        entity.status,
        entity.version,
        canonical(entity.data),
        cmd.now,
        cmd.ctx.tenantId,
        entity.id,
        previous,
      );
    if (!changed.changes)
      fail("VERSION_CONFLICT", "Rekord zmienił się. Odczytaj aktualną wersję.");
    this.snapshot(cmd, entity);
    return entity;
  }
  private supplier(cmd: Command, value: unknown) {
    const e = this.ref(cmd, "purchases", value);
    this.kind(e, "supplier");
    this.state(e, "active");
    return e;
  }
  private create(
    cmd: Command,
    module: ModuleId,
    title: string,
    data: JsonObject,
  ): Entity {
    let status = "draft";
    if (module === "people") {
      status = "registered";
      data.employmentEpisodes = [];
    }
    if (module === "cases") {
      this.optionalRef(cmd, "people", data.ownerId);
      this.optionalRef(cmd, "people", data.personId);
      if (data.caseType === "onboarding" || data.caseType === "offboarding") {
        this.ref(cmd, "people", data.personId);
        const episode = this.db
          .prepare(
            "SELECT * FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
          )
          .get(
            cmd.ctx.tenantId,
            String(data.employmentEpisodeId ?? ""),
            String(data.personId),
          ) as Row | undefined;
        if (!episode)
          fail(
            "EMPLOYMENT_REQUIRED",
            "Sprawa lifecycle wymaga właściwego okresu współpracy.",
          );
        if (data.caseType === "onboarding" && episode.status !== "onboarding")
          fail(
            "WRONG_LIFECYCLE",
            "Onboarding wymaga okresu w stanie onboarding.",
          );
        if (data.caseType === "offboarding" && episode.status !== "offboarding")
          fail("WRONG_LIFECYCLE", "Najpierw rozpocznij offboarding osoby.");
        data.employmentKind = String(episode.kind);
        data.employmentStartDate = String(episode.start_date);
      }
      status = "open";
      data = {
        ...data,
        scopeRevision: 1,
        tasks: [],
        worklogs: [],
        settlementDraft: null,
        evidence: [],
        acceptances: [],
        scopeHistory: [
          {
            revision: 1,
            brief: data.brief!,
            acceptanceCriteria: data.acceptanceCriteria!,
            createdAt: cmd.now,
          },
        ],
      };
    }
    if (module === "assets") {
      const dupe = this.db
        .prepare(
          "SELECT id FROM ops_entities WHERE tenant_id=? AND module='assets' AND json_extract(data_json,'$.serial')=?",
        )
        .get(cmd.ctx.tenantId, String(data.serial));
      if (dupe)
        fail("DUPLICATE_SERIAL", "Sprzęt o tym numerze seryjnym już istnieje.");
      status = data.condition === "good" ? "available" : "maintenance";
      data.allocations = [];
    }
    if (module === "purchases") {
      if (data.kind === "supplier") {
        status = "active";
        if (data.supplierId)
          fail(
            "INVALID_SUPPLIER",
            "Dostawca nie może wskazywać innego dostawcy.",
          );
      } else {
        this.supplier(cmd, data.supplierId);
        if (!data.quantity)
          fail("QUANTITY_REQUIRED", "Podaj ilość zamówienia.");
        data.receivedQuantity = 0;
        data.deliveries = [];
      }
    }
    if (module === "licenses") {
      this.optionalRef(cmd, "purchases", data.supplierId);
      if (data.supplierId) this.supplier(cmd, data.supplierId);
      status = "active";
      data.assignments = [];
      data.provisioning = "local_register_only";
    }
    if (module === "sales") {
      if (data.kind === "client") status = "active";
      else {
        const parent = this.ref(cmd, "sales", data.parentId);
        this.kind(parent, data.kind === "deal" ? "client" : "deal");
        if (data.kind === "deal") {
          this.state(parent, "active");
          status = "open";
        } else {
          this.state(parent, "open", "qualified");
          if (!data.scope || Number(data.value) <= 0)
            fail(
              "OFFER_TERMS_REQUIRED",
              "Oferta wymaga zakresu i dodatniej wartości.",
            );
        }
      }
      data.history = [];
    }
    if (module === "recruitment") {
      if (data.kind === "vacancy") {
        status = "open";
        if (data.personId || data.vacancyId)
          fail("INVALID_VACANCY", "Wakat nie jest aplikacją osoby.");
      } else {
        const person = this.ref(cmd, "people", data.personId),
          vacancy = this.ref(cmd, "recruitment", data.vacancyId);
        this.kind(vacancy, "vacancy");
        this.state(vacancy, "open");
        if (
          person.data.personCategory !== data.employmentKind ||
          vacancy.data.employmentKind !== data.employmentKind
        )
          fail(
            "EMPLOYMENT_KIND_MISMATCH",
            "Nie można pomylić rekrutacji wewnętrznej z kontraktorską.",
          );
        const dupe = this.db
          .prepare(
            "SELECT id FROM ops_entities WHERE tenant_id=? AND module='recruitment' AND json_extract(data_json,'$.personId')=? AND json_extract(data_json,'$.vacancyId')=? AND status NOT IN ('rejected','withdrawn')",
          )
          .get(cmd.ctx.tenantId, String(data.personId), String(data.vacancyId));
        if (dupe)
          fail(
            "DUPLICATE_APPLICATION",
            "Istnieje już aplikacja tej osoby do tej rekrutacji.",
          );
        status = "new";
      }
      data.decisions = [];
    }
    if (module === "documents") {
      const seen = new Set<string>();
      data.sources = arr(data.sources).map((source) => {
        const key = `${source.module}:${source.id}`;
        if (seen.has(key))
          fail("DUPLICATE_SOURCE", "Źródło dokumentu się powtarza.");
        seen.add(key);
        const record = this.ref(
          cmd,
          this.module(String(source.module)),
          source.id,
        );
        if (record.version !== source.version)
          fail(
            "SOURCE_VERSION_CHANGED",
            "Źródło zmieniło wersję. Przygotuj dokument ponownie.",
          );
        if (
          Date.parse(String(source.observedAt)) > Date.parse(cmd.now) ||
          Date.parse(String(source.observedAt)) < Date.parse(record.updatedAt)
        )
          fail(
            "INVALID_SOURCE_OBSERVATION",
            "Data odczytu źródła nie odpowiada zapisanej wersji.",
          );
        return { ...source, snapshotHash: digest(record), verifiedAt: cmd.now };
      });
      this.optionalRef(cmd, "people", data.ownerId);
      this.optionalRef(cmd, "cases", data.linkedCaseId);
      data.revision = 1;
      data.versions = [];
    }
    if (module === "it") {
      this.optionalRef(cmd, "assets", data.relatedAssetId);
      status = data.kind === "observation" ? "observed" : "open";
      data.actions = [];
      data.externalActionsPerformed = false;
    }
    const definitions = module === "cases" ? data.requirements : undefined;
    if (module === "cases") delete data.requirements;
    const e = this.insert(cmd, module, title, data, status);
    if (module === "cases")
      this.readinessStore.initialize(
        cmd.ctx.tenantId,
        e,
        definitions,
        cmd.ctx.actorId ?? "system",
        cmd.now,
      );
    if (module === "documents") {
      this.documentVersion(cmd, e, String(data.content), 1);
      e.data.versions = this.docVersions(cmd, e.id);
    }
    return this.saveNew(cmd, e);
  }
  private startEmployment(
    cmd: Command,
    person: Entity,
    input: CommandInput,
  ): string {
    this.state(person, "registered", "exited");
    if (input.employmentKind !== person.data.personCategory)
      fail(
        "EMPLOYMENT_KIND_MISMATCH",
        "Rodzaj współpracy musi odpowiadać osobie.",
      );
    const latest = this.db
      .prepare(
        "SELECT end_date FROM ops_employment WHERE tenant_id=? AND person_id=? ORDER BY start_date DESC LIMIT 1",
      )
      .get(cmd.ctx.tenantId, person.id) as Row | undefined;
    if (latest?.end_date && String(input.startDate) <= String(latest.end_date))
      fail(
        "OVERLAPPING_EMPLOYMENT",
        "Nowy okres musi rozpocząć się po poprzednim.",
      );
    const episodeId = randomUUID();
    this.db
      .prepare("INSERT INTO ops_employment VALUES(?,?,?,?,?,?,?,?)")
      .run(
        cmd.ctx.tenantId,
        episodeId,
        person.id,
        String(input.employmentKind),
        String(input.startDate),
        null,
        "onboarding",
        String(input.role),
      );
    person.status = "onboarding";
    person.data.currentEmploymentEpisodeId = episodeId;
    person.data.employmentEpisodes = this.episodes(cmd, person.id);
    person.data.onboardingCaseId = this.lifecycleCase(
      cmd,
      person,
      episodeId,
      "onboarding",
      String(input.startDate),
    );
    person.data.offboardingCaseId = null;
    return episodeId;
  }
  private lifecycleCase(
    cmd: Command,
    person: Entity,
    episodeId: string,
    type: "onboarding" | "offboarding",
    dueDate: string,
  ): string {
    const c = this.create(
      cmd,
      "cases",
      `${type === "onboarding" ? "Onboarding" : "Offboarding"}: ${person.title}`,
      {
        caseType: type,
        brief: `${type === "onboarding" ? "Rozpoczęcie" : "Zakończenie"} współpracy ${person.data.personCategory === "internal" ? "wewnętrznej" : "kontraktorskiej"}: ${person.title}.`,
        acceptanceCriteria:
          "Wymagane zadania ukończone, dowody dostarczone i odebrane przez człowieka.",
        personId: person.id,
        employmentEpisodeId: episodeId,
        dueDate,
      },
    );
    const template =
      cmd.profile?.processTemplates[type] ??
      baselineProcessTemplates(
        person.data.personCategory === "contractor" ? "contractor" : "internal",
      )[type];
    c.data.ownerPrincipalId =
      this.taskStore.resolveRole(
        cmd.ctx.tenantId,
        cmd.profile?.roleBindings ?? {},
        "manager",
      ) ?? null;
    c.data.profileVersion = cmd.profile?.version ?? null;
    c.data.processTemplateSnapshot = JSON.parse(
      canonical({
        profileVersion: cmd.profile?.version ?? null,
        type,
        tasks: template,
      }),
    ) as Json;
    const taskIds: Record<string, string> = {};
    for (const task of template) {
      const taskId = randomUUID();
      const due = new Date(`${dueDate}T00:00:00Z`);
      due.setUTCDate(due.getUTCDate() + task.offsetDays);
      const deadline = due.toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline))
        fail(
          "INVALID_TEMPLATE_DATE",
          "Termin szablonu wykracza poza obsługiwany zakres.",
        );
      this.taskStore.insert(
        { ctx: cmd.ctx, now: cmd.now, caseId: c.id, scopeRevision: 1 },
        {
          id: taskId,
          title: task.title,
          required: task.required,
          kind: task.kind,
          assigneeRole: task.assigneeRole,
          assigneePrincipalId: this.taskStore.resolveRole(
            cmd.ctx.tenantId,
            cmd.profile?.roleBindings ?? {},
            task.assigneeRole,
          ),
          requiredScopes: roleScopes[task.assigneeRole],
          requirementKeys: task.requirementKeys,
          dueDate: deadline,
          dependsOn: task.dependsOn.map((key) => taskIds[key]!),
          allowUnassigned: true,
        },
      );
      taskIds[task.key] = taskId;
    }
    this.caseState(cmd, c);
    this.save(cmd, c);
    return c.id;
  }
  private episodes(cmd: Command, personId: string): JsonObject[] {
    return (
      this.db
        .prepare(
          "SELECT id,kind,start_date AS startDate,end_date AS endDate,status,role FROM ops_employment WHERE tenant_id=? AND person_id=? ORDER BY start_date,id",
        )
        .all(cmd.ctx.tenantId, personId) as Row[]
    ).map(asJson);
  }
  private documentVersion(
    cmd: Command,
    e: Entity,
    content: string,
    revision: number,
  ) {
    this.db
      .prepare("INSERT INTO ops_document_versions VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        cmd.ctx.tenantId,
        e.id,
        revision,
        content,
        digest(content),
        "draft",
        null,
        null,
        null,
      );
  }
  private docVersions(cmd: Command, id: string): JsonObject[] {
    return (
      this.db
        .prepare(
          "SELECT revision,content,content_hash AS contentHash,status,decided_by AS decidedBy,decision_note AS decisionNote,decided_at AS decidedAt FROM ops_document_versions WHERE tenant_id=? AND document_id=? ORDER BY revision",
        )
        .all(cmd.ctx.tenantId, id) as Row[]
    ).map(asJson);
  }
  private caseState(cmd: { ctx: { tenantId: string } }, e: Entity) {
    const params = [cmd.ctx.tenantId, e.id, Number(e.data.scopeRevision)];
    e.data.tasks = this.taskStore
      .rows(cmd.ctx.tenantId, e.id, Number(e.data.scopeRevision))
      .map((row) => asJson(row));
    e.data.requirements = this.readinessStore
      .requirements(cmd.ctx.tenantId, e.id, Number(e.data.scopeRevision))
      .map(({ id, key, title, kind, required }) => ({
        id,
        key,
        title,
        kind,
        required,
      }));
    e.data.evidence = (
      this.db
        .prepare(
          "SELECT id,title,reference,note,reported_by AS reportedBy,created_at AS createdAt FROM ops_evidence WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY rowid",
        )
        .all(...params) as Row[]
    ).map((r) => ({ ...asJson(r), kind: "human_report" }));
    e.data.worklogs = (
      this.db
        .prepare(
          "SELECT id,description,minutes,performed_on AS performedOn,amount_minor AS amountMinor,currency,reported_by AS reportedBy,approved_by AS approvedBy,created_at AS createdAt FROM ops_worklogs WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY rowid",
        )
        .all(...params) as Row[]
    ).map((row) => ({
      ...asJson(row),
      kind: "declared_worklog",
      ...(row.amountMinor !== null
        ? { amount: Number(row.amountMinor) / 100 }
        : {}),
    }));
    e.data.acceptances = (
      this.db
        .prepare(
          "SELECT id,scope_revision AS scopeRevision,decision,note,decided_by AS decidedBy,created_at AS createdAt,scope_hash AS scopeHash,bindings_hash AS bindingsHash,contract_version AS contractVersion,requested_by AS requestedBy,approved_by AS approvedBy FROM ops_acceptances WHERE tenant_id=? AND case_id=? ORDER BY rowid",
        )
        .all(cmd.ctx.tenantId, e.id) as Row[]
    ).map(asJson);
  }
  private readyForAcceptance(cmd: Command, e: Entity): AcceptanceReadiness {
    this.caseState(cmd, e);
    const result = this.readinessStore.evaluate(cmd.ctx.tenantId, e, cmd.now);
    if (!result.ready)
      fail(
        "ACCEPTANCE_NOT_READY",
        "Bieżąca rewizja nie jest gotowa do odbioru. Sprawdź zadania i typowane wymagania źródłowe.",
      );
    return result;
  }
  private taskContext(cmd: Command, e: Entity) {
    const principal = this.livePrincipal(cmd.ctx.tenantId, cmd.ctx.actorId);
    return {
      ctx: cmd.ctx,
      now: cmd.now,
      caseId: e.id,
      scopeRevision: Number(e.data.scopeRevision),
      canManage: !!principal && this.canManageCase(principal, e.id),
      ...(typeof e.data.ownerPrincipalId === "string"
        ? { ownerPrincipalId: e.data.ownerPrincipalId }
        : {}),
    };
  }
  private cancelCase(cmd: Command, e: Entity, reason: string) {
    for (const task of this.taskStore.rows(
      cmd.ctx.tenantId,
      e.id,
      Number(e.data.scopeRevision),
    )) {
      if (!["completed", "cancelled"].includes(task.status))
        this.taskStore.transition(this.taskContext(cmd, e), "cancelTask", {
          taskId: task.id,
          expectedTaskVersion: task.version,
          humanConfirmed: true,
          reason,
        });
    }
    this.caseState(cmd, e);
    e.status = "cancelled";
    e.data.cancellationReason = reason;
  }
  private change(
    cmd: Command,
    e: Entity,
    action: string,
    input: CommandInput,
  ): Entity {
    const d = e.data;
    if (e.module === "people") {
      this.human(cmd, input);
      if (action === "startEmployment") this.startEmployment(cmd, e, input);
      else {
        const episode = this.db
          .prepare(
            "SELECT * FROM ops_employment WHERE tenant_id=? AND person_id=? AND status!='ended'",
          )
          .get(cmd.ctx.tenantId, e.id) as Row | undefined;
        if (!episode)
          fail("EMPLOYMENT_REQUIRED", "Brak otwartego okresu współpracy.");
        if (action === "activate") {
          this.state(e, "onboarding");
          const onboarding = this.ref(cmd, "cases", d.onboardingCaseId);
          this.state(onboarding, "accepted");
          const readiness = this.readinessStore.evaluate(
            cmd.ctx.tenantId,
            onboarding,
            cmd.now,
          );
          if (
            onboarding.data.caseType !== "onboarding" ||
            onboarding.data.personId !== e.id ||
            onboarding.data.employmentEpisodeId !== episode.id ||
            d.currentEmploymentEpisodeId !== episode.id ||
            !readiness.acceptanceCurrent
          )
            fail(
              "ACTIVATION_READINESS_STALE",
              "Odbiór nie potwierdza aktualnej gotowości tej osoby i współpracy. Wymagana nowa ocena lub rewizja.",
            );
          if (String(episode.start_date) > this.companyDate(cmd))
            fail(
              "START_DATE_NOT_REACHED",
              "Data rozpoczęcia jeszcze nie nastąpiła.",
            );
          this.db
            .prepare(
              "UPDATE ops_employment SET status='active' WHERE tenant_id=? AND id=?",
            )
            .run(cmd.ctx.tenantId, String(episode.id));
          e.status = "active";
        }
        if (action === "beginOffboarding" || action === "endEmployment") {
          this.state(
            e,
            ...(action === "beginOffboarding"
              ? ["active", "onboarding"]
              : ["offboarding"]),
          );
          if (String(input.endDate) < String(episode.start_date))
            fail(
              "INVALID_EMPLOYMENT_DATES",
              "Koniec nie może poprzedzać początku współpracy.",
            );
          if (action === "endEmployment") {
            if (String(input.endDate) > this.companyDate(cmd))
              fail(
                "END_DATE_NOT_REACHED",
                "Nie można potwierdzić zakończenia współpracy w przyszłości.",
              );
            const offboarding = this.ref(cmd, "cases", d.offboardingCaseId);
            this.state(offboarding, "accepted");
            const readiness = this.readinessStore.evaluate(
              cmd.ctx.tenantId,
              offboarding,
              cmd.now,
            );
            if (
              offboarding.data.caseType !== "offboarding" ||
              offboarding.data.personId !== e.id ||
              offboarding.data.employmentEpisodeId !== episode.id ||
              d.currentEmploymentEpisodeId !== episode.id ||
              !readiness.acceptanceCurrent
            )
              fail(
                "EXIT_READINESS_STALE",
                "Odbiór nie potwierdza aktualnego rozliczenia tej osoby i współpracy. Wymagana nowa ocena lub rewizja.",
              );
            if (
              this.db
                .prepare(
                  "SELECT id FROM ops_allocations WHERE tenant_id=? AND person_id=? AND status IN ('reserved','issued')",
                )
                .get(cmd.ctx.tenantId, e.id)
            )
              fail(
                "ASSETS_NOT_RETURNED",
                "Najpierw rozlicz sprzęt i rezerwacje osoby.",
              );
            if (
              this.db
                .prepare(
                  "SELECT id FROM ops_license_seats WHERE tenant_id=? AND person_id=? AND status='assigned'",
                )
                .get(cmd.ctx.tenantId, e.id)
            )
              fail(
                "LICENSES_NOT_REVOKED",
                "Najpierw zamknij przydziały licencji.",
              );
          }
          if (
            action === "beginOffboarding" &&
            e.status === "onboarding" &&
            d.onboardingCaseId
          ) {
            const onboarding = this.ref(cmd, "cases", d.onboardingCaseId);
            if (
              ["open", "needs_changes", "awaiting_acceptance"].includes(
                onboarding.status,
              )
            ) {
              this.cancelCase(
                cmd,
                onboarding,
                "Rozpoczęto offboarding przed ukończeniem onboardingu.",
              );
              this.save(cmd, onboarding);
            }
          }
          const status =
            action === "beginOffboarding" ? "offboarding" : "ended";
          this.db
            .prepare(
              "UPDATE ops_employment SET status=?,end_date=? WHERE tenant_id=? AND id=?",
            )
            .run(
              status,
              String(input.endDate),
              cmd.ctx.tenantId,
              String(episode.id),
            );
          e.status = action === "beginOffboarding" ? "offboarding" : "exited";
          d.endReason = String(input.reason);
          if (action === "beginOffboarding")
            d.offboardingCaseId = this.lifecycleCase(
              cmd,
              e,
              String(episode.id),
              "offboarding",
              String(input.endDate),
            );
        }
        d.employmentEpisodes = this.episodes(cmd, e.id);
      }
    }
    if (e.module === "cases") {
      if (action === "revise") {
        this.state(
          e,
          "open",
          "needs_changes",
          "awaiting_acceptance",
          "accepted",
        );
        if (
          e.status === "accepted" &&
          ["onboarding", "offboarding"].includes(String(d.caseType))
        ) {
          const person = this.ref(cmd, "people", d.personId);
          if (person.status !== d.caseType)
            fail(
              "LIFECYCLE_ALREADY_APPLIED",
              "Odebrana sprawa została wykorzystana do przejścia osoby do kolejnego etapu. Utwórz osobną sprawę korekty.",
            );
        }
        const previousRevision = Number(d.scopeRevision);
        const previousRequirements = this.readinessStore.definitions(
          cmd.ctx.tenantId,
          e,
        );
        const previousTasks = this.taskStore.rows(
          cmd.ctx.tenantId,
          e.id,
          previousRevision,
        );
        const revision = previousRevision + 1;
        let deadlineShiftDays = 0;
        if (input.startDate !== undefined) {
          if (d.caseType !== "onboarding")
            fail(
              "START_DATE_ONBOARDING_ONLY",
              "Zmiana daty startu wymaga sprawy onboardingu.",
            );
          const person = this.ref(cmd, "people", d.personId);
          this.state(person, "onboarding");
          if (person.data.currentEmploymentEpisodeId !== d.employmentEpisodeId)
            fail("WRONG_LIFECYCLE", "Sprawa nie dotyczy bieżącej współpracy.");
          const older = this.db
            .prepare(
              "SELECT end_date FROM ops_employment WHERE tenant_id=? AND person_id=? AND id!=? ORDER BY start_date DESC LIMIT 1",
            )
            .get(cmd.ctx.tenantId, person.id, String(d.employmentEpisodeId)) as
            Row | undefined;
          if (
            older?.end_date &&
            String(input.startDate) <= String(older.end_date)
          )
            fail(
              "OVERLAPPING_EMPLOYMENT",
              "Data startu musi następować po poprzedniej współpracy.",
            );
          const currentEpisode = this.db
            .prepare(
              "SELECT start_date FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=? AND status='onboarding'",
            )
            .get(cmd.ctx.tenantId, String(d.employmentEpisodeId), person.id) as
            Row | undefined;
          if (!currentEpisode)
            fail(
              "EMPLOYMENT_REQUIRED",
              "Brak bieżącej współpracy do zmiany daty startu.",
            );
          deadlineShiftDays = Math.round(
            (Date.parse(`${String(input.startDate)}T00:00:00Z`) -
              Date.parse(`${String(currentEpisode.start_date)}T00:00:00Z`)) /
              86_400_000,
          );
          if (!Number.isFinite(deadlineShiftDays))
            fail(
              "INVALID_START_DATE",
              "Brak poprzedniej daty startu do przesunięcia terminów.",
            );
          this.db
            .prepare(
              "UPDATE ops_employment SET start_date=? WHERE tenant_id=? AND id=? AND person_id=? AND status='onboarding'",
            )
            .run(
              String(input.startDate),
              cmd.ctx.tenantId,
              String(d.employmentEpisodeId),
              person.id,
            );
          d.employmentStartDate = String(input.startDate);
          d.dueDate = String(input.startDate);
          person.data.employmentEpisodes = this.episodes(cmd, person.id);
          this.save(cmd, person);
        }
        if (input.ownerPrincipalId !== undefined) {
          const owner = this.livePrincipal(
            cmd.ctx.tenantId,
            String(input.ownerPrincipalId),
          );
          if (!owner || !this.canManageCase(owner, e.id))
            fail(
              "CASE_OWNER_UNAVAILABLE",
              "Właściciel odbioru musi mieć aktywne konto z dostępem do pełnej sprawy.",
              403,
            );
          d.ownerPrincipalId = owner.id;
        }
        if (input.dueDate !== undefined) d.dueDate = String(input.dueDate);
        d.scopeRevision = revision;
        d.brief = String(input.brief);
        d.acceptanceCriteria = String(input.acceptanceCriteria);
        d.scopeHistory = [
          ...arr(d.scopeHistory),
          {
            revision,
            brief: d.brief,
            acceptanceCriteria: d.acceptanceCriteria,
            dueDate: d.dueDate ?? null,
            employmentStartDate: d.employmentStartDate ?? null,
            ownerPrincipalId: d.ownerPrincipalId ?? null,
            reason: String(input.reason),
            createdAt: cmd.now,
          },
        ];
        e.status = "open";
        d.currentAcceptance = null;
        d.settlementDraft = null;
        if (d.caseType === "onboarding") {
          const episode = this.db
            .prepare(
              "SELECT start_date FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
            )
            .get(
              cmd.ctx.tenantId,
              String(d.employmentEpisodeId),
              String(d.personId),
            ) as Row | undefined;
          if (!episode)
            fail("EMPLOYMENT_REQUIRED", "Brak właściwej współpracy.");
          d.employmentStartDate = String(episode.start_date);
        }
        this.readinessStore.initialize(
          cmd.ctx.tenantId,
          e,
          input.requirements ??
            (previousRequirements.length ? previousRequirements : undefined),
          cmd.ctx.actorId ?? "system",
          cmd.now,
        );
        const ids = new Map(
          previousTasks.map((task) => [task.id, randomUUID()]),
        );
        for (const task of previousTasks)
          this.taskStore.insert(this.taskContext(cmd, e), {
            id: ids.get(task.id)!,
            title: task.title,
            required: task.required,
            kind: task.kind,
            ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}),
            ...(task.assigneePrincipalId
              ? { assigneePrincipalId: task.assigneePrincipalId }
              : {}),
            ...(task.assigneeRole ? { assigneeRole: task.assigneeRole } : {}),
            requiredScopes: task.requiredScopes,
            requirementKeys: task.requirementKeys,
            ...(task.dueDate
              ? {
                  dueDate: new Date(
                    Date.parse(`${task.dueDate}T00:00:00Z`) +
                      deadlineShiftDays * 86_400_000,
                  )
                    .toISOString()
                    .slice(0, 10),
                }
              : {}),
            dependsOn: task.dependsOn.map((id) => ids.get(id)!),
            allowUnassigned: true,
          });
        this.caseState(cmd, e);
      } else if (action === "cancel") {
        this.state(e, "open", "needs_changes", "awaiting_acceptance");
        this.cancelCase(cmd, e, String(input.reason));
      } else if (action === "submit") {
        this.state(e, "open", "needs_changes");
        this.readyForAcceptance(cmd, e);
        e.status = "awaiting_acceptance";
      } else if (action === "accept") {
        this.state(e, "awaiting_acceptance");
        this.human(cmd, input);
        if (d.ownerPrincipalId && d.ownerPrincipalId !== cmd.ctx.actorId)
          fail(
            "CASE_ACCEPTOR_REQUIRED",
            "Odbiór wymaga działania wskazanego właściciela odbioru.",
            403,
          );
        const readiness =
          input.decision === "accepted"
            ? this.readyForAcceptance(cmd, e)
            : this.readinessStore.evaluate(cmd.ctx.tenantId, e, cmd.now);
        const decision = String(input.decision),
          acceptanceId = randomUUID();
        this.db
          .prepare(
            "INSERT INTO ops_acceptances(tenant_id,id,case_id,scope_revision,decision,note,decided_by,created_at,scope_hash,bindings_hash,bindings_json,contract_version,requested_by,approved_by,person_id,employment_episode_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            cmd.ctx.tenantId,
            acceptanceId,
            e.id,
            Number(d.scopeRevision),
            decision,
            String(input.note),
            cmd.actor,
            cmd.now,
            readiness.scopeHash,
            readiness.bindingsHash,
            canonical(readiness.bindings),
            "p03",
            cmd.ctx.actorId ?? null,
            cmd.ctx.approvedBy ?? null,
            typeof d.personId === "string" ? d.personId : null,
            typeof d.employmentEpisodeId === "string"
              ? d.employmentEpisodeId
              : null,
          );
        e.status = decision === "accepted" ? "accepted" : "needs_changes";
        d.currentAcceptance = {
          id: acceptanceId,
          scopeRevision: d.scopeRevision!,
          decision,
          note: String(input.note),
          decidedBy: cmd.actor,
          requestedBy: cmd.ctx.actorId ?? null,
          approvedBy: cmd.ctx.approvedBy ?? null,
          scopeHash: readiness.scopeHash,
          bindingsHash: readiness.bindingsHash,
          contractVersion: "p03",
          createdAt: cmd.now,
        };
        this.caseState(cmd, e);
        if (decision === "accepted") {
          const worklogs = arr(d.worklogs);
          const totals: Record<string, number> = {};
          for (const worklog of worklogs) {
            if (worklog.currency)
              totals[String(worklog.currency)] =
                (totals[String(worklog.currency)] ?? 0) +
                Number(worklog.amountMinor);
          }
          d.settlementDraft = {
            kind: "draft",
            scopeRevision: d.scopeRevision!,
            declaredMinutes: worklogs.reduce(
              (sum, w) => sum + Number(w.minutes),
              0,
            ),
            declaredCosts: Object.entries(totals).map(
              ([currency, amountMinor]) => ({
                currency,
                amount: amountMinor / 100,
              }),
            ),
            worklogIds: worklogs.map((w) => w.id!),
            preparedAt: cmd.now,
            financialPosting: false,
            paymentExecuted: false,
          };
        }
      } else {
        this.state(e, "open", "needs_changes");
        if (action === "addWorklog") {
          if (String(input.performedOn) > this.companyDate(cmd))
            fail(
              "FUTURE_WORKLOG",
              "Nie można poświadczyć pracy w przyszłości.",
            );
          this.db
            .prepare("INSERT INTO ops_worklogs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              cmd.ctx.tenantId,
              randomUUID(),
              e.id,
              Number(d.scopeRevision),
              String(input.description),
              Number(input.minutes),
              String(input.performedOn),
              input.amount === undefined
                ? null
                : Math.round(Number(input.amount) * 100),
              input.currency ? String(input.currency) : null,
              cmd.ctx.actorId ?? "system",
              cmd.ctx.approvedBy ?? null,
              cmd.now,
            );
        }
        if (action === "addTask") {
          this.optionalRef(cmd, "people", input.assigneeId);
          const role = input.assigneeRole as TaskRole | undefined;
          this.taskStore.insert(this.taskContext(cmd, e), {
            title: String(input.title),
            required: Boolean(input.required),
            kind: input.kind as "work",
            ...(typeof input.assigneeId === "string"
              ? { assigneeId: input.assigneeId }
              : {}),
            ...(typeof input.assigneePrincipalId === "string"
              ? { assigneePrincipalId: input.assigneePrincipalId }
              : {}),
            ...(role ? { assigneeRole: role } : {}),
            requiredScopes: role
              ? roleScopes[role]
              : [
                  ...new Set([
                    "cases",
                    ...this.entityScopes("cases", d, cmd.ctx.tenantId),
                  ]),
                ],
            requirementKeys: (input.requirementKeys ?? []) as string[],
            ...(typeof input.dueDate === "string"
              ? { dueDate: input.dueDate }
              : {}),
            dependsOn: (input.dependsOn ?? []) as string[],
          });
        }
        if (
          [
            "acceptTask",
            "declineTask",
            "transferTask",
            "completeTask",
            "cancelTask",
          ].includes(action)
        )
          this.taskStore.transition(
            this.taskContext(cmd, e),
            action as TaskAction,
            input as unknown as TaskTransition,
          );
        if (action === "bindEvidence")
          this.readinessStore.bind(
            cmd.ctx,
            e,
            input as unknown as {
              requirementId: string;
              sourceModule: string;
              sourceId: string;
              sourceVersion: number;
            },
            cmd.now,
          );
        if (action === "addEvidence") {
          this.human(cmd, input);
          this.db
            .prepare("INSERT INTO ops_evidence VALUES(?,?,?,?,?,?,?,?,?)")
            .run(
              cmd.ctx.tenantId,
              randomUUID(),
              e.id,
              Number(d.scopeRevision),
              String(input.title),
              String(input.reference),
              String(input.note),
              cmd.actor,
              cmd.now,
            );
        }
        this.caseState(cmd, e);
      }
    }
    if (e.module === "assets") {
      if (action === "reserve") {
        this.state(e, "available");
        if (String(input.until) < this.companyDate(cmd))
          fail("RESERVATION_EXPIRED", "Data rezerwacji jest w przeszłości.");
        const person = this.ref(cmd, "people", input.personId);
        this.state(person, "onboarding", "active");
        const allocation = randomUUID();
        this.db
          .prepare(
            "INSERT INTO ops_allocations(tenant_id,id,asset_id,person_id,status,reserved_until,issued_on,returned_on) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            cmd.ctx.tenantId,
            allocation,
            e.id,
            person.id,
            "reserved",
            String(input.until),
            null,
            null,
          );
        e.status = "reserved";
        d.reservationPurpose = String(input.purpose);
      } else if (action === "markRepaired") {
        this.state(e, "maintenance");
        this.human(cmd, input);
        e.status = "available";
        d.condition = "good";
        d.repairNote = String(input.note);
      } else {
        const allocation = this.db
          .prepare(
            "SELECT * FROM ops_allocations WHERE tenant_id=? AND asset_id=? AND status IN ('reserved','issued')",
          )
          .get(cmd.ctx.tenantId, e.id) as Row | undefined;
        if (!allocation) fail("ALLOCATION_REQUIRED", "Brak aktywnej alokacji.");
        if (action === "issue") {
          this.state(e, "reserved");
          this.human(cmd, input);
          if (allocation.person_id !== input.personId)
            fail(
              "WRONG_RECIPIENT",
              "Wydanie musi dotyczyć osoby z rezerwacji.",
            );
          if (String(input.issuedOn) > this.companyDate(cmd))
            fail(
              "FUTURE_HANDOVER",
              "Nie można potwierdzić przyszłego wydania.",
            );
          const recipient = this.ref(cmd, "people", input.personId);
          this.state(recipient, "onboarding", "active");
          if (
            this.companyDate(cmd) > String(allocation.reserved_until) ||
            String(input.issuedOn) > String(allocation.reserved_until)
          )
            fail(
              "RESERVATION_EXPIRED",
              "Rezerwacja wygasła; zwolnij ją i utwórz nową.",
            );
          this.db
            .prepare(
              "UPDATE ops_allocations SET status='issued',issued_on=? WHERE tenant_id=? AND id=?",
            )
            .run(
              String(input.issuedOn),
              cmd.ctx.tenantId,
              String(allocation.id),
            );
          e.status = "issued";
          d.handover = {
            note: String(input.handoverNote),
            confirmedBy: cmd.actor,
            confirmedAt: cmd.now,
          };
        }
        if (action === "return") {
          this.state(e, "issued");
          this.human(cmd, input);
          if (String(input.returnedOn) > this.companyDate(cmd))
            fail("FUTURE_RETURN", "Nie można potwierdzić przyszłego zwrotu.");
          if (String(input.returnedOn) < String(allocation.issued_on))
            fail("INVALID_RETURN_DATE", "Zwrot nie może poprzedzać wydania.");
          this.db
            .prepare(
              "UPDATE ops_allocations SET status='returned',returned_on=? WHERE tenant_id=? AND id=?",
            )
            .run(
              String(input.returnedOn),
              cmd.ctx.tenantId,
              String(allocation.id),
            );
          d.condition = String(input.condition);
          e.status = input.condition === "good" ? "available" : "maintenance";
          d.returnReceipt = {
            note: String(input.receiptNote),
            confirmedBy: cmd.actor,
            confirmedAt: cmd.now,
          };
        }
        if (action === "release") {
          this.state(e, "reserved");
          this.db
            .prepare(
              "UPDATE ops_allocations SET status='released' WHERE tenant_id=? AND id=?",
            )
            .run(cmd.ctx.tenantId, String(allocation.id));
          e.status = "available";
          d.releaseReason = String(input.reason);
        }
      }
      d.allocations = (
        this.db
          .prepare(
            "SELECT id,person_id AS personId,status,reserved_until AS reservedUntil,issued_on AS issuedOn,returned_on AS returnedOn FROM ops_allocations WHERE tenant_id=? AND asset_id=? ORDER BY rowid",
          )
          .all(cmd.ctx.tenantId, e.id) as Row[]
      ).map(asJson);
    }
    if (e.module === "purchases") {
      if (action === "deactivate") {
        this.kind(e, "supplier");
        this.state(e, "active");
        const active = this.db
          .prepare(
            "SELECT id FROM ops_entities WHERE tenant_id=? AND module='purchases' AND json_extract(data_json,'$.supplierId')=? AND status NOT IN ('received','cancelled')",
          )
          .get(cmd.ctx.tenantId, e.id);
        if (active)
          fail("SUPPLIER_IN_USE", "Dostawca ma niezakończone zamówienia.");
        e.status = "inactive";
        d.deactivationReason = String(input.reason);
      } else {
        this.kind(e, "order");
        if (action === "placeOrder") {
          this.state(e, "draft");
          this.supplier(cmd, d.supplierId);
          e.status = "ordered";
          d.orderedAt = cmd.now;
          d.dispatch = "not_sent_local_record";
        }
        if (action === "acknowledge") {
          this.state(e, "ordered");
          this.human(cmd, input);
          if (String(input.acknowledgedOn) > this.companyDate(cmd))
            fail(
              "FUTURE_ACKNOWLEDGMENT",
              "Potwierdzenie nie może mieć przyszłej daty.",
            );
          e.status = "acknowledged";
          d.acknowledgment = {
            reference: String(input.supplierReference),
            date: String(input.acknowledgedOn),
            evidenceNote: String(input.evidenceNote),
            reportedBy: cmd.actor,
          };
        }
        if (action === "recordDelivery") {
          this.state(e, "acknowledged", "part_received");
          this.human(cmd, input);
          if (
            String(input.receivedOn) > this.companyDate(cmd) ||
            String(input.receivedOn) <
              String((d.acknowledgment as JsonObject).date)
          )
            fail(
              "INVALID_DELIVERY_DATE",
              "Dostawa musi nastąpić po potwierdzeniu i nie może być w przyszłości.",
            );
          const total =
            Number(d.receivedQuantity) + Number(input.quantityReceived);
          if (total > Number(d.quantity))
            fail(
              "DELIVERY_EXCEEDS_ORDER",
              "Dostawa przekracza zamówioną ilość.",
            );
          d.receivedQuantity = total;
          d.deliveries = [
            ...arr(d.deliveries),
            {
              id: randomUUID(),
              quantity: Number(input.quantityReceived),
              receivedOn: String(input.receivedOn),
              note: String(input.deliveryNote),
              reportedBy: cmd.actor,
            },
          ];
          e.status =
            total === Number(d.quantity) ? "received" : "part_received";
        }
        if (action === "cancel") {
          this.state(e, "draft", "ordered", "acknowledged");
          e.status = "cancelled";
          d.cancellationReason = String(input.reason);
        }
      }
    }
    if (e.module === "licenses") {
      this.state(e, "active");
      const count = () =>
        Number(
          (
            this.db
              .prepare(
                "SELECT count(*) AS n FROM ops_license_seats WHERE tenant_id=? AND license_id=? AND status='assigned'",
              )
              .get(cmd.ctx.tenantId, e.id) as Row
          ).n,
        );
      if (action === "assign") {
        const person = this.ref(cmd, "people", input.personId);
        this.state(person, "onboarding", "active");
        if (d.expiresOn && String(d.expiresOn) < this.companyDate(cmd))
          fail("LICENSE_EXPIRED", "Licencja wygasła.");
        if (count() >= Number(d.totalSeats))
          fail("NO_FREE_SEATS", "Wszystkie stanowiska są zajęte.");
        if (
          this.db
            .prepare(
              "SELECT id FROM ops_license_seats WHERE tenant_id=? AND license_id=? AND person_id=? AND status='assigned'",
            )
            .get(cmd.ctx.tenantId, e.id, person.id)
        )
          fail("SEAT_ALREADY_ASSIGNED", "Osoba ma już przydział tej licencji.");
        this.db
          .prepare(
            "INSERT INTO ops_license_seats(tenant_id,id,license_id,person_id,status,assigned_at,revoked_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            cmd.ctx.tenantId,
            randomUUID(),
            e.id,
            person.id,
            "assigned",
            cmd.now,
            null,
          );
        d.lastAssignmentNote = String(input.note);
      }
      if (action === "revoke") {
        this.ref(cmd, "people", input.personId);
        const result = this.db
          .prepare(
            "UPDATE ops_license_seats SET status='revoked',revoked_at=? WHERE tenant_id=? AND license_id=? AND person_id=? AND status='assigned'",
          )
          .run(cmd.now, cmd.ctx.tenantId, e.id, String(input.personId));
        if (!result.changes)
          fail("SEAT_NOT_ASSIGNED", "Nie ma aktywnego przydziału tej osoby.");
        d.revocationReason = String(input.reason);
      }
      if (action === "resize") {
        if (Number(input.totalSeats) < count())
          fail(
            "SEAT_CAP_BELOW_USAGE",
            "Limit nie może być mniejszy od aktywnych przydziałów.",
          );
        d.totalSeats = Number(input.totalSeats);
      }
      if (action === "renew") {
        this.human(cmd, input);
        if (String(input.expiresOn) < this.companyDate(cmd))
          fail("LICENSE_EXPIRED", "Nowa data ważności jest w przeszłości.");
        d.expiresOn = String(input.expiresOn);
        d.renewalEvidence = String(input.evidenceNote);
      }
      d.assignments = (
        this.db
          .prepare(
            "SELECT id,person_id AS personId,status,assigned_at AS assignedAt,revoked_at AS revokedAt FROM ops_license_seats WHERE tenant_id=? AND license_id=? ORDER BY rowid",
          )
          .all(cmd.ctx.tenantId, e.id) as Row[]
      ).map(asJson);
      d.assignedSeats = count();
    }
    if (e.module === "sales") {
      if (action === "qualify") {
        this.kind(e, "deal");
        this.state(e, "open");
        e.status = "qualified";
        d.qualification = String(input.qualification);
      }
      if (action === "submitOffer") {
        this.kind(e, "offer");
        this.state(e, "draft");
        const deal = this.ref(cmd, "sales", d.parentId);
        this.state(deal, "qualified");
        e.status = "proposed";
        d.dispatch = "not_sent_local_record";
      }
      if (action === "acceptOffer") {
        this.kind(e, "offer");
        this.state(e, "proposed");
        this.human(cmd, input);
        const deal = this.ref(cmd, "sales", d.parentId);
        this.state(deal, "qualified");
        if (String(input.acceptedOn) > this.companyDate(cmd))
          fail("FUTURE_ACCEPTANCE", "Akceptacja nie może mieć przyszłej daty.");
        e.status = "accepted";
        d.acceptance = {
          acceptedOn: String(input.acceptedOn),
          note: String(input.acceptanceNote),
          reportedBy: cmd.actor,
        };
      }
      if (action === "handoff") {
        this.kind(e, "offer");
        this.state(e, "accepted");
        const deal = this.ref(cmd, "sales", d.parentId);
        this.state(deal, "qualified");
        const c = this.create(
          cmd,
          "cases",
          `Realizacja: ${e.title}`,
          asJson({
            caseType: "delivery",
            brief: d.scope,
            acceptanceCriteria: input.acceptanceCriteria,
            ...(input.ownerId ? { ownerId: input.ownerId } : {}),
          }),
        );
        c.data.sourceOfferId = e.id;
        this.save(cmd, c);
        d.deliveryCaseId = c.id;
        e.status = "handed_over";
        deal.status = "won";
        deal.data.acceptedOfferId = e.id;
        deal.data.deliveryCaseId = c.id;
        this.save(cmd, deal);
      }
      if (action === "lose") {
        this.kind(e, "deal");
        this.state(e, "open", "qualified");
        this.human(cmd, input);
        if (
          this.db
            .prepare(
              "SELECT id FROM ops_entities WHERE tenant_id=? AND module='sales' AND json_extract(data_json,'$.parentId')=? AND status IN ('accepted','handed_over')",
            )
            .get(cmd.ctx.tenantId, e.id)
        )
          fail("ACCEPTED_OFFER_EXISTS", "Szansa ma zaakceptowaną ofertę.");
        e.status = "lost";
        d.lossReason = String(input.reason);
      }
      d.history = [
        ...arr(d.history),
        { action, actor: cmd.actor, at: cmd.now },
      ];
    }
    if (e.module === "recruitment") {
      if (action === "close") {
        this.kind(e, "vacancy");
        this.state(e, "open");
        if (
          this.db
            .prepare(
              "SELECT id FROM ops_entities WHERE tenant_id=? AND module='recruitment' AND json_extract(data_json,'$.vacancyId')=? AND status NOT IN ('rejected','withdrawn','hired')",
            )
            .get(cmd.ctx.tenantId, e.id)
        )
          fail("OPEN_APPLICATIONS", "Najpierw rozstrzygnij aktywne aplikacje.");
        e.status = "closed";
        d.closeReason = String(input.reason);
      } else {
        this.kind(e, "application");
        const vacancy = this.ref(cmd, "recruitment", d.vacancyId);
        this.state(vacancy, "open");
        if (action === "screen") {
          this.state(e, "new");
          this.human(cmd, input);
          e.status = input.decision === "advance" ? "screened" : "rejected";
        }
        if (action === "interview") {
          this.state(e, "screened");
          this.human(cmd, input);
          e.status = "interview";
        }
        if (action === "makeOffer") {
          this.state(e, "interview");
          e.status = "offered";
          d.offer = {
            terms: String(input.terms),
            startDate: String(input.startDate),
          };
        }
        if (action === "decide") {
          this.state(e, "offered");
          this.human(cmd, input);
          e.status = String(input.decision);
        }
        if (action === "hire") {
          this.state(e, "accepted");
          this.human(cmd, input);
          const person = this.ref(cmd, "people", d.personId);
          const episodeId = this.startEmployment(cmd, person, {
            ...input,
            employmentKind: d.employmentKind,
          });
          this.save(cmd, person);
          d.employmentEpisodeId = episodeId;
          e.status = "hired";
        }
        if (action === "withdraw") {
          this.state(e, "new", "screened", "interview", "offered", "accepted");
          this.human(cmd, input);
          e.status = "withdrawn";
        }
        d.decisions = [
          ...arr(d.decisions),
          {
            action,
            actor: cmd.actor,
            at: cmd.now,
            note: String(
              input.assessment ??
                input.reason ??
                input.terms ??
                "Zatwierdzenie rozpoczęcia współpracy",
            ),
            humanDecision: input.humanDecision === true,
          },
        ];
      }
    }
    if (e.module === "documents") {
      if (action === "revise") {
        this.state(e, "draft", "review", "approved", "rejected");
        const revision = Number(d.revision) + 1;
        this.documentVersion(cmd, e, String(input.content), revision);
        d.revision = revision;
        d.content = String(input.content);
        d.changeNote = String(input.changeNote);
        e.status = "draft";
      }
      if (action === "submit") {
        this.state(e, "draft");
        e.status = "review";
        this.db
          .prepare(
            "UPDATE ops_document_versions SET status='review' WHERE tenant_id=? AND document_id=? AND revision=?",
          )
          .run(cmd.ctx.tenantId, e.id, Number(d.revision));
      }
      if (action === "approve") {
        this.state(e, "review");
        this.human(cmd, input);
        e.status = String(input.decision);
        this.db
          .prepare(
            "UPDATE ops_document_versions SET status=?,decided_by=?,decision_note=?,decided_at=? WHERE tenant_id=? AND document_id=? AND revision=?",
          )
          .run(
            e.status,
            cmd.actor,
            String(input.note),
            cmd.now,
            cmd.ctx.tenantId,
            e.id,
            Number(d.revision),
          );
      }
      if (action === "archive") {
        this.state(e, "approved", "rejected");
        e.status = "archived";
        d.archiveReason = String(input.reason);
      }
      d.versions = this.docVersions(cmd, e.id);
    }
    if (e.module === "it") {
      if (action === "triage") {
        this.state(e, "observed", "open");
        this.optionalRef(cmd, "people", input.ownerId);
        e.status = "triaged";
        d.assessment = String(input.assessment);
        if (input.ownerId) d.ownerId = String(input.ownerId);
      }
      if (action === "promoteIncident") {
        this.kind(e, "observation");
        this.state(e, "observed", "triaged");
        const incident = this.create(
          cmd,
          "it",
          `Incydent: ${e.title}`,
          asJson({
            kind: "incident",
            description: input.description,
            severity: input.severity,
            environment: d.environment,
            ...(d.relatedAssetId ? { relatedAssetId: d.relatedAssetId } : {}),
          }),
        );
        d.incidentId = incident.id;
        e.status = "escalated";
      }
      if (action === "recordAction") {
        this.kind(e, "incident", "lab_case");
        this.state(e, "triaged", "investigating");
        this.human(cmd, input);
        d.actions = [
          ...arr(d.actions),
          {
            note: String(input.actionNote),
            evidenceNote: String(input.evidenceNote),
            reportedBy: cmd.actor,
            reportedAt: cmd.now,
            kind: "human_report",
          },
        ];
        e.status = "investigating";
      }
      if (action === "resolve") {
        this.state(e, "triaged", "investigating");
        this.human(cmd, input);
        e.status = "resolved";
        d.resolution = {
          note: String(input.resolution),
          evidenceNote: String(input.evidenceNote),
          reportedBy: cmd.actor,
          reportedAt: cmd.now,
        };
      }
      if (action === "reopen") {
        this.state(e, "resolved");
        e.status = e.data.kind === "observation" ? "observed" : "open";
        d.reopenReason = String(input.reason);
      }
    }
    return this.save(cmd, e);
  }
  private context(ctx: ToolContext) {
    ctx.signal.throwIfAborted();
    if (
      !ctx.tenantId ||
      !ctx.operationKey ||
      !ctx.runId ||
      !ctx.stepId ||
      [ctx.tenantId, ctx.operationKey, ctx.runId, ctx.stepId].some(
        (v) => v.length > 512,
      )
    )
      fail("INVALID_CONTEXT", "Brak poprawnego kontekstu wykonania.", 400);
  }
  private ledger(
    ctx: ToolContext,
    toolId: string,
    input: JsonObject,
  ): Row | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_commands WHERE tenant_id=? AND operation_key=?",
      )
      .get(ctx.tenantId, ctx.operationKey) as Row | undefined;
    if (row && (row.tool_id !== toolId || row.input_hash !== digest(input)))
      fail(
        "IDEMPOTENCY_CONFLICT",
        "Klucz operacji został już użyty dla innego polecenia.",
      );
    return row;
  }
  tools(): ToolDefinition[] {
    const catalog = this.catalog();
    return moduleIds.flatMap((module) => {
      const createSchema = z
        .object({
          title: z.string().trim().min(1).max(160),
          data: createDataSchemas[module],
        })
        .strict();
      const updateSchema = z
        .object({
          id: z.string().uuid(),
          expectedVersion: z.number().int().min(1),
          title: z.string().trim().min(1).max(160).optional(),
          data: editableSchemas[module].optional(),
        })
        .strict()
        .refine(
          (v) =>
            v.title !== undefined || (v.data && Object.keys(v.data).length > 0),
          "Pusta aktualizacja",
        );
      return Object.entries({
        create: createSchema,
        update: updateSchema,
        ...actionSchemas[module],
      }).map(([action, inputSchema]): ToolDefinition => {
        const toolId = `ops.${module}.${action}`;
        const lifecycle = [
          "people.startEmployment",
          "people.beginOffboarding",
          "recruitment.hire",
        ].includes(`${module}.${action}`);
        const taskTransition =
          module === "cases" &&
          [
            "acceptTask",
            "declineTask",
            "transferTask",
            "completeTask",
            "cancelTask",
          ].includes(action);
        const usesProfile =
          lifecycle || (module === "cases" && action === "addTask");
        const taskConsistent = (
          ctx: ToolContext,
          input: JsonObject,
        ): boolean => {
          if (!taskTransition) return true;
          try {
            const current = this.taskStore.get(
              ctx.tenantId,
              String(input.taskId),
            );
            let source = this.read(ctx.tenantId, "cases", current.caseId);
            if (source.data.scopeRevision !== current.scopeRevision) {
              const historical = this.db
                .prepare(
                  "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND json_extract(snapshot_json,'$.data.scopeRevision')=? ORDER BY version DESC LIMIT 1",
                )
                .get(ctx.tenantId, current.caseId, current.scopeRevision) as
                Row | undefined;
              if (!historical) return false;
              source = JSON.parse(String(historical.snapshot_json)) as Entity;
              if (digest(source) !== historical.snapshot_hash) return false;
            }
            const snapshot = arr(source.data.tasks).find(
              (task) => task.id === current.id,
            );
            const event = this.taskStore
              .history(ctx.tenantId, current.id)
              .at(-1);
            return (
              canonical(current) === canonical(snapshot) &&
              !!event &&
              event.taskVersion === current.version &&
              event.toStatus === current.status &&
              event.assigneePrincipalId === current.assigneePrincipalId &&
              event.performedBy === current.performedBy
            );
          } catch {
            return false;
          }
        };
        const requireCommittedTask = (ctx: ToolContext, input: JsonObject) => {
          if (
            taskTransition &&
            !this.taskStore.verifyCommitted(ctx, String(input.taskId))
          )
            fail(
              "TASK_RECEIPT_FORBIDDEN",
              "Brak aktualnych uprawnień do potwierdzonej operacji zadania.",
              403,
            );
        };
        const requiredScopes =
          module === "people" && action !== "create" && action !== "update"
            ? ["cases"]
            : module === "recruitment" && action === "hire"
              ? ["people", "cases"]
              : module === "sales" && action === "handoff"
                ? ["cases"]
                : (module === "assets" &&
                      ["reserve", "issue"].includes(action)) ||
                    (module === "licenses" &&
                      ["assign", "revoke"].includes(action))
                  ? ["people"]
                  : [];
        const definition = catalog.find((m) => m.id === module)!;
        const actionLabel =
          action === "create"
            ? "Utwórz rekord"
            : action === "update"
              ? "Zapisz zmiany"
              : (definition.actions.find((item) => item.id === action)?.label ??
                action);
        return {
          id: toolId,
          version: "3",
          ...(taskTransition
            ? {
                canAccess: (
                  principal: Principal,
                  input: JsonObject,
                  context?: import("./contracts.js").ToolAccessContext,
                ) =>
                  this.taskStore.canAccess(
                    principal,
                    input,
                    context,
                    action as TaskAction,
                  ),
              }
            : { scope: module }),
          requiredScopes,
          requiredScopesForInput: (input: JsonObject, tenantId: string) => {
            if (!taskTransition)
              return this.inputScopes(module, action, input, tenantId);
            const task = this.taskStore.get(tenantId, String(input.taskId));
            if (task.caseId !== input.id)
              fail(
                "TASK_NOT_FOUND",
                "Zadanie nie należy do wskazanej sprawy.",
                404,
              );
            // Transfer is allowed either to the current worker or a full-case
            // manager. The domain adapter enforces that OR using live identity.
            return ["transferTask", "cancelTask"].includes(action)
              ? []
              : task.requiredScopes;
          },
          effect: "write",
          recovery: "reconcile",
          description: `${definition.label}: ${actionLabel}.${["people.startEmployment", "people.beginOffboarding", "recruitment.hire"].includes(`${module}.${action}`) ? " Tworzy powiązaną sprawę i obowiązkowe zadania człowieka." : module === "sales" && action === "handoff" ? " Tworzy sprawę realizacji oraz zamyka powiązaną szansę jako wygraną." : ""} Zmienia wyłącznie lokalne dane JARVIS.`,
          inputSchema,
          ...(usesProfile
            ? {
                prepareInput: (input: JsonObject, tenantId: string) => {
                  const profile = this.currentProfile(tenantId);
                  const prepared: JsonObject = profile
                    ? { ...input, profileVersion: profile.version }
                    : { ...input };
                  if (
                    module === "cases" &&
                    action === "addTask" &&
                    !Object.hasOwn(input, "assigneePrincipalId")
                  )
                    prepared.assigneePrincipalId = input.assigneeRole
                      ? (this.taskStore.resolveRole(
                          tenantId,
                          profile?.roleBindings ?? {},
                          input.assigneeRole as TaskRole,
                        ) ?? null)
                      : null;
                  return prepared;
                },
              }
            : {}),
          execute: async (ctx, raw) => {
            this.context(ctx);
            const parsed = inputSchema.safeParse(raw);
            if (!parsed.success)
              fail(
                "INVALID_DOMAIN_INPUT",
                "Niepoprawne lub brakujące pola polecenia.",
                400,
              );
            const input = asJson(parsed.data);
            const p = input as CommandInput;
            const profile = usesProfile
              ? this.pinnedProfile(ctx.tenantId, input)
              : this.currentProfile(ctx.tenantId);
            this.db.exec("BEGIN IMMEDIATE");
            try {
              const existing = this.ledger(ctx, toolId, input);
              if (existing) {
                requireCommittedTask(ctx, input);
                if (!taskConsistent(ctx, input))
                  fail(
                    "TASK_STATE_INCONSISTENT",
                    "Bieżący stan zadania nie odpowiada zapisanej historii.",
                  );
                this.db.exec("COMMIT");
                return JSON.parse(String(existing.receipt_json)) as ToolResult;
              }
              const cmd: Command = {
                ctx,
                actor: ctx.actorId ?? "system",
                now: new Date(
                  this.options.clock?.() ?? Date.now(),
                ).toISOString(),
                toolId,
                profile,
                changes: [],
              };
              let e: Entity;
              if (action === "create")
                e = this.create(cmd, module, String(p.title), asJson(p.data!));
              else {
                e = this.read(ctx.tenantId, module, String(p.id));
                if (e.version !== p.expectedVersion)
                  fail(
                    "VERSION_CONFLICT",
                    "Rekord zmienił się. Odczytaj aktualną wersję.",
                  );
                if (action === "update") {
                  if (
                    [
                      "accepted",
                      "handed_over",
                      "hired",
                      "archived",
                      "cancelled",
                      "received",
                      "exited",
                    ].includes(e.status)
                  )
                    fail(
                      "IMMUTABLE_RECORD",
                      "Zamknięty rekord wymaga właściwej operacji domenowej.",
                    );
                  if (
                    p.data &&
                    Object.keys(p.data).length &&
                    (["documents", "cases", "licenses"].includes(module) ||
                      ![
                        "draft",
                        "registered",
                        "available",
                        "open",
                        "new",
                        "active",
                      ].includes(e.status))
                  )
                    fail(
                      "REVISION_REQUIRED",
                      "Zmień zakres przez właściwą rewizję lub operację domenową.",
                    );
                  if (p.title !== undefined) e.title = p.title;
                  if (p.data) e.data = { ...e.data, ...p.data };
                  e = this.save(cmd, e);
                } else e = this.change(cmd, e, action, p);
              }
              const task = taskTransition
                ? this.taskStore.get(ctx.tenantId, String(input.taskId))
                : undefined;
              const receipt: ToolResult = {
                data: task
                  ? {
                      entityId: e.id,
                      module: e.module,
                      version: e.version,
                      taskId: task.id,
                      taskVersion: task.version,
                      status: task.status,
                    }
                  : {
                      entityId: e.id,
                      module: e.module,
                      version: e.version,
                      status: e.status,
                      title: e.title,
                    },
              };
              const changes = cmd.changes.map((v) => ({
                id: v.id,
                module: v.module,
                version: v.version,
                hash: digest(v),
              }));
              this.db
                .prepare("INSERT INTO ops_commands VALUES(?,?,?,?,?,?,?)")
                .run(
                  ctx.tenantId,
                  ctx.operationKey,
                  toolId,
                  digest(input),
                  canonical(receipt),
                  canonical(changes),
                  cmd.now,
                );
              this.db
                .prepare("INSERT INTO ops_outbox VALUES(?,?,?,?,?,?,?)")
                .run(
                  randomUUID(),
                  ctx.tenantId,
                  ctx.operationKey,
                  toolId,
                  canonical({
                    entityId: e.id,
                    module,
                    version: e.version,
                    runId: ctx.runId,
                    stepId: ctx.stepId,
                  }),
                  "pending",
                  cmd.now,
                );
              this.db.exec("COMMIT");
              return receipt;
            } catch (error) {
              this.db.exec("ROLLBACK");
              throw error;
            }
          },
          reconcile: async (ctx, raw) => {
            this.context(ctx);
            const parsed = inputSchema.safeParse(raw);
            if (!parsed.success)
              fail("INVALID_DOMAIN_INPUT", "Niepoprawne pola polecenia.", 400);
            if (lifecycle)
              this.pinnedProfile(ctx.tenantId, asJson(parsed.data));
            const row = this.ledger(ctx, toolId, asJson(parsed.data));
            if (row) {
              requireCommittedTask(ctx, asJson(parsed.data));
              if (!taskConsistent(ctx, asJson(parsed.data)))
                fail(
                  "TASK_STATE_INCONSISTENT",
                  "Bieżący stan zadania nie odpowiada zapisanej historii.",
                );
            }
            return row
              ? {
                  status: "applied",
                  result: JSON.parse(String(row.receipt_json)) as ToolResult,
                }
              : { status: "not_applied" };
          },
          verify: async (ctx, raw, result) => {
            this.context(ctx);
            const parsed = inputSchema.safeParse(raw);
            if (!parsed.success)
              fail("INVALID_DOMAIN_INPUT", "Niepoprawne pola polecenia.", 400);
            const row = this.ledger(ctx, toolId, asJson(parsed.data));
            if (row) requireCommittedTask(ctx, asJson(parsed.data));
            let ok = Boolean(
              row &&
              canonical(result) === row.receipt_json &&
              taskConsistent(ctx, asJson(parsed.data)),
            );
            const observed: JsonObject[] = [];
            if (row) {
              const changes = JSON.parse(String(row.changes_json)) as {
                id: string;
                module: ModuleId;
                version: number;
                hash: string;
              }[];
              for (const change of changes) {
                const version = this.db
                  .prepare(
                    "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
                  )
                  .get(ctx.tenantId, change.id, change.version) as
                  Row | undefined;
                const entity = this.db
                  .prepare(
                    "SELECT * FROM ops_entities WHERE tenant_id=? AND id=? AND module=?",
                  )
                  .get(ctx.tenantId, change.id, change.module) as
                  Row | undefined;
                const currentSnapshot = entity
                  ? (this.db
                      .prepare(
                        "SELECT snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
                      )
                      .get(ctx.tenantId, change.id, Number(entity.version)) as
                      Row | undefined)
                  : undefined;
                const valid = Boolean(
                  version &&
                  entity &&
                  currentSnapshot &&
                  Number(entity.version) >= change.version &&
                  version.snapshot_hash === change.hash &&
                  digest(JSON.parse(String(version.snapshot_json))) ===
                    change.hash &&
                  digest(this.fromRow(entity)) ===
                    currentSnapshot.snapshot_hash,
                );
                ok = ok && valid;
                observed.push({
                  entityId: change.id,
                  module: change.module,
                  committedVersion: change.version,
                  currentVersion: entity ? Number(entity.version) : null,
                  currentStatus: entity ? String(entity.status) : null,
                  versionConfirmed: valid,
                });
              }
              if (!changes.length) ok = false;
            }
            return {
              ok,
              summary: ok
                ? "Niezależny odczyt potwierdza zapisane wersje i wynik polecenia."
                : "Nie znaleziono spójnego dowodu skutku polecenia.",
              evidence: [
                {
                  source: "jarvis-operations:entity-versions",
                  summary:
                    "Odczyt rejestru poleceń, zapisanych wersji oraz aktualnych rekordów wyłącznie w tej organizacji.",
                  observedAt: new Date().toISOString(),
                  data: {
                    tenantId: ctx.tenantId,
                    operationKey: ctx.operationKey,
                    toolId,
                    records: observed,
                  },
                },
              ],
            };
          },
        };
      });
    });
  }
  health() {
    return Number((this.db.prepare("SELECT 1 AS ok").get() as Row).ok) === 1;
  }
  close() {
    this.db.close();
  }
}
