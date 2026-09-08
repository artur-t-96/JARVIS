import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./contracts.js";
import { migrateDatabase } from "./migrations.js";
import { type Entity, WorkspaceStore } from "./workspace.js";
import {
  processTemplateTaskSchema,
  processTemplatesSchema,
  roleBindingsSchema,
  baselineProcessTemplates,
  employmentPolicySchema,
  defaultEmploymentPolicy,
} from "./workspace-models.js";

export { baselineProcessTemplates } from "./workspace-models.js";

const rules = [
  "overdue_case",
  "overdue_task",
  "expired_reservation",
  "license_expiry",
  "high_severity_incident",
] as const;
type Rule = (typeof rules)[number];
const modules = ["cases", "assets", "licenses", "it"] as const;
const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const settingsSchema = z
  .object({
    companyName: z.string().trim().min(1).max(160),
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
      }, "Niepoprawna strefa czasowa"),
    licenseReminderDays: z.number().int().min(0).max(365),
    quietHours: z
      .object({ enabled: z.boolean(), start: clockTime, end: clockTime })
      .strict(),
    rules: z
      .object({
        overdue_case: z.boolean(),
        overdue_task: z.boolean(),
        expired_reservation: z.boolean(),
        license_expiry: z.boolean(),
        high_severity_incident: z.boolean(),
      })
      .strict(),
    employmentPolicy: employmentPolicySchema,
    roleBindings: roleBindingsSchema,
    processTemplates: processTemplatesSchema,
  })
  .strict();
export type CompanySettings = z.infer<typeof settingsSchema>;
export type ProcessTemplateTask = z.infer<typeof processTemplateTaskSchema>;
export interface CompanyProfile extends CompanySettings {
  tenantId: string;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  updatedApprovedBy: string | null;
  definitionVersion: string;
  needsConfiguration?: boolean;
}
export interface Initiative {
  id: string;
  module: string;
  sourceId: string;
  sourceItemId: string | null;
  rule: Rule;
  title: string;
  summary: string;
  severity: "medium" | "high" | "critical";
  status: "open" | "snoozed" | "dismissed" | "resolved";
  version: number;
  dueDate: string | null;
  ownerId: string | null;
  ownerPrincipalId?: string | null;
  sourceVersion: number;
  sourceUpdatedAt: string;
  fingerprint: string;
  sourceFingerprint: string;
  definitionVersion: string;
  profileVersion: number;
  snoozedUntil: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
  reason: string | null;
  updatedBy: string | null;
}
type Row = Record<string, unknown>;
type Candidate = Pick<
  Initiative,
  | "module"
  | "sourceId"
  | "sourceItemId"
  | "rule"
  | "title"
  | "summary"
  | "severity"
  | "dueDate"
  | "ownerId"
  | "ownerPrincipalId"
  | "sourceVersion"
  | "sourceUpdatedAt"
  | "sourceFingerprint"
>;
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const json = (value: unknown): JsonObject =>
  JSON.parse(JSON.stringify(value)) as JsonObject;
const fail = (code: string, message: string, status = 409): never => {
  throw new DomainError(code, message, status);
};
const listData = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? (value.filter(
        (entry) => entry && typeof entry === "object",
      ) as JsonObject[])
    : [];
const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;
const validDate = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value));
const dayDistance = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );

function stableInitiative(item: Initiative) {
  const {
    lastObservedAt: _lastObservedAt,
    sourceUpdatedAt: _sourceUpdatedAt,
    sourceVersion: _sourceVersion,
    profileVersion: _profileVersion,
    ...stable
  } = item;
  return stable;
}

export class InitiativeStore {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly sourceTools: Map<string, ToolDefinition>;
  constructor(
    dbPath: string,
    private readonly workspace: WorkspaceStore,
    options: { clock?: () => number } = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.sourceTools = new Map(
      workspace
        .tools()
        .filter((tool) =>
          /^ops\.(cases|assets|licenses|it)\.update$/.test(tool.id),
        )
        .map((tool) => [tool.id, tool]),
    );
    if (dbPath !== ":memory:")
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    migrateDatabase(this.db, {
      namespace: "initiatives",
      migrations: [
        {
          version: 1,
          name: "Durable local proposals and versioned company settings",
          up: (database) =>
            database.exec(`
      CREATE TABLE initiative_profiles (tenant_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE initiative_items (tenant_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL, module TEXT NOT NULL, source_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,fingerprint));
      CREATE INDEX initiative_sources ON initiative_items(tenant_id,module,source_id);
      CREATE TABLE initiative_versions (tenant_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, state_json TEXT NOT NULL, state_hash TEXT NOT NULL, PRIMARY KEY(tenant_id,kind,entity_id,version));
      CREATE TABLE initiative_commands (tenant_id TEXT NOT NULL, operation_key TEXT NOT NULL, tool_id TEXT NOT NULL, input_hash TEXT NOT NULL, receipt_json TEXT NOT NULL, requested_by TEXT NOT NULL, approved_by TEXT NOT NULL, run_id TEXT NOT NULL, step_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(tenant_id,operation_key));
      CREATE TABLE initiative_scans (tenant_id TEXT NOT NULL, actor_id TEXT NOT NULL, scanned_at TEXT NOT NULL, summary_json TEXT NOT NULL, PRIMARY KEY(tenant_id,actor_id));
    `),
        },
      ],
    });
  }

  profile(principal: Principal): CompanyProfile {
    this.principal(principal);
    return this.profileForTenant(principal.tenantId);
  }

  /** Trusted in-process config provider only; UI must keep using profile(principal). */
  profileForTenant(tenantId: string): CompanyProfile {
    if (!tenantId || tenantId.length > 100)
      return fail("TENANT_REQUIRED", "Wymagana organizacja.", 400);
    const row = this.db
      .prepare("SELECT record_json FROM initiative_profiles WHERE tenant_id=?")
      .get(tenantId);
    if (row) {
      const stored = JSON.parse(String(row.record_json)) as CompanyProfile;
      // Read old profiles without inventing bindings or a migration approval. Their
      // original version/authors remain intact and lifecycle rejects definition 1.
      if (stored.definitionVersion !== "3")
        return {
          ...stored,
          roleBindings: stored.roleBindings ?? {},
          employmentPolicy: defaultEmploymentPolicy,
          needsConfiguration: true,
        };
      return stored;
    }
    return {
      tenantId,
      version: 0,
      companyName: "Moja firma",
      timezone: "Europe/Warsaw",
      licenseReminderDays: 30,
      quietHours: { enabled: true, start: "20:00", end: "08:00" },
      rules: {
        overdue_case: true,
        overdue_task: true,
        expired_reservation: true,
        license_expiry: true,
        high_severity_incident: true,
      },
      employmentPolicy: defaultEmploymentPolicy,
      roleBindings: {},
      processTemplates: baselineProcessTemplates("internal"),
      updatedAt: null,
      updatedBy: null,
      updatedApprovedBy: null,
      definitionVersion: "3",
    };
  }

  list(principal: Principal) {
    this.scope(principal, "initiatives");
    const quiet = this.localTime(this.profile(principal)).quiet;
    return this.items(principal.tenantId)
      .filter((item) => this.visible(principal, item))
      .map((item) => ({
        ...item,
        deliveryState:
          item.status !== "open"
            ? item.status
            : quiet
              ? "quiet_hours"
              : "actionable",
      }))
      .sort((a, b) => {
        const order = { critical: 0, high: 1, medium: 2 };
        return (
          order[a.severity] - order[b.severity] ||
          b.firstObservedAt.localeCompare(a.firstObservedAt)
        );
      });
  }

  scan(principal: Principal) {
    this.scope(principal, "initiatives");
    const profile = this.profile(principal);
    const local = this.localTime(profile);
    const scannedAt = new Date(this.clock()).toISOString();
    const scannedModules: string[] = [];
    const sources: Entity[] = [];
    for (const module of modules) {
      if (!this.hasScope(principal, module)) continue;
      // Workspace enforces contextual scopes (e.g. lifecycle cases require people).
      sources.push(...this.workspace.list(principal, module));
      scannedModules.push(module);
    }
    const candidates = sources
      .flatMap((source) => this.detect(source, profile, local.date))
      .filter((candidate) =>
        this.sourceScopes(principal.tenantId, candidate).every((scope) =>
          this.hasScope(principal, scope),
        ),
      );
    const observedSources = new Map(
      sources.map((source) => [`${source.module}:${source.id}`, source]),
    );
    const observedFingerprints = new Set<string>();
    const summary = {
      scannedAt,
      scannedModules,
      created: 0,
      updated: 0,
      resolved: 0,
      observed: candidates.length,
      quietHours: local.quiet,
      actionable: 0,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const fingerprint = hash({
          tenantId: principal.tenantId,
          module: candidate.module,
          sourceId: candidate.sourceId,
          sourceItemId: candidate.sourceItemId,
          rule: candidate.rule,
        });
        observedFingerprints.add(fingerprint);
        const row = this.db
          .prepare(
            "SELECT record_json FROM initiative_items WHERE tenant_id=? AND fingerprint=?",
          )
          .get(principal.tenantId, fingerprint);
        const previous = row
          ? (JSON.parse(String(row.record_json)) as Initiative)
          : undefined;
        if (!previous) {
          const item: Initiative = {
            ...candidate,
            id: randomUUID(),
            fingerprint,
            version: 1,
            status: "open",
            definitionVersion: "1",
            profileVersion: profile.version,
            snoozedUntil: null,
            firstObservedAt: scannedAt,
            lastObservedAt: scannedAt,
            resolvedAt: null,
            reason: null,
            updatedBy: null,
          };
          this.saveItem(principal.tenantId, item, true);
          summary.created++;
        } else {
          const reopen =
            previous.sourceFingerprint !== candidate.sourceFingerprint ||
            previous.status === "resolved" ||
            (previous.status === "snoozed" &&
              Date.parse(previous.snoozedUntil ?? "") <= this.clock());
          const next: Initiative = {
            ...previous,
            ...candidate,
            profileVersion: profile.version,
            lastObservedAt: scannedAt,
            ...(reopen
              ? {
                  status: "open",
                  snoozedUntil: null,
                  resolvedAt: null,
                  reason: null,
                  updatedBy: null,
                }
              : {}),
          };
          const changed =
            hash(stableInitiative(previous)) !== hash(stableInitiative(next));
          if (changed) {
            next.version++;
            summary.updated++;
          }
          this.saveItem(principal.tenantId, next, changed);
        }
      }
      for (const item of this.items(principal.tenantId)) {
        const source = observedSources.get(`${item.module}:${item.sourceId}`);
        // A partial/forbidden scan must never resolve another reader's unseen source.
        if (
          !source ||
          !this.visible(principal, item) ||
          observedFingerprints.has(item.fingerprint) ||
          item.status === "resolved"
        )
          continue;
        const next: Initiative = {
          ...item,
          status: "resolved",
          version: item.version + 1,
          sourceVersion: source.version,
          sourceUpdatedAt: source.updatedAt,
          lastObservedAt: scannedAt,
          profileVersion: profile.version,
          resolvedAt: scannedAt,
          snoozedUntil: null,
          reason: profile.rules[item.rule]
            ? "Źródło nie spełnia już warunku reguły."
            : "Reguła została wyłączona w zatwierdzonym profilu.",
          updatedBy: null,
        };
        this.saveItem(principal.tenantId, next, true);
        summary.resolved++;
      }
      summary.actionable = local.quiet
        ? 0
        : this.list(principal).filter((item) => item.status === "open").length;
      this.db
        .prepare(
          "INSERT INTO initiative_scans VALUES(?,?,?,?) ON CONFLICT(tenant_id,actor_id) DO UPDATE SET scanned_at=excluded.scanned_at,summary_json=excluded.summary_json",
        )
        .run(principal.tenantId, principal.id, scannedAt, canonical(summary));
      this.db.exec("COMMIT");
      return summary;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  tools(): ToolDefinition[] {
    const base = {
      id: z.string().uuid(),
      expectedVersion: z.number().int().min(1),
    };
    const schemas: Record<string, z.ZodType> = {
      snooze: z
        .object({
          ...base,
          until: z.string().datetime(),
          reason: z.string().trim().min(1).max(2000),
        })
        .strict(),
      dismiss: z
        .object({ ...base, reason: z.string().trim().min(1).max(2000) })
        .strict(),
      resume: z
        .object({ ...base, reason: z.string().trim().min(1).max(2000) })
        .strict(),
      configure: settingsSchema
        .extend({ expectedVersion: z.number().int().min(0) })
        .strict(),
    };
    const labels: Record<string, string> = {
      snooze: "Odłóż propozycję do wskazanego czasu.",
      dismiss: "Odrzuć propozycję do istotnej zmiany źródła.",
      resume: "Przywróć odłożoną lub odrzuconą propozycję.",
      configure:
        "Zapisz nową wersję profilu firmy, terminów przypomnień, ciszy nocnej i aktywnych reguł.",
    };
    return Object.entries(schemas).map(
      ([action, inputSchema]): ToolDefinition => {
        const toolId = `initiatives.${action}`;
        return {
          id: toolId,
          version: action === "configure" ? "3" : "1",
          scope: action === "configure" ? "company" : "initiatives",
          effect: "write",
          recovery: "reconcile",
          description: `${labels[action]} Wyłącznie dane lokalne; wymaga zatwierdzenia Core i nie zmienia danych źródłowych.`,
          inputSchema,
          requiredScopesForInput:
            action === "configure"
              ? undefined
              : (input, tenantId) =>
                  this.sourceScopes(
                    tenantId,
                    this.item(tenantId, String(input.id)),
                  ),
          execute: async (ctx, raw) => {
            this.context(ctx);
            const parsed = inputSchema.safeParse(raw);
            if (!parsed.success)
              fail(
                "INVALID_INITIATIVE_INPUT",
                "Niepoprawne pola polecenia inicjatywy.",
                400,
              );
            const input = json(parsed.data);
            const releasePolicy =
              action === "configure"
                ? this.workspace.acquireEmploymentPolicyLock()
                : () => {};
            let transactionStarted = false;
            try {
              this.db.exec("BEGIN IMMEDIATE");
              transactionStarted = true;
              const existing = this.command(ctx, toolId, input);
              if (existing) {
                this.db.exec("COMMIT");
                transactionStarted = false;
                return JSON.parse(String(existing.receipt_json)) as ToolResult;
              }
              const now = new Date(this.clock()).toISOString();
              let kind: string;
              let entityId: string;
              let version: number;
              let stateHash: string;
              if (action === "configure") {
                const current = this.profile({
                  id: ctx.actorId!,
                  tenantId: ctx.tenantId,
                  roles: ["operator"],
                  scopes: [],
                });
                if (current.version !== input.expectedVersion)
                  fail(
                    "VERSION_CONFLICT",
                    "Profil zmienił się; odczytaj aktualną wersję.",
                  );
                const { expectedVersion: _expectedVersion, ...settings } =
                  input;
                const next: CompanyProfile = {
                  ...settingsSchema.parse(settings),
                  tenantId: ctx.tenantId,
                  version: current.version + 1,
                  updatedAt: now,
                  updatedBy: ctx.actorId!,
                  updatedApprovedBy: ctx.approvedBy!,
                  definitionVersion: "3",
                };
                this.db
                  .prepare(
                    "INSERT INTO initiative_profiles VALUES(?,?) ON CONFLICT(tenant_id) DO UPDATE SET record_json=excluded.record_json",
                  )
                  .run(ctx.tenantId, canonical(next));
                kind = "profile";
                entityId = ctx.tenantId;
                version = next.version;
                stateHash = hash(next);
                this.saveVersion(
                  ctx.tenantId,
                  kind,
                  entityId,
                  version,
                  next,
                  stateHash,
                );
              } else {
                const current = this.item(ctx.tenantId, String(input.id));
                if (current.version !== input.expectedVersion)
                  fail(
                    "VERSION_CONFLICT",
                    "Propozycja zmieniła się; odczytaj aktualną wersję.",
                  );
                if (current.status === "resolved")
                  fail(
                    "INITIATIVE_RESOLVED",
                    "Źródłowy warunek ustąpił. Nowy skan może wykryć jego powrót.",
                  );
                if (
                  action === "resume" &&
                  !["snoozed", "dismissed"].includes(current.status)
                )
                  fail(
                    "INITIATIVE_STATE",
                    "Przywrócić można odłożoną lub odrzuconą propozycję.",
                  );
                if (
                  action === "snooze" &&
                  (Date.parse(String(input.until)) <= this.clock() ||
                    Date.parse(String(input.until)) >
                      this.clock() + 90 * 86_400_000)
                )
                  fail(
                    "INVALID_SNOOZE",
                    "Odłożenie musi wskazywać przyszłość, najwyżej 90 dni.",
                  );
                const next: Initiative = {
                  ...current,
                  version: current.version + 1,
                  status:
                    action === "snooze"
                      ? "snoozed"
                      : action === "dismiss"
                        ? "dismissed"
                        : "open",
                  snoozedUntil:
                    action === "snooze" ? String(input.until) : null,
                  reason: String(input.reason),
                  updatedBy: ctx.actorId!,
                };
                this.saveItem(ctx.tenantId, next, true);
                kind = "initiative";
                entityId = next.id;
                version = next.version;
                stateHash = hash(stableInitiative(next));
              }
              const receipt: ToolResult = {
                data: { kind, entityId, version, stateHash },
              };
              this.db
                .prepare(
                  "INSERT INTO initiative_commands VALUES(?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                  ctx.tenantId,
                  ctx.operationKey,
                  toolId,
                  hash(input),
                  canonical(receipt),
                  ctx.actorId!,
                  ctx.approvedBy!,
                  ctx.runId,
                  ctx.stepId,
                  now,
                );
              this.db.exec("COMMIT");
              transactionStarted = false;
              return receipt;
            } catch (error) {
              if (transactionStarted) this.db.exec("ROLLBACK");
              throw error;
            } finally {
              releasePolicy();
            }
          },
          reconcile: async (ctx, input) => {
            const row = this.command(ctx, toolId, input);
            return row
              ? {
                  status: "applied",
                  result: JSON.parse(String(row.receipt_json)) as ToolResult,
                }
              : { status: "not_applied" };
          },
          verify: async (ctx, input, result) => {
            let ok = false;
            try {
              const command = this.command(ctx, toolId, input);
              const receipt = command
                ? (JSON.parse(String(command.receipt_json)) as ToolResult)
                : null;
              if (receipt && canonical(receipt) === canonical(result)) {
                const { kind, entityId, version, stateHash } = receipt.data;
                const historical = this.db
                  .prepare(
                    "SELECT * FROM initiative_versions WHERE tenant_id=? AND kind=? AND entity_id=? AND version=?",
                  )
                  .get(
                    ctx.tenantId,
                    String(kind),
                    String(entityId),
                    Number(version),
                  );
                const current =
                  kind === "profile"
                    ? this.profile({
                        id: "verification",
                        tenantId: ctx.tenantId,
                        roles: ["viewer"],
                      })
                    : this.item(ctx.tenantId, String(entityId));
                const latest = this.db
                  .prepare(
                    "SELECT state_hash FROM initiative_versions WHERE tenant_id=? AND kind=? AND entity_id=? AND version=?",
                  )
                  .get(
                    ctx.tenantId,
                    String(kind),
                    String(entityId),
                    current.version,
                  );
                ok = Boolean(
                  historical &&
                  historical.state_hash === stateHash &&
                  hash(JSON.parse(String(historical.state_json))) ===
                    stateHash &&
                  latest?.state_hash ===
                    hash(
                      kind === "profile"
                        ? current
                        : stableInitiative(current as Initiative),
                    ),
                );
              }
            } catch {
              ok = false;
            }
            return {
              ok,
              summary: ok
                ? "Niezależny odczyt potwierdza zapisane ustawienia lub stan propozycji."
                : "Brak spójnego dowodu zmiany inicjatywy.",
              evidence: [
                {
                  source: "jarvis-initiatives:versions-and-current-state",
                  observedAt: new Date(this.clock()).toISOString(),
                  summary:
                    "Odczyt trwałego rejestru poleceń, wersji oraz bieżącego stanu w tej samej firmie.",
                  data: {
                    tenantId: ctx.tenantId,
                    operationKey: ctx.operationKey,
                    toolId,
                    verified: ok,
                  },
                },
              ],
            };
          },
        };
      },
    );
  }

  health() {
    return this.db.prepare("SELECT 1 AS ok").get()?.ok === 1;
  }
  close() {
    this.db.close();
  }

  private principal(principal: Principal) {
    if (!principal.id || !principal.tenantId || !principal.roles.length)
      fail("PRINCIPAL_REQUIRED", "Wymagana tożsamość organizacji.", 403);
  }
  private hasScope(principal: Principal, scope: string) {
    return Boolean(
      principal.scopes?.includes("*") || principal.scopes?.includes(scope),
    );
  }
  private scope(principal: Principal, scope: string) {
    this.principal(principal);
    if (!this.hasScope(principal, scope))
      fail("SCOPE_REQUIRED", "Brak dostępu do tej kompetencji.", 403);
  }
  private context(ctx: ToolContext) {
    if (
      !ctx.actorId ||
      !ctx.approvedBy ||
      !ctx.tenantId ||
      !ctx.runId ||
      !ctx.stepId ||
      !ctx.operationKey
    )
      fail(
        "TRUSTED_CONTEXT_REQUIRED",
        "Wymagany zaufany kontekst zatwierdzonego polecenia Core.",
        403,
      );
  }
  private item(tenantId: string, id: string): Initiative {
    const row = this.db
      .prepare(
        "SELECT record_json FROM initiative_items WHERE tenant_id=? AND id=?",
      )
      .get(tenantId, id);
    if (!row)
      return fail("INITIATIVE_NOT_FOUND", "Nie znaleziono propozycji.", 404);
    return JSON.parse(String(row.record_json)) as Initiative;
  }
  private items(tenantId: string): Initiative[] {
    return this.db
      .prepare("SELECT record_json FROM initiative_items WHERE tenant_id=?")
      .all(tenantId)
      .map((row) => JSON.parse(String(row.record_json)) as Initiative);
  }
  private sourceScopes(
    tenantId: string,
    item: Pick<Initiative, "module" | "sourceId" | "ownerId">,
  ): string[] {
    const sourceTool = this.sourceTools.get(`ops.${item.module}.update`);
    return [
      ...new Set([
        item.module,
        ...(item.ownerId ? ["people"] : []),
        ...(sourceTool?.requiredScopesForInput?.(
          { id: item.sourceId },
          tenantId,
        ) ?? []),
      ]),
    ];
  }
  private visible(principal: Principal, item: Initiative): boolean {
    try {
      if (
        !this.sourceScopes(principal.tenantId, item).every((scope) =>
          this.hasScope(principal, scope),
        )
      )
        return false;
      this.workspace.get(principal, item.module, item.sourceId);
      return true;
    } catch {
      return false;
    }
  }
  private saveItem(tenantId: string, item: Initiative, revision: boolean) {
    this.db
      .prepare(
        "INSERT INTO initiative_items VALUES(?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET record_json=excluded.record_json",
      )
      .run(
        tenantId,
        item.id,
        item.fingerprint,
        item.module,
        item.sourceId,
        canonical(item),
      );
    if (revision)
      this.saveVersion(
        tenantId,
        "initiative",
        item.id,
        item.version,
        stableInitiative(item),
        hash(stableInitiative(item)),
      );
  }
  private saveVersion(
    tenantId: string,
    kind: string,
    id: string,
    version: number,
    state: unknown,
    stateHash: string,
  ) {
    this.db
      .prepare("INSERT INTO initiative_versions VALUES(?,?,?,?,?,?)")
      .run(tenantId, kind, id, version, canonical(state), stateHash);
  }
  private command(
    ctx: ToolContext,
    toolId: string,
    input: JsonObject,
  ): Row | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM initiative_commands WHERE tenant_id=? AND operation_key=?",
      )
      .get(ctx.tenantId, ctx.operationKey);
    if (row && (row.tool_id !== toolId || row.input_hash !== hash(input)))
      fail(
        "IDEMPOTENCY_CONFLICT",
        "Klucz operacji został użyty dla innego polecenia.",
      );
    return row;
  }
  private localTime(profile: CompanyProfile) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: profile.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(this.clock());
    const part = (type: string) =>
      parts.find((item) => item.type === type)!.value;
    const date = `${part("year")}-${part("month")}-${part("day")}`;
    const time = `${part("hour")}:${part("minute")}`;
    const { enabled, start, end } = profile.quietHours;
    const quiet =
      enabled &&
      start !== end &&
      (start < end ? time >= start && time < end : time >= start || time < end);
    return { date, quiet };
  }
  private detect(
    entity: Entity,
    profile: CompanyProfile,
    today: string,
  ): Candidate[] {
    const found: Candidate[] = [];
    const add = (
      rule: Rule,
      fields: Pick<
        Candidate,
        "title" | "summary" | "severity" | "dueDate" | "ownerId"
      >,
      relevant: unknown,
      sourceItemId: string | null = null,
      mandatory = false,
    ) => {
      if (!mandatory && !profile.rules[rule]) return;
      found.push({
        ...fields,
        ownerPrincipalId: textValue(entity.data.ownerPrincipalId),
        rule,
        module: entity.module,
        sourceId: entity.id,
        sourceItemId,
        sourceVersion: entity.version,
        sourceUpdatedAt: entity.updatedAt,
        sourceFingerprint: hash(relevant),
      });
    };
    const data = entity.data;
    if (
      entity.module === "cases" &&
      !["accepted", "cancelled"].includes(entity.status)
    ) {
      if (validDate(data.dueDate) && data.dueDate < today)
        add(
          "overdue_case",
          {
            title: `Sprawa po terminie: ${entity.title}`,
            summary:
              "Ustal termin i właściciela dalszego działania; propozycja nie zmienia sprawy.",
            severity: "high",
            dueDate: data.dueDate,
            ownerId: textValue(data.ownerId),
          },
          {
            status: entity.status,
            dueDate: data.dueDate,
            ownerId: data.ownerId ?? null,
            scopeRevision: data.scopeRevision,
          },
        );
      for (const task of listData(data.tasks))
        if (
          !["completed", "cancelled"].includes(String(task.status)) &&
          (task.status === "declined" ||
            (validDate(task.dueDate) && task.dueDate < today))
        )
          add(
            "overdue_task",
            {
              title: `${task.status === "declined" ? "Odmowa zadania" : "Zadanie po terminie"}: ${String(task.title)}`,
              summary: `Właściciel sprawy „${entity.title}” musi ustalić wykonawcę i dalsze działanie.`,
              severity: task.required ? "high" : "medium",
              dueDate: textValue(task.dueDate),
              ownerId: textValue(data.ownerId),
            },
            {
              id: task.id,
              dueDate: task.dueDate,
              assigneeId: task.assigneeId ?? null,
              assigneePrincipalId: task.assigneePrincipalId ?? null,
              status: task.status,
              required: task.required,
              scopeRevision: data.scopeRevision,
            },
            textValue(task.id),
            task.status === "declined",
          );
    }
    if (entity.module === "assets" && entity.status === "reserved")
      for (const allocation of listData(data.allocations))
        if (
          allocation.status === "reserved" &&
          validDate(allocation.reservedUntil) &&
          (typeof allocation.expiresAt === "string"
            ? Number.isFinite(Date.parse(allocation.expiresAt)) &&
              this.clock() >= Date.parse(allocation.expiresAt)
            : allocation.reservedUntil < today)
        )
          add(
            "expired_reservation",
            {
              title: `${allocation.expiresAt ? "Wygasła rezerwacja" : "Historyczny termin do uzgodnienia"}: ${entity.title}`,
              summary: allocation.expiresAt
                ? "Upłynął utrwalony termin rezerwacji. Sprawdź potrzebę, następnie zaplanuj zatwierdzane zwolnienie sprzętu."
                : "Historyczna rezerwacja nie ma utrwalonego czasu wygaśnięcia. Sprawdź właściwy termin i powiązania przed decyzją o zwolnieniu; obserwacja nie zwalnia sprzętu.",
              severity: "medium",
              dueDate: allocation.reservedUntil,
              ownerId: textValue(allocation.personId),
            },
            {
              id: allocation.id,
              reservedUntil: allocation.reservedUntil,
              expiresAt: allocation.expiresAt ?? null,
              allocationVersion: allocation.version ?? null,
              personId: allocation.personId,
            },
            textValue(allocation.id),
          );
    if (
      entity.module === "licenses" &&
      validDate(data.expiresOn) &&
      !["archived", "inactive", "cancelled"].includes(entity.status) &&
      dayDistance(today, data.expiresOn) <= profile.licenseReminderDays
    ) {
      const expired = data.expiresOn < today;
      add(
        "license_expiry",
        {
          title: `${expired ? "Wygasła licencja" : "Licencja wygasa"}: ${entity.title}`,
          summary: expired
            ? "Zweryfikuj prawo do dalszego korzystania i zaplanuj lokalny zapis odnowienia po uzyskaniu dowodu."
            : "Sprawdź potrzebę odnowienia i warunki dostawcy przed upływem terminu.",
          severity: expired ? "critical" : "medium",
          dueDate: data.expiresOn,
          ownerId: null,
        },
        { expiresOn: data.expiresOn, expired },
      );
    }
    if (
      entity.module === "it" &&
      data.kind === "incident" &&
      ["high", "critical"].includes(String(data.severity)) &&
      !["resolved", "closed", "cancelled"].includes(entity.status)
    )
      add(
        "high_severity_incident",
        {
          title: `Incydent wymaga reakcji: ${entity.title}`,
          summary:
            "Otwarty lokalny incydent wymaga właściciela oraz udokumentowanej diagnozy i działania.",
          severity: data.severity === "critical" ? "critical" : "high",
          dueDate: null,
          ownerId: textValue(data.ownerId),
        },
        {
          status: entity.status,
          severity: data.severity,
          ownerId: data.ownerId ?? null,
        },
      );
    return found;
  }
}
