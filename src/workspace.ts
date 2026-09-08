import { AssetRegister, migrateAssetRegister } from "./asset-register.js";
import { AccessRegister, migrateAccessRegister } from "./access-register.js";
import {
  applicationDataSchema,
  accessBundleDataSchema,
  type AccessEvent,
} from "./access-models.js";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { migrateDatabase } from "./migrations.js";
import {
  AssetCustody,
  migrateAssetCustody,
  migrateCustodyMultipleAssets,
  companyDay,
  type CustodyEvent,
} from "./asset-custody.js";
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
  employmentPolicySchema,
  defaultEmploymentPolicy,
  type EmploymentPolicy,
  type EngagementRef,
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
  migrateTaskCustody,
  type AssetTaskAction,
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
export interface EmploymentEpisode {
  id: string;
  personId: string;
  version: number;
  kind: "internal" | "contractor";
  status: "onboarding" | "active" | "offboarding" | "ended";
  startDate: string;
  endDate: string | null;
  endReason: string | null;
  role: string;
  onboardingCaseId: string | null;
  offboardingCaseId: string | null;
  engagementRef: EngagementRef | null;
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
  employmentPolicy?: EmploymentPolicy;
}
const lifecycleProfileSchema = z
  .object({
    version: z.number().int().min(0),
    definitionVersion: z.enum(["2", "3"]),
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
    employmentPolicy: employmentPolicySchema,
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
  custodyEvent?: CustodyEvent;
  replacement?: JsonObject;
  accessEvent?: AccessEvent;
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
  assets: createDataSchemas.assets
    .pick({ manufacturer: true, model: true })
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
  private readonly registerStore: AssetRegister;
  private readonly custodyStore: AssetCustody;
  private readonly accessStore: AccessRegister;
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
        {
          version: 4,
          name: "Explicit versioned employment episodes and resource ownership",
          up: (db) => {
            db.exec(`ALTER TABLE ops_employment ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
              ALTER TABLE ops_employment ADD COLUMN onboarding_case_id TEXT;
              ALTER TABLE ops_employment ADD COLUMN offboarding_case_id TEXT;
              ALTER TABLE ops_employment ADD COLUMN engagement_module TEXT;
              ALTER TABLE ops_employment ADD COLUMN engagement_id TEXT;
              ALTER TABLE ops_employment ADD COLUMN engagement_key TEXT;
              ALTER TABLE ops_employment ADD COLUMN end_reason TEXT;
              ALTER TABLE ops_employment ADD COLUMN updated_at TEXT;`);
            for (const episode of db
              .prepare("SELECT tenant_id,id,person_id FROM ops_employment")
              .all() as Row[]) {
              for (const type of ["onboarding", "offboarding"] as const) {
                const candidates = db
                  .prepare(
                    "SELECT id FROM ops_entities WHERE tenant_id=? AND module='cases' AND json_extract(data_json,'$.caseType')=? AND json_extract(data_json,'$.employmentEpisodeId')=? AND json_extract(data_json,'$.personId')=?",
                  )
                  .all(
                    String(episode.tenant_id),
                    type,
                    String(episode.id),
                    String(episode.person_id),
                  ) as Row[];
                if (candidates.length === 1)
                  db.prepare(
                    `UPDATE ops_employment SET ${type}_case_id=? WHERE tenant_id=? AND id=?`,
                  ).run(
                    String(candidates[0]!.id),
                    String(episode.tenant_id),
                    String(episode.id),
                  );
              }
            }
            // Historical nullable resource links remain unresolved. All new
            // writes below require explicit episode identity and policy guards.
            db.exec(`DROP INDEX ops_one_open_employment;
              CREATE UNIQUE INDEX ops_one_open_engagement ON ops_employment(tenant_id,person_id,engagement_key) WHERE status!='ended' AND engagement_key IS NOT NULL;
              CREATE UNIQUE INDEX ops_one_open_internal ON ops_employment(tenant_id,person_id) WHERE status!='ended' AND kind='internal';
              DROP INDEX ops_unique_seat;
              CREATE UNIQUE INDEX ops_unique_episode_seat ON ops_license_seats(tenant_id,license_id,person_id,employment_episode_id) WHERE status='assigned' AND employment_episode_id IS NOT NULL;
              CREATE UNIQUE INDEX ops_unique_legacy_seat ON ops_license_seats(tenant_id,license_id,person_id) WHERE status='assigned' AND employment_episode_id IS NULL;`);
          },
        },
        {
          version: 5,
          name: "Versioned asset custody and authentic handover events",
          up: (db) => {
            migrateAssetCustody(db);
            migrateTaskCustody(db);
          },
        },
        {
          version: 6,
          name: "Asset register history",
          up: migrateAssetRegister,
        },
        {
          version: 7,
          name: "Atomic reservation replacement across two assets",
          up: migrateCustodyMultipleAssets,
        },
        {
          version: 8,
          name: "Versioned access catalog and human attestations",
          up: migrateAccessRegister,
        },
      ],
    });
    this.registerStore = new AssetRegister(this.db);
    this.custodyStore = new AssetCustody(this.db);
    this.accessStore = new AccessRegister(this.db);
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
      (tenant, caseId) =>
        this.readinessStore.evaluate(
          tenant,
          this.read(tenant, "cases", caseId),
          new Date(this.options.clock?.() ?? Date.now()).toISOString(),
        ).scopeHash,
      (tenant) => this.currentProfile(tenant)?.version ?? 0,
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
  taskEquipment(principal: Principal, taskId: string) {
    return this.taskStore.assetProjection(
      principal,
      taskId,
      new Date(this.options.clock?.() ?? Date.now()).toISOString(),
    );
  }
  caseAccess(principal: Principal, caseId: string) {
    const e = this.get(principal, "cases", caseId);
    this.scope(principal, "it");
    const grants = this.accessStore.list(principal.tenantId, e.id);
    const now = new Date(this.options.clock?.() ?? Date.now()).toISOString();
    const bound = this.readinessStore.bindings(
      principal.tenantId,
      e.id,
      Number(e.data.scopeRevision),
    );
    const requirements = this.readinessStore
      .requirements(principal.tenantId, e.id, Number(e.data.scopeRevision))
      .filter((r) => r.kind === "access_attested")
      .map((r) => {
        try {
          return {
            id: r.id,
            title: r.title,
            expected: r.expected,
            bound: bound.some((b) => b.requirementId === r.id),
            assessment: this.accessStore.assessment(
              principal.tenantId,
              e.id,
              r.id,
              now,
            ),
            problem: null,
          };
        } catch (error) {
          return {
            id: r.id,
            title: r.title,
            expected: r.expected,
            bound: bound.some((b) => b.requirementId === r.id),
            assessment: null,
            problem:
              error instanceof DomainError
                ? error.message
                : "Nie można potwierdzić źródła dostępu.",
          };
        }
      });
    return {
      caseId,
      requirements,
      grants: grants.map((grant) => ({
        ...grant,
        events: this.accessStore.history(principal.tenantId, grant.id),
      })),
    };
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
      definitions: this.readinessStore.definitions(principal.tenantId, e),
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
  /** Trusted in-process configuration writer only. Lock order is operations
   * before profiles, so an approved policy cannot change during a domain write. */
  acquireEmploymentPolicyLock(): () => void {
    this.db.exec("BEGIN IMMEDIATE");
    let released = false;
    return () => {
      if (!released) {
        this.db.exec("ROLLBACK");
        released = true;
      }
    };
  }
  private currentProfile(tenantId: string): LifecycleProfile | undefined {
    if (!this.profileProvider) return undefined;
    const profile = this.profileProvider(tenantId);
    if (!["2", "3"].includes(profile.definitionVersion)) return undefined;
    return lifecycleProfileSchema.parse({
      version: profile.version,
      definitionVersion: profile.definitionVersion,
      timezone: profile.timezone ?? "Europe/Warsaw",
      roleBindings: profile.roleBindings,
      processTemplates: profile.processTemplates,
      employmentPolicy:
        profile.definitionVersion === "3"
          ? profile.employmentPolicy
          : defaultEmploymentPolicy,
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
      !["2", "3"].includes(this.profileProvider(tenantId).definitionVersion)
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
    if (entity.module === "people")
      this.syncPerson({ ctx: { tenantId: tenant } }, entity);
    if (entity.module === "assets")
      entity.data.allocations = this.allocations(tenant, entity.id);
    if (entity.module === "licenses")
      entity.data.assignments = this.licenseAssignments(tenant, entity.id);
    return entity;
  }
  assetRegister(
    principal: Principal,
    assetId: string,
    page: { limit?: number; offset?: number } = {},
  ) {
    const asset = this.get(principal, "assets", assetId);
    return {
      ...this.registerStore.history(
        principal.tenantId,
        assetId,
        page.limit,
        page.offset,
      ),
      historyFromVersion: asset.data.registerHistoryFromVersion ?? null,
      consistent: this.registerStore.verify(principal.tenantId, asset),
    };
  }
  private allocations(tenant: string, assetId: string): JsonObject[] {
    return this.custodyStore.rows(tenant, assetId).map(asJson);
  }
  assetCustody(
    principal: Principal,
    assetId: string,
    page: { limit?: number; offset?: number } = {},
  ) {
    this.get(principal, "assets", assetId);
    const now = this.options.clock?.() ?? Date.now();
    return {
      assetId,
      allocations: this.custodyStore
        .rows(principal.tenantId, assetId)
        .map((a) => {
          let recipientLabel: string | undefined,
            engagementLabel: string | undefined;
          try {
            recipientLabel = this.get(principal, "people", a.personId).title;
            const episode = this.listEmploymentEpisodes(
              principal,
              a.personId,
            ).find((e) => e.id === a.employmentEpisodeId);
            if (episode) {
              engagementLabel = `${episode.kind === "internal" ? "Współpraca wewnętrzna" : "Współpraca konsultanta"} · ${episode.startDate}`;
              if (episode.engagementRef) {
                try {
                  engagementLabel = `${this.get(principal, episode.engagementRef.module, episode.engagementRef.id).title} · ${episode.startDate}`;
                } catch (error) {
                  if (
                    !(error instanceof DomainError) ||
                    ![403, 404].includes(error.statusCode)
                  )
                    throw error;
                }
              }
            }
          } catch (error) {
            if (
              !(error instanceof DomainError) ||
              ![403, 404].includes(error.statusCode)
            )
              throw error;
          }
          return {
            ...a,
            ...(recipientLabel ? { recipientLabel } : {}),
            ...(engagementLabel ? { engagementLabel } : {}),
            expired:
              a.status === "reserved" &&
              a.expiresAt !== null &&
              now >= Date.parse(a.expiresAt),
          };
        }),
      ...this.custodyStore.history(
        principal.tenantId,
        assetId,
        page.limit ?? 50,
        page.offset ?? 0,
      ),
    };
  }
  private licenseAssignments(tenant: string, licenseId: string): JsonObject[] {
    return (
      this.db
        .prepare(
          "SELECT id,person_id AS personId,employment_episode_id AS employmentEpisodeId,case_id AS caseId,status,assigned_at AS assignedAt,revoked_at AS revokedAt FROM ops_license_seats WHERE tenant_id=? AND license_id=? ORDER BY rowid",
        )
        .all(tenant, licenseId) as Row[]
    ).map(asJson);
  }
  private relationalStateMatches(tenant: string, entity: Entity): boolean {
    if (entity.module === "cases")
      return (
        canonical(entity.data.accessGrantRefs ?? []) ===
        canonical(this.accessRefs(tenant, entity.id))
      );
    if (entity.module === "people")
      return (
        canonical(entity.data.employmentEpisodes) ===
        canonical(
          this.employmentRows(tenant, entity.id).map((row) =>
            this.projectEpisode(row),
          ),
        )
      );
    if (entity.module === "assets")
      return (
        canonical(entity.data.allocations) ===
          canonical(this.allocations(tenant, entity.id)) &&
        this.custodyStore.verify(tenant, entity.id) &&
        this.registerStore.verify(tenant, entity)
      );
    if (entity.module === "licenses")
      return (
        canonical(entity.data.assignments) ===
        canonical(this.licenseAssignments(tenant, entity.id))
      );
    return true;
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
    if (
      module === "it" &&
      ["application", "access_bundle"].includes(String(data.kind))
    ) {
      scopes.push("company");
      for (const member of arr(
        action === "reviseAccessBundle" ? input.members : data.members,
      )) {
        this.read(tenant, "it", String(member.applicationId));
        if (member.licenseId) {
          this.read(tenant, "licenses", String(member.licenseId));
          scopes.push("licenses");
        }
      }
    }
    if (
      module === "cases" &&
      ["attestAccess", "renewAccess", "revokeAccess"].includes(action)
    ) {
      scopes.push("it");
      if (input.licenseSeatId || input.licenseVersion !== undefined)
        scopes.push("licenses");
      if (action === "revokeAccess") {
        const grant = this.accessStore.get(tenant, String(input.grantId));
        const origin = this.read(tenant, "cases", grant.caseId);
        scopes.push(...this.entityScopes("cases", origin.data, tenant));
      } else {
        const requirement = this.readinessStore
          .requirements(tenant, String(input.id), Number(data.scopeRevision))
          .find((r) => r.id === input.requirementId);
        if (typeof requirement?.expected.bundleId === "string") {
          const bundle = this.read(tenant, "it", requirement.expected.bundleId);
          if (
            arr(bundle.data.members).find((m) => m.key === input.memberKey)
              ?.licenseId
          )
            scopes.push("licenses");
        }
      }
    }
    if (
      input.engagementRef &&
      typeof input.engagementRef === "object" &&
      !Array.isArray(input.engagementRef)
    ) {
      const reference = input.engagementRef as JsonObject;
      const target = this.module(String(reference.module));
      const engagement = this.read(tenant, target, String(reference.id));
      scopes.push(
        target,
        ...this.entityScopes(target, engagement.data, tenant),
      );
    }
    if (["assets", "licenses"].includes(module) && input.caseId) {
      const record = this.read(tenant, "cases", String(input.caseId));
      scopes.push("cases", ...this.entityScopes("cases", record.data, tenant));
    }

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
          ["bundleId", "it"],
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
    this.registerStore.record(cmd.ctx, cmd.toolId, entity);
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
    this.registerStore.prepare(entity);
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
    this.registerStore.prepare(entity);
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
      if (data.kind === "application") {
        const parsed = applicationDataSchema.safeParse(data);
        if (!parsed.success)
          fail(
            "INVALID_APPLICATION",
            "Podaj klucz aplikacji i niepowtarzającą się listę ról.",
            400,
          );
        status = "active";
      } else if (data.kind === "access_bundle") {
        const parsed = accessBundleDataSchema.safeParse(data);
        if (!parsed.success)
          fail(
            "INVALID_ACCESS_BUNDLE",
            "Zestaw wymaga klucza i pełnej, niepowtarzającej się listy aplikacji i ról.",
            400,
          );
        this.accessStore.validateMembers(cmd.ctx.tenantId, parsed.data.members);
        status = "active";
      } else {
        if (
          !data.severity ||
          !data.environment ||
          ["applicationKey", "supportedRoles", "accessKey", "members"].some(
            (key) => data[key] !== undefined,
          )
        )
          fail(
            "INVALID_IT_RECORD",
            "Obserwacja lub incydent wymagają środowiska i ważności oraz własnego zakresu pól.",
            400,
          );
        this.optionalRef(cmd, "assets", data.relatedAssetId);
        status = data.kind === "observation" ? "observed" : "open";
        data.actions = [];
        data.externalActionsPerformed = false;
      }
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
  private employmentRows(tenantId: string, personId: string): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM ops_employment WHERE tenant_id=? AND person_id=? ORDER BY start_date,id",
      )
      .all(tenantId, personId) as Row[];
  }
  private projectEpisode(row: Row): EmploymentEpisode {
    return {
      id: String(row.id),
      personId: String(row.person_id),
      version: Number(row.version),
      kind: row.kind as EmploymentEpisode["kind"],
      status: row.status as EmploymentEpisode["status"],
      startDate: String(row.start_date),
      endDate: row.end_date ? String(row.end_date) : null,
      endReason: row.end_reason ? String(row.end_reason) : null,
      role: String(row.role),
      onboardingCaseId: row.onboarding_case_id
        ? String(row.onboarding_case_id)
        : null,
      offboardingCaseId: row.offboarding_case_id
        ? String(row.offboarding_case_id)
        : null,
      engagementRef:
        row.engagement_module && row.engagement_id
          ? {
              module: row.engagement_module as EngagementRef["module"],
              id: String(row.engagement_id),
            }
          : null,
    };
  }
  listEmploymentEpisodes(
    principal: Principal,
    personId: string,
  ): EmploymentEpisode[] {
    this.get(principal, "people", personId);
    return this.employmentRows(principal.tenantId, personId).map((row) =>
      this.projectEpisode(row),
    );
  }
  private employmentEpisode(
    cmd: Command,
    personId: string,
    input: CommandInput,
    states?: string[],
  ): Row {
    const episode = this.db
      .prepare(
        "SELECT * FROM ops_employment WHERE tenant_id=? AND person_id=? AND id=?",
      )
      .get(
        cmd.ctx.tenantId,
        personId,
        String(input.employmentEpisodeId ?? ""),
      ) as Row | undefined;
    if (!episode)
      fail(
        "EMPLOYMENT_REQUIRED",
        "Nie znaleziono wskazanego okresu tej osoby.",
      );
    if (episode.version !== input.expectedEpisodeVersion)
      fail(
        "EPISODE_VERSION_CONFLICT",
        "Okres współpracy zmienił wersję. Odczytaj aktualny okres i przygotuj nowy plan.",
      );
    if (states && !states.includes(String(episode.status)))
      fail(
        "INVALID_TRANSITION",
        "Wskazany okres współpracy nie pozwala na to działanie.",
      );
    return episode;
  }
  private replacementPins(tenantId: string, input: CommandInput): JsonObject {
    const allocation = this.custodyStore.get(
      tenantId,
      String(input.id),
      String(input.allocationId),
    );
    this.custodyStore.assertConsistent(tenantId, allocation);
    if (
      allocation.provenance !== "p05" ||
      !allocation.employmentEpisodeId ||
      !allocation.caseId ||
      !allocation.expiresAt ||
      !allocation.timezone
    )
      fail(
        "REPLACEMENT_UNRESOLVED",
        "Zamiana wymaga rezerwacji ze znaną współpracą, sprawą i terminem UTC.",
      );
    const episode = this.db
      .prepare(
        "SELECT version FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
      )
      .get(tenantId, allocation.employmentEpisodeId, allocation.personId);
    if (!episode)
      fail(
        "EMPLOYMENT_REQUIRED",
        "Nie znaleziono okresu współpracy tej rezerwacji.",
      );
    const linkedCase = this.read(tenantId, "cases", allocation.caseId);
    return {
      personId: allocation.personId,
      employmentEpisodeId: allocation.employmentEpisodeId,
      expectedEpisodeVersion: Number(episode.version),
      caseId: allocation.caseId,
      reservedUntil: allocation.reservedUntil,
      expiresAt: allocation.expiresAt,
      reservationTimezone: allocation.timezone,
      reservationProfileVersion: allocation.profileVersion,
      expectedCaseVersion: linkedCase.version,
      expectedScopeRevision: Number(linkedCase.data.scopeRevision),
    };
  }
  private replaceReservation(
    cmd: Command,
    source: Entity,
    input: CommandInput,
  ): Entity {
    const tenant = cmd.ctx.tenantId;
    this.state(source, "reserved");
    const allocation = this.custodyStore.get(
      tenant,
      source.id,
      String(input.allocationId),
    );
    const pins = this.replacementPins(tenant, input);
    if (Object.entries(pins).some(([key, value]) => input[key] !== value))
      fail(
        "REPLACEMENT_BINDING_CHANGED",
        "Osoba, współpraca lub termin nie odpowiadają zatwierdzonej rezerwacji. Przygotuj nowy plan.",
      );
    if (
      allocation.status !== "reserved" ||
      allocation.version !== input.expectedAllocationVersion
    )
      fail(
        "ALLOCATION_VERSION_CONFLICT",
        "Wskazana rezerwacja zmieniła się. Przygotuj nowy plan.",
      );
    if (Date.parse(cmd.now) >= Date.parse(allocation.expiresAt!))
      fail("RESERVATION_EXPIRED", "Nie można zamienić wygasłej rezerwacji.");
    this.resourceEpisode(cmd, input, ["onboarding", "active"]);
    const target = this.read(
      tenant,
      "assets",
      String(input.replacementAssetId),
    );
    if (target.id === source.id)
      fail("REPLACEMENT_SAME_ASSET", "Wybierz inne urządzenie.");
    if (target.version !== input.expectedReplacementVersion)
      fail(
        "VERSION_CONFLICT",
        "Nowe urządzenie zmieniło wersję. Przygotuj nowy plan.",
      );
    if (target.data.assetType !== source.data.assetType)
      fail(
        "REPLACEMENT_TYPE_MISMATCH",
        "Zamiana rezerwacji wymaga tego samego rodzaju sprzętu.",
      );
    if (
      !this.registerStore.verify(tenant, target) ||
      !this.custodyStore.verify(tenant, target.id) ||
      !this.custodyStore.verify(tenant, source.id)
    )
      fail(
        "ASSET_HISTORY_INCONSISTENT",
        "Historia jednego z urządzeń jest niespójna.",
      );
    const released = this.custodyStore.transition(
      cmd.ctx,
      source,
      "release",
      input as JsonObject,
      cmd.now,
      allocation.timezone!,
    );
    source.data.allocations = this.allocations(tenant, source.id);
    this.save(cmd, source);
    const reserved = this.custodyStore.reserve(
      cmd.ctx,
      target,
      {
        personId: allocation.personId,
        employmentEpisodeId: allocation.employmentEpisodeId!,
        caseId: allocation.caseId!,
        until: allocation.reservedUntil,
        purpose: String(input.reason),
      },
      cmd.now,
      allocation.timezone!,
      allocation.profileVersion,
      allocation.expiresAt!,
    );
    target.data.allocations = this.allocations(tenant, target.id);
    cmd.custodyEvent = reserved;
    cmd.replacement = {
      sourceAssetId: source.id,
      replacementAssetId: target.id,
      releasedAllocationId: released.allocationId,
      reservedAllocationId: reserved.allocationId,
      releaseEventId: released.id,
      reserveEventId: reserved.id,
      reservedUntil: allocation.reservedUntil,
      expiresAt: allocation.expiresAt!,
    };
    return this.save(cmd, target);
  }
  private resourceEpisode(
    cmd: Command,
    input: CommandInput,
    states: string[],
  ): Row {
    const person = this.ref(cmd, "people", input.personId);
    const episode = this.employmentEpisode(cmd, person.id, input, states);
    if (input.caseId) {
      const record = this.ref(cmd, "cases", input.caseId);
      if (
        record.data.personId !== person.id ||
        record.data.employmentEpisodeId !== episode.id ||
        record.status === "cancelled"
      )
        fail(
          "RESOURCE_CASE_MISMATCH",
          "Sprawa nie dotyczy wskazanej osoby i okresu współpracy.",
        );
    }
    return episode;
  }
  private unresolvedResources(tenantId: string, personId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT id FROM ops_allocations WHERE tenant_id=? AND person_id=? AND employment_episode_id IS NULL AND status IN('reserved','issued') LIMIT 1",
        )
        .get(tenantId, personId) ||
      this.db
        .prepare(
          "SELECT id FROM ops_license_seats WHERE tenant_id=? AND person_id=? AND employment_episode_id IS NULL AND status='assigned' LIMIT 1",
        )
        .get(tenantId, personId),
    );
  }
  private syncPerson(cmd: { ctx: { tenantId: string } }, person: Entity) {
    const episodes = this.employmentRows(cmd.ctx.tenantId, person.id);
    const open = episodes.filter((row) => row.status !== "ended");
    person.status = open.some((row) => row.status === "active")
      ? "active"
      : open.some((row) => row.status === "onboarding")
        ? "onboarding"
        : open.length
          ? "offboarding"
          : episodes.length
            ? "exited"
            : "registered";
    person.data.employmentEpisodes = episodes.map((row) =>
      asJson(this.projectEpisode(row)),
    );
    person.data.currentEmploymentEpisodeId =
      open.length === 1 ? String(open[0]!.id) : null;
    person.data.onboardingCaseId =
      open.length === 1 ? (open[0]!.onboarding_case_id as string | null) : null;
    person.data.offboardingCaseId =
      open.length === 1
        ? (open[0]!.offboarding_case_id as string | null)
        : null;
  }
  private engagement(
    cmd: Command,
    value: unknown,
  ): { reference: EngagementRef; key: string } | null {
    if (!value) return null;
    const reference = value as EngagementRef;
    const record = this.ref(cmd, reference.module, reference.id);
    let key = `${reference.module}:${record.id}`;
    if (reference.module === "sales") {
      if (
        (record.data.kind === "deal" && record.status !== "won") ||
        (record.data.kind === "offer" &&
          !["accepted", "handed_over"].includes(record.status)) ||
        !["deal", "offer"].includes(String(record.data.kind))
      )
        fail(
          "ENGAGEMENT_NOT_AGREED",
          "Wybierz wygraną szansę albo zaakceptowaną ofertę.",
        );
      if (record.data.kind === "offer") {
        const deal = this.ref(cmd, "sales", record.data.parentId);
        this.kind(deal, "deal");
        key = `sales:${deal.id}`;
      }
    } else {
      if (
        record.data.caseType !== "delivery" ||
        !["open", "awaiting_acceptance", "accepted"].includes(record.status)
      )
        fail(
          "ENGAGEMENT_NOT_AGREED",
          "Wybierz uzgodnioną, aktywną sprawę realizacji.",
        );
      if (record.data.sourceOfferId) {
        const offer = this.ref(cmd, "sales", record.data.sourceOfferId);
        this.kind(offer, "offer");
        const deal = this.ref(cmd, "sales", offer.data.parentId);
        this.kind(deal, "deal");
        key = `sales:${deal.id}`;
      }
    }
    return { reference, key };
  }
  private assertEmploymentStart(
    cmd: Command,
    personId: string,
    kind: string,
    startDate: string,
    engagementKey: string | null,
    excludeId?: string,
  ) {
    const policy = cmd.profile?.employmentPolicy ?? defaultEmploymentPolicy;
    const existing = this.employmentRows(cmd.ctx.tenantId, personId).filter(
      (row) => row.id !== excludeId,
    );
    const open = existing.filter((row) => row.status !== "ended");
    const overlap = existing.filter(
      (row) => !row.end_date || String(row.end_date) >= startDate,
    );
    if (policy.mode === "single_open") {
      if (open.length)
        fail(
          "EMPLOYMENT_LIMIT",
          "Profil firmy pozwala na jeden otwarty okres współpracy.",
        );
      if (overlap.length)
        fail(
          "OVERLAPPING_EMPLOYMENT",
          "Nowy okres musi rozpocząć się po zakończeniu poprzedniego.",
        );
    } else {
      if (!engagementKey && kind === "contractor")
        fail(
          "ENGAGEMENT_REQUIRED",
          "Równoległe współprace wymagają wskazania uzgodnionego projektu lub umowy.",
        );
      if (open.length >= policy.maxConcurrent)
        fail(
          "EMPLOYMENT_LIMIT",
          "Osiągnięto zatwierdzony limit otwartych współprac.",
        );
      if (
        open.length &&
        (this.unresolvedResources(cmd.ctx.tenantId, personId) ||
          open.some((row) => !row.engagement_key))
      )
        fail(
          "LEGACY_EMPLOYMENT_UNRESOLVED",
          "Najpierw rozstrzygnij historyczne powiązania projektów i aktywnych zasobów tej osoby.",
        );
      if (overlap.some((row) => kind === "internal" || row.kind === "internal"))
        fail(
          "INTERNAL_EMPLOYMENT_OVERLAP",
          "Współpraca wewnętrzna nie może nakładać się na inny okres.",
        );
      if (overlap.some((row) => row.engagement_key === engagementKey))
        fail(
          "DUPLICATE_ENGAGEMENT",
          "Ta współpraca ma już okres obejmujący wskazany termin.",
        );
    }
  }
  private startEmployment(
    cmd: Command,
    person: Entity,
    input: CommandInput,
  ): string {
    const engagement = this.engagement(cmd, input.engagementRef);
    this.assertEmploymentStart(
      cmd,
      person.id,
      String(input.employmentKind),
      String(input.startDate),
      engagement?.key ?? null,
    );
    const episodeId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO ops_employment(tenant_id,id,person_id,kind,start_date,end_date,status,role,version,engagement_module,engagement_id,engagement_key,updated_at) VALUES(?,?,?,?,?,NULL,'onboarding',?,1,?,?,?,?)",
      )
      .run(
        cmd.ctx.tenantId,
        episodeId,
        person.id,
        String(input.employmentKind),
        String(input.startDate),
        String(input.role),
        engagement?.reference.module ?? null,
        engagement?.reference.id ?? null,
        engagement?.key ?? null,
        cmd.now,
      );
    const caseId = this.lifecycleCase(
      cmd,
      person,
      episodeId,
      "onboarding",
      String(input.startDate),
    );
    this.db
      .prepare(
        "UPDATE ops_employment SET onboarding_case_id=? WHERE tenant_id=? AND id=?",
      )
      .run(caseId, cmd.ctx.tenantId, episodeId);
    this.syncPerson(cmd, person);
    return episodeId;
  }
  private lifecycleCase(
    cmd: Command,
    person: Entity,
    episodeId: string,
    type: "onboarding" | "offboarding",
    dueDate: string,
  ): string {
    const episode = this.db
      .prepare(
        "SELECT kind FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
      )
      .get(cmd.ctx.tenantId, episodeId, person.id) as Row | undefined;
    if (!episode)
      fail("EMPLOYMENT_REQUIRED", "Brak właściwego okresu współpracy.");
    const c = this.create(
      cmd,
      "cases",
      `${type === "onboarding" ? "Onboarding" : "Offboarding"}: ${person.title}`,
      {
        caseType: type,
        brief: `${type === "onboarding" ? "Rozpoczęcie" : "Zakończenie"} współpracy ${episode.kind === "internal" ? "wewnętrznej" : "kontraktorskiej"}: ${person.title}.`,
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
        episode.kind === "contractor" ? "contractor" : "internal",
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
          templateKey: task.key,
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
    e.data.accessGrantRefs = this.accessRefs(cmd.ctx.tenantId, e.id);
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
  private accessRefs(tenant: string, caseId: string): JsonObject[] {
    return this.accessStore
      .list(tenant, caseId)
      .map((g) => ({ id: g.id, version: g.version, eventId: g.lastEventId }));
  }
  private accessAuthority(ctx: ToolContext, action: string, input: JsonObject) {
    const actor = this.livePrincipal(ctx.tenantId, ctx.actorId);
    if (!actor || !this.canManageCase(actor, String(input.id)))
      fail(
        "ACCESS_ACTOR_FORBIDDEN",
        "Poświadczenie wymaga aktywnego operatora z dostępem do tej sprawy.",
        403,
      );
    for (const area of [
      "it",
      ...this.inputScopes("cases", action, input, ctx.tenantId),
    ])
      this.scope(actor, area);
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
        const episode = this.employmentEpisode(
          cmd,
          e.id,
          input,
          action === "activate"
            ? ["onboarding"]
            : action === "beginOffboarding"
              ? ["onboarding", "active"]
              : ["offboarding"],
        );
        if (action === "activate") {
          const onboarding = this.ref(cmd, "cases", episode.onboarding_case_id);
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
              "UPDATE ops_employment SET status='active',version=version+1,updated_at=? WHERE tenant_id=? AND id=? AND version=?",
            )
            .run(
              cmd.now,
              cmd.ctx.tenantId,
              String(episode.id),
              Number(episode.version),
            );
        }
        if (action === "beginOffboarding" || action === "endEmployment") {
          if (String(input.endDate) < String(episode.start_date))
            fail(
              "INVALID_EMPLOYMENT_DATES",
              "Koniec nie może poprzedzać początku współpracy.",
            );
          if (action === "endEmployment") {
            if (input.endDate !== episode.end_date)
              fail(
                "EXIT_DATE_CHANGED",
                "Data zakończenia musi odpowiadać odebranemu zakresowi offboardingu.",
              );
            if (String(input.endDate) > this.companyDate(cmd))
              fail(
                "END_DATE_NOT_REACHED",
                "Nie można potwierdzić zakończenia współpracy w przyszłości.",
              );
            const offboarding = this.ref(
              cmd,
              "cases",
              episode.offboarding_case_id,
            );
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
              !readiness.acceptanceCurrent
            )
              fail(
                "EXIT_READINESS_STALE",
                "Odbiór nie potwierdza aktualnego rozliczenia tej osoby i współpracy. Wymagana nowa ocena lub rewizja.",
              );
            if (this.unresolvedResources(cmd.ctx.tenantId, e.id))
              fail(
                "LEGACY_RESOURCES_UNRESOLVED",
                "Aktywne historyczne zasoby tej osoby nie mają rozstrzygniętego okresu. Najpierw rozlicz ich powiązanie lub zwrot.",
              );
            if (
              this.db
                .prepare(
                  "SELECT id FROM ops_allocations WHERE tenant_id=? AND person_id=? AND employment_episode_id=? AND status IN('reserved','issued') LIMIT 1",
                )
                .get(cmd.ctx.tenantId, e.id, String(episode.id))
            )
              fail(
                "ASSETS_NOT_RETURNED",
                "Najpierw rozlicz sprzęt i rezerwacje wskazanego okresu.",
              );
            if (
              this.db
                .prepare(
                  "SELECT id FROM ops_license_seats WHERE tenant_id=? AND person_id=? AND employment_episode_id=? AND status='assigned' LIMIT 1",
                )
                .get(cmd.ctx.tenantId, e.id, String(episode.id))
            )
              fail(
                "LICENSES_NOT_REVOKED",
                "Najpierw zamknij przydziały licencji wskazanego okresu.",
              );
          }
          if (
            action === "beginOffboarding" &&
            episode.status === "onboarding"
          ) {
            if (!episode.onboarding_case_id)
              fail(
                "LEGACY_LIFECYCLE_UNRESOLVED",
                "Brak jednoznacznej sprawy historycznego onboardingu dla tego okresu.",
              );
            const onboarding = this.ref(
              cmd,
              "cases",
              episode.onboarding_case_id,
            );
            if (
              onboarding.data.personId !== e.id ||
              onboarding.data.employmentEpisodeId !== episode.id
            )
              fail(
                "LIFECYCLE_BINDING_REQUIRED",
                "Sprawa onboardingu nie dotyczy tego okresu.",
              );
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
          this.db
            .prepare(
              "UPDATE ops_employment SET status=?,end_date=?,end_reason=?,version=version+1,updated_at=? WHERE tenant_id=? AND id=? AND version=?",
            )
            .run(
              action === "beginOffboarding" ? "offboarding" : "ended",
              String(input.endDate),
              String(input.reason),
              cmd.now,
              cmd.ctx.tenantId,
              String(episode.id),
              Number(episode.version),
            );
          if (action === "beginOffboarding") {
            const caseId = this.lifecycleCase(
              cmd,
              e,
              String(episode.id),
              "offboarding",
              String(input.endDate),
            );
            this.db
              .prepare(
                "UPDATE ops_employment SET offboarding_case_id=? WHERE tenant_id=? AND id=?",
              )
              .run(caseId, cmd.ctx.tenantId, String(episode.id));
          }
        }
        this.syncPerson(cmd, e);
      }
    }
    if (e.module === "cases") {
      if (["attestAccess", "renewAccess", "revokeAccess"].includes(action)) {
        this.accessAuthority(cmd.ctx, action, input as unknown as JsonObject);
        this.human(cmd, input);
        cmd.accessEvent =
          action === "revokeAccess"
            ? this.accessStore.revoke(
                cmd.ctx,
                input as unknown as JsonObject,
                cmd.now,
                cmd.profile?.timezone ?? "UTC",
              )
            : this.accessStore.attest(
                cmd.ctx,
                input as unknown as JsonObject,
                cmd.now,
                cmd.profile?.timezone ?? "UTC",
                cmd.profile?.version ?? 0,
                action === "renewAccess",
              );
        this.caseState(cmd, e);
      } else if (action === "revise") {
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
          const episode = this.db
            .prepare(
              "SELECT status FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
            )
            .get(
              cmd.ctx.tenantId,
              String(d.employmentEpisodeId),
              String(d.personId),
            );
          if (episode?.status !== d.caseType)
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
          const revisedEpisode = this.employmentEpisode(
            cmd,
            person.id,
            {
              employmentEpisodeId: d.employmentEpisodeId,
              expectedEpisodeVersion: input.expectedEpisodeVersion,
            },
            ["onboarding"],
          );
          this.assertEmploymentStart(
            cmd,
            person.id,
            String(revisedEpisode.kind),
            String(input.startDate),
            revisedEpisode.engagement_key
              ? String(revisedEpisode.engagement_key)
              : null,
            String(revisedEpisode.id),
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
              "UPDATE ops_employment SET start_date=?,version=version+1 WHERE tenant_id=? AND id=? AND person_id=? AND status='onboarding'",
            )
            .run(
              String(input.startDate),
              cmd.ctx.tenantId,
              String(d.employmentEpisodeId),
              person.id,
            );
          d.employmentStartDate = String(input.startDate);
          d.dueDate = String(input.startDate);
          this.syncPerson(cmd, person);
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
            templateKey: task.templateKey ?? undefined,
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
      const actor = this.livePrincipal(cmd.ctx.tenantId, cmd.ctx.actorId);
      if (!actor?.roles.includes("operator"))
        fail(
          "ASSET_ACTOR_FORBIDDEN",
          "Brak aktywnego konta operatora sprzętu.",
          403,
        );
      if (action === "replaceReservation")
        return this.replaceReservation(cmd, e, input);
      if (action === "assignCustodian") {
        this.human(cmd, input);
        const custodian = this.livePrincipal(
          cmd.ctx.tenantId,
          String(input.custodianPrincipalId),
        );
        if (
          !custodian?.roles.includes("operator") ||
          !(
            custodian.scopes?.includes("*") ||
            custodian.scopes?.includes("assets")
          )
        )
          fail(
            "CUSTODIAN_FORBIDDEN",
            "Opiekun musi być aktywnym operatorem ewidencji sprzętu.",
            403,
          );
        d.custodianPrincipalId = custodian.id;
        d.custodianAssignment = {
          assignedBy: cmd.ctx.actorId!,
          approvedBy: cmd.ctx.approvedBy ?? null,
          note: String(input.note),
          recordedAt: cmd.now,
        };
      } else if (action === "reserve") {
        this.resourceEpisode(cmd, input, ["onboarding", "active"]);
        cmd.custodyEvent = this.custodyStore.reserve(
          cmd.ctx,
          e,
          input as JsonObject,
          cmd.now,
          cmd.profile?.timezone ?? "UTC",
          cmd.profile?.version ?? null,
        );
      } else if (
        ["move", "sendToService", "markRepaired", "retire"].includes(action)
      ) {
        this.state(
          e,
          ...(action === "markRepaired"
            ? ["maintenance"]
            : ["available", "maintenance"]),
        );
        this.human(cmd, input);
        if (
          this.custodyStore
            .rows(cmd.ctx.tenantId, e.id)
            .some((a) => ["reserved", "issued"].includes(a.status))
        )
          fail(
            "ACTIVE_ALLOCATION",
            "Najpierw poświadcz zwrot albo jawnie zwolnij rezerwację.",
          );
        const occurredOn = input.occurredOn;
        const priorPhysicalDays = [
          companyDay(e.createdAt, cmd.profile?.timezone ?? "UTC"),
          d.lastRegisterAction &&
          typeof d.lastRegisterAction === "object" &&
          !Array.isArray(d.lastRegisterAction)
            ? d.lastRegisterAction.occurredOn
            : null,
          ...this.custodyStore
            .rows(cmd.ctx.tenantId, e.id)
            .flatMap((a) => [a.issuedOn, a.returnedOn]),
        ].filter((day): day is string => typeof day === "string");
        if (
          occurredOn !== undefined &&
          (String(occurredOn) > this.companyDate(cmd) ||
            priorPhysicalDays.some((day) => String(occurredOn) < day))
        )
          fail(
            "INVALID_ASSET_ACTION_DATE",
            "Data czynności nie może poprzedzać rejestracji ani ostatniej czynności fizycznej lub wykraczać poza bieżący dzień firmy.",
          );
        if (action === "move" && input.location === d.location)
          fail("LOCATION_UNCHANGED", "Wskaż inne miejsce docelowe.");
        if (action === "move" || action === "sendToService")
          d.location = String(input.location);
        if (action === "sendToService") {
          e.status = "maintenance";
          d.condition = "repair";
        }
        if (action === "markRepaired") {
          e.status = "available";
          d.condition = "good";
          d.repairNote = String(input.note);
        }
        if (action === "retire") e.status = "retired";
        d.lastRegisterAction = {
          action,
          occurredOn: occurredOn === undefined ? null : String(occurredOn),
          note: String(input.note),
          performedBy: cmd.ctx.actorId!,
          approvedBy: cmd.ctx.approvedBy ?? null,
          recordedAt: cmd.now,
        };
      } else {
        if (action === "issue")
          this.resourceEpisode(cmd, input, ["onboarding", "active"]);
        cmd.custodyEvent = this.custodyStore.transition(
          cmd.ctx,
          e,
          action === "expireReservation"
            ? "expire"
            : (action as "issue" | "return" | "release"),
          input as JsonObject,
          cmd.now,
          cmd.profile?.timezone ?? "UTC",
        );
      }
      d.allocations = this.allocations(cmd.ctx.tenantId, e.id);
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
        const episode = this.resourceEpisode(cmd, input, [
          "onboarding",
          "active",
        ]);
        if (d.expiresOn && String(d.expiresOn) < this.companyDate(cmd))
          fail("LICENSE_EXPIRED", "Licencja wygasła.");
        if (count() >= Number(d.totalSeats))
          fail("NO_FREE_SEATS", "Wszystkie stanowiska są zajęte.");
        if (
          this.db
            .prepare(
              "SELECT id FROM ops_license_seats WHERE tenant_id=? AND license_id=? AND person_id=? AND (employment_episode_id=? OR employment_episode_id IS NULL) AND status='assigned'",
            )
            .get(
              cmd.ctx.tenantId,
              e.id,
              String(input.personId),
              String(episode.id),
            )
        )
          fail("SEAT_ALREADY_ASSIGNED", "Osoba ma już przydział tej licencji.");
        this.db
          .prepare(
            "INSERT INTO ops_license_seats(tenant_id,id,license_id,person_id,status,assigned_at,revoked_at,employment_episode_id,case_id) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            cmd.ctx.tenantId,
            randomUUID(),
            e.id,
            String(input.personId),
            "assigned",
            cmd.now,
            null,
            String(episode.id),
            typeof input.caseId === "string" ? input.caseId : null,
          );
        d.lastAssignmentNote = String(input.note);
      }
      if (action === "revoke") {
        const episode = this.resourceEpisode(cmd, input, [
          "onboarding",
          "active",
          "offboarding",
        ]);
        const result = this.db
          .prepare(
            "UPDATE ops_license_seats SET status='revoked',revoked_at=? WHERE tenant_id=? AND license_id=? AND person_id=? AND employment_episode_id=? AND status='assigned'",
          )
          .run(
            cmd.now,
            cmd.ctx.tenantId,
            e.id,
            String(input.personId),
            String(episode.id),
          );
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
      d.assignments = this.licenseAssignments(cmd.ctx.tenantId, e.id);
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
      if (["application", "access_bundle"].includes(String(d.kind))) {
        this.state(e, "active");
        if (action === "reviseAccessBundle") {
          this.kind(e, "access_bundle");
          const next = accessBundleDataSchema.parse({
            ...d,
            members: input.members,
            description: input.description,
          });
          this.accessStore.validateMembers(cmd.ctx.tenantId, next.members);
          e.data = asJson(next);
        } else if (action === "reviseApplication") {
          this.kind(e, "application");
          e.data = asJson(
            applicationDataSchema.parse({
              ...d,
              supportedRoles: input.supportedRoles,
              description: input.description,
            }),
          );
        } else if (action === "retireAccessDefinition") {
          e.status = "retired";
          d.retirementReason = String(input.reason);
        } else
          fail(
            "WRONG_RECORD_KIND",
            "Wybierz operację katalogu aplikacji lub zestawu dostępów.",
          );
        return this.save(cmd, e);
      }
      if (
        [
          "reviseAccessBundle",
          "reviseApplication",
          "retireAccessDefinition",
        ].includes(action)
      )
        fail(
          "WRONG_RECORD_KIND",
          "Operacja wymaga aplikacji lub zestawu dostępów.",
        );
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
        const taskCustody =
          module === "assets" &&
          ["issueForTask", "returnForTask", "bindAssetForTask"].includes(
            action,
          );
        const custodyMutation =
          module === "assets" &&
          [
            "reserve",
            "replaceReservation",
            "issue",
            "return",
            "release",
            "expireReservation",
            "issueForTask",
            "returnForTask",
          ].includes(action);
        const registerMutation =
          module === "assets" &&
          ["move", "sendToService", "markRepaired", "retire"].includes(action);
        const accessMutation =
          module === "cases" &&
          ["attestAccess", "renewAccess", "revokeAccess"].includes(action);
        const accessBinding = module === "cases" && action === "bindEvidence";
        const usesProfile =
          lifecycle ||
          accessMutation ||
          (module === "cases" && ["addTask", "revise"].includes(action)) ||
          (module === "assets" &&
            [
              "reserve",
              "replaceReservation",
              "issue",
              "move",
              "sendToService",
              "markRepaired",
              "retire",
            ].includes(action)) ||
          (module === "licenses" && ["assign", "revoke"].includes(action));
        const taskConsistent = (
          ctx: ToolContext,
          input: JsonObject,
        ): boolean => {
          if (!taskTransition && !taskCustody) return true;
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
              (["issueForTask", "returnForTask"].includes(event.action)
                ? current.status === "accepted" &&
                  current.performedBy === null &&
                  event.performedBy === event.requestedBy
                : event.performedBy === current.performedBy)
            );
          } catch {
            return false;
          }
        };
        const requireCommittedTask = (ctx: ToolContext, input: JsonObject) => {
          if (
            (taskTransition &&
              !this.taskStore.verifyCommitted(ctx, String(input.taskId))) ||
            (taskCustody &&
              !this.taskStore.verifyCommittedAsset(
                ctx,
                input,
                action as AssetTaskAction,
              ))
          )
            fail(
              "TASK_RECEIPT_FORBIDDEN",
              "Brak aktualnych uprawnień do potwierdzonej operacji zadania.",
              403,
            );
        };
        const custodyConsistent = (ctx: ToolContext, input: JsonObject) =>
          action === "replaceReservation"
            ? this.custodyStore.verifyReplacement(
                ctx,
                String(input.id),
                String(input.replacementAssetId),
              )
            : this.custodyStore.verifyCommitted(ctx, String(input.id));
        const requireCommittedCustody = (
          ctx: ToolContext,
          input: JsonObject,
        ) => {
          if (custodyMutation && !custodyConsistent(ctx, input))
            fail(
              "CUSTODY_STATE_INCONSISTENT",
              "Brak spójnego zdarzenia przekazania sprzętu.",
            );
        };
        const accessConsistent = (ctx: ToolContext) =>
          !accessMutation || this.accessStore.verifyCommitted(ctx);
        const requireCommittedAccess = (
          ctx: ToolContext,
          input: JsonObject,
        ) => {
          if (!accessMutation) return;
          this.accessAuthority(ctx, action, input);
          if (!accessConsistent(ctx))
            fail(
              "ACCESS_HISTORY_INCONSISTENT",
              "Brak spójnego zdarzenia poświadczenia dostępu.",
            );
        };
        const requiredScopes = taskCustody
          ? ["it"]
          : module === "people" && action !== "create" && action !== "update"
            ? ["cases"]
            : module === "recruitment" && action === "hire"
              ? ["people", "cases"]
              : module === "sales" && action === "handoff"
                ? ["cases"]
                : (module === "assets" &&
                      ["reserve", "issue", "replaceReservation"].includes(
                        action,
                      )) ||
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
          version:
            accessMutation ||
            (module === "it" &&
              [
                "reviseAccessBundle",
                "reviseApplication",
                "retireAccessDefinition",
              ].includes(action))
              ? "8"
              : module === "assets"
                ? action === "replaceReservation"
                  ? "7"
                  : "6"
                : module === "cases" && action === "bindEvidence"
                  ? "6"
                  : "4",
          ...(taskCustody
            ? {
                canAccess: (
                  principal: Principal,
                  input: JsonObject,
                  context?: import("./contracts.js").ToolAccessContext,
                ) =>
                  this.taskStore.canAccessAsset(
                    principal,
                    input,
                    context,
                    action as AssetTaskAction,
                  ),
              }
            : taskTransition
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
            if (taskCustody)
              return [
                "it",
                ...this.taskStore.get(tenantId, String(input.taskId))
                  .requiredScopes,
              ];
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
          ...(usesProfile || taskCustody || accessBinding
            ? {
                prepareInput: (input: JsonObject, tenantId: string) => {
                  if (taskCustody)
                    return this.taskStore.prepareAssetInput(
                      tenantId,
                      input,
                      action as AssetTaskAction,
                    );
                  const profile = this.currentProfile(tenantId);
                  const prepared: JsonObject =
                    usesProfile && profile && input.profileVersion === undefined
                      ? { ...input, profileVersion: profile.version }
                      : { ...input };
                  if (accessMutation) {
                    const pins =
                      action === "revokeAccess"
                        ? this.accessStore.revokePins(tenantId, input)
                        : this.accessStore.pins(tenantId, input);
                    for (const [key, value] of Object.entries(pins))
                      if (prepared[key] === undefined) prepared[key] = value;
                  }
                  if (
                    accessBinding &&
                    input.sourceModule === "it" &&
                    input.accessProofHash === undefined
                  )
                    prepared.accessProofHash = this.accessStore.assessment(
                      tenantId,
                      String(input.id),
                      String(input.requirementId),
                      new Date(
                        this.options.clock?.() ?? Date.now(),
                      ).toISOString(),
                    ).hash;
                  if (module === "assets" && action === "replaceReservation") {
                    const pins = this.replacementPins(tenantId, input);
                    for (const [key, value] of Object.entries(pins))
                      if (prepared[key] === undefined) prepared[key] = value;
                  }
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
            this.db.exec("BEGIN IMMEDIATE");
            try {
              const existing = this.ledger(ctx, toolId, input);
              // A committed asset receipt is reconciled from its pinned event;
              // elapsed expiry or a later profile cannot turn it into another effect.
              const profile =
                usesProfile &&
                !(
                  existing &&
                  (custodyMutation || registerMutation || accessMutation)
                )
                  ? this.pinnedProfile(ctx.tenantId, input)
                  : this.currentProfile(ctx.tenantId);
              if (existing) {
                requireCommittedTask(ctx, input);
                requireCommittedCustody(ctx, input);
                requireCommittedAccess(ctx, input);
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
                if (
                  module === "assets" &&
                  !this.registerStore.verify(ctx.tenantId, e)
                )
                  fail(
                    "ASSET_HISTORY_INCONSISTENT",
                    "Historia ewidencji urządzenia jest niespójna.",
                  );
                if (action === "update") {
                  if (
                    module === "it" &&
                    ["application", "access_bundle"].includes(
                      String(e.data.kind),
                    ) &&
                    p.data &&
                    Object.keys(p.data).length
                  )
                    fail(
                      "REVISION_REQUIRED",
                      "Zmień definicję aplikacji lub zestawu przez właściwą rewizję.",
                    );
                  if (
                    [
                      "accepted",
                      "handed_over",
                      "hired",
                      "archived",
                      "cancelled",
                      "received",
                      "exited",
                      "retired",
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
                      (module !== "assets" &&
                        ![
                          "draft",
                          "registered",
                          "available",
                          "open",
                          "new",
                          "active",
                        ].includes(e.status)))
                  )
                    fail(
                      "REVISION_REQUIRED",
                      "Zmień zakres przez właściwą rewizję lub operację domenową.",
                    );
                  if (p.title !== undefined) e.title = p.title;
                  if (p.data) e.data = { ...e.data, ...p.data };
                  if (e.module === "people") this.syncPerson(cmd, e);
                  if (e.module === "assets")
                    e.data.allocations = this.allocations(ctx.tenantId, e.id);
                  if (e.module === "licenses")
                    e.data.assignments = this.licenseAssignments(
                      ctx.tenantId,
                      e.id,
                    );
                  e = this.save(cmd, e);
                } else if (taskCustody) {
                  this.taskStore.authorizeAsset(
                    ctx,
                    input,
                    action as AssetTaskAction,
                  );
                  const c = this.read(
                    ctx.tenantId,
                    "cases",
                    String(input.caseId),
                  );
                  if (action === "bindAssetForTask") {
                    this.readinessStore.bind(
                      ctx,
                      c,
                      {
                        requirementId: String(input.requirementId),
                        sourceModule: "assets",
                        sourceId: e.id,
                        sourceVersion: e.version,
                        allocationId: String(input.allocationId),
                        issueEventId: String(input.issueEventId),
                      },
                      cmd.now,
                    );
                  } else
                    e = this.change(
                      cmd,
                      e,
                      action === "issueForTask" ? "issue" : "return",
                      p,
                    );
                  this.taskStore.recordAssetEvent(
                    ctx,
                    input,
                    action as AssetTaskAction,
                    {
                      allocationId: String(input.allocationId),
                      eventId:
                        cmd.custodyEvent?.id ?? String(input.issueEventId),
                    },
                    cmd.now,
                  );
                  this.caseState(cmd, c);
                  this.save(cmd, c);
                } else e = this.change(cmd, e, action, p);
              }
              const task =
                taskTransition || taskCustody
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
                      ...(taskCustody
                        ? {
                            allocationId: String(input.allocationId),
                            allocationVersion: this.custodyStore.get(
                              ctx.tenantId,
                              e.id,
                              String(input.allocationId),
                            ).version,
                            eventId:
                              cmd.custodyEvent?.id ??
                              String(input.issueEventId),
                          }
                        : {}),
                    }
                  : {
                      entityId: e.id,
                      module: e.module,
                      version: e.version,
                      status: e.status,
                      title: e.title,
                      ...(cmd.replacement
                        ? { replacement: cmd.replacement }
                        : {}),
                      ...(cmd.custodyEvent
                        ? {
                            allocationId: cmd.custodyEvent.allocationId,
                            allocationVersion:
                              cmd.custodyEvent.allocationVersion,
                            eventId: cmd.custodyEvent.id,
                          }
                        : {}),
                      ...(cmd.accessEvent
                        ? {
                            grantId: cmd.accessEvent.grantId,
                            grantVersion: cmd.accessEvent.grantVersion,
                            eventId: cmd.accessEvent.id,
                          }
                        : {}),
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
              requireCommittedCustody(ctx, asJson(parsed.data));
              requireCommittedAccess(ctx, asJson(parsed.data));
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
            if (row) {
              requireCommittedTask(ctx, asJson(parsed.data));
              if (accessMutation)
                this.accessAuthority(ctx, action, asJson(parsed.data));
            }
            let ok = Boolean(
              row &&
              canonical(result) === row.receipt_json &&
              accessConsistent(ctx) &&
              (!custodyMutation ||
                custodyConsistent(ctx, asJson(parsed.data))) &&
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
                    currentSnapshot.snapshot_hash &&
                  this.relationalStateMatches(
                    ctx.tenantId,
                    this.fromRow(entity),
                  ) &&
                  (change.module !== "assets" ||
                    !JSON.parse(String(version.snapshot_json)).data
                      .registerHistoryFromVersion ||
                    this.registerStore.verifyCommitted(ctx, change.id)),
                );
                ok = ok && valid;
                if (!taskCustody || change.module === "assets")
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
