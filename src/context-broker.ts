import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { equipmentType } from "./purchase-delivery-models.js";
import { DomainError, type JsonObject, type Principal } from "./contracts.js";
import { migrateDatabase } from "./migrations.js";
import { date } from "./workspace-models.js";
import type { Entity, WorkspaceStore } from "./workspace.js";

const opaque = z.string().regex(/^ctx_[A-Za-z0-9_-]{32}$/);
const purpose = z.enum(["equipment_request", "employment", "case_followup"]);
const limit = z.number().int().min(1).max(5);
export const contextSchemas = {
  "context.company": z.object({ purpose }).strict(),
  "context.findPeople": z
    .object({
      query: z.string().trim().min(2).max(120),
      limit,
      cursor: opaque.optional(),
    })
    .strict(),
  "context.personWork": z
    .object({
      personRef: opaque,
      purpose: z.enum(["equipment_request", "employment"]),
      cursor: opaque.optional(),
    })
    .strict(),
  "context.findCases": z
    .object({
      personRef: opaque.optional(),
      episodeRef: opaque.optional(),
      state: z.enum(["open", "any"]),
      limit,
      cursor: opaque.optional(),
    })
    .strict(),
  "context.availableAssets": z
    .object({
      assetType: equipmentType,
      readyOn: date,
      episodeRef: opaque,
      limit,
    })
    .strict(),
  "context.readRecord": z.object({ ref: opaque, purpose }).strict(),
} as const;
export type ContextToolName = keyof typeof contextSchemas;
export type ContextPurpose = z.infer<typeof purpose>;
export type ContextKind =
  | "company"
  | "person"
  | "episode"
  | "case"
  | "task"
  | "asset"
  | "document"
  | "application"
  | "role";
export interface ContextSource {
  module: string;
  id: string;
  version: number;
  updatedAt: string | null;
  observedAt: string;
  classification:
    | "company_operational"
    | "person_operational"
    | "task_operational"
    | "document_metadata";
  projectionVersion: "1";
  projectionHash: string;
}
export interface ContextRecord {
  ref: string;
  kind: ContextKind;
  label: string;
  data: JsonObject;
  source: ContextSource;
  freshness: "current";
}
export interface CloudContextRecord {
  ref: string;
  kind: ContextKind;
  label: string;
  data: JsonObject;
  source: Omit<ContextSource, "id">;
  freshness: "current";
}
export interface BrokerResult {
  items: ContextRecord[];
  nextCursor?: string;
  cloud: { items: CloudContextRecord[]; nextCursor?: string };
  budget: { reads: number; bytes: number; maxReads: 4; maxBytes: 24576 };
}
export interface ContextTurn {
  id: string;
  conversationId: string;
  principal: Principal;
}
export interface BrokerCompanyProfile {
  version: number;
  timezone: string;
  definitionVersion: string;
  updatedAt: string | null;
  updatedApprovedBy?: string | null;
  roleBindings?: { hr?: string; it?: string; manager?: string };
  employmentPolicy?: {
    mode: string;
    maxConcurrent: number;
    allowInternalOverlap: boolean;
  };
}
export interface ContextBrokerOptions {
  principalProvider?: (tenantId: string) => Principal[];
  companyProvider?: (tenantId: string) => BrokerCompanyProfile;
  clock?: () => number;
  tokenTtlMs?: number;
}
export interface ResolvedReference {
  kind: ContextKind;
  purpose: ContextPurpose;
  module: string;
  id: string;
  version: number;
  personId?: string;
  employmentEpisodeId?: string;
  caseId?: string;
  source: ContextSource;
}
interface Episode {
  id: string;
  personId?: string;
  version?: number;
  kind: string;
  status: string;
  startDate: string;
  endDate: string | null;
  role: string;
  onboardingCaseId?: string | null;
  offboardingCaseId?: string | null;
  engagementRef?: { module: string; id: string } | null;
}
interface Reference {
  kind: ContextKind;
  module: string;
  id: string;
  parentId?: string;
  purpose: ContextPurpose;
  requestedReadyOn?: string;
}
interface Projection {
  reference: Reference;
  label: string;
  data: JsonObject;
  cloud: JsonObject;
  version: number;
  updatedAt: string | null;
  classification: ContextSource["classification"];
}
type Row = Record<string, unknown>;
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const authority = (p: Principal) =>
  hash({ roles: [...p.roles].sort(), scopes: [...(p.scopes ?? [])].sort() });
const nonce = () => `ctx_${randomBytes(24).toString("base64url")}`;
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const label = (value: unknown, max = 160) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9_.-]+/g, "[SEKRET]")
    .replace(/\b\d{11}\b/g, "[IDENTYFIKATOR]")
    .trim()
    .slice(0, max);
const safeDate = (value: unknown): string | null =>
  typeof value === "string" && date.safeParse(value).success ? value : null;
const integer = (value: unknown, fallback = 0) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
const enumValue = (
  value: unknown,
  allowed: readonly string[],
): string | null =>
  typeof value === "string" && allowed.includes(value) ? value : null;
const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/gi, "l")
    .toLowerCase();
const rows = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? (value.filter(
        (v) => v && typeof v === "object" && !Array.isArray(v),
      ) as JsonObject[])
    : [];
const openCases = new Set(["open", "needs_changes", "awaiting_acceptance"]);
const operationalStatuses = [
  "registered",
  "onboarding",
  "active",
  "offboarding",
  "exited",
  "ended",
  "open",
  "needs_changes",
  "awaiting_acceptance",
  "accepted",
  "cancelled",
  "available",
  "reserved",
  "issued",
  "repair",
  "draft",
  "review",
  "approved",
  "rejected",
  "archived",
  "new",
  "screened",
  "interviewed",
  "offered",
  "hired",
  "withdrawn",
  "closed",
  "unassigned",
  "declined",
  "completed",
];

/** All returned free text is untrusted data. Only `result.cloud` may be sent to a
 * model: it contains no arbitrary titles, names, notes, document text or logins. */
export class ContextBroker {
  private readonly clock: () => number;
  private readonly ttl: number;
  private principals?: ContextBrokerOptions["principalProvider"];
  private company?: ContextBrokerOptions["companyProvider"];
  constructor(
    private readonly db: DatabaseSync,
    private readonly workspace: WorkspaceStore,
    options: ContextBrokerOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.ttl = options.tokenTtlMs ?? 15 * 60_000;
    if (
      !Number.isInteger(this.ttl) ||
      this.ttl < 1 ||
      this.ttl > 24 * 60 * 60_000
    )
      throw new Error("Invalid context token lifetime.");
    this.principals = options.principalProvider;
    this.company = options.companyProvider;
    migrateDatabase(db, {
      namespace: "context",
      migrations: [
        {
          version: 1,
          name: "Bound context references and durable turn budgets",
          up: (db) =>
            db.exec(`
      CREATE TABLE context_turns(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_id TEXT NOT NULL,turn_key TEXT NOT NULL,authority_hash TEXT NOT NULL,reads INTEGER NOT NULL DEFAULT 0,bytes INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(tenant_id,actor_id,conversation_id,turn_key));
      CREATE TABLE context_tokens(token_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_id TEXT NOT NULL,authority_hash TEXT NOT NULL,kind TEXT NOT NULL,binding_json TEXT NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,created_at TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE context_aliases(tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,alias TEXT NOT NULL,PRIMARY KEY(tenant_id,actor_id,conversation_id,kind,source_id));
      CREATE TABLE context_reads(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,tool_id TEXT NOT NULL,status TEXT NOT NULL,record_count INTEGER NOT NULL,bytes INTEGER NOT NULL,created_at TEXT NOT NULL);
    `),
        },
        {
          version: 2,
          name: "Durable model attempts across failed turn recovery",
          up: (db) =>
            db.exec(
              "ALTER TABLE context_turns ADD COLUMN model_calls INTEGER NOT NULL DEFAULT 0 CHECK(model_calls>=0 AND model_calls<=8)",
            ),
        },
      ],
    });
  }
  setPrincipalProvider(
    provider: NonNullable<ContextBrokerOptions["principalProvider"]>,
  ) {
    this.principals = provider;
  }
  setCompanyProvider(
    provider: NonNullable<ContextBrokerOptions["companyProvider"]>,
  ) {
    this.company = provider;
  }
  private live(p: Principal): Principal {
    const matches = (this.principals?.(p.tenantId) ?? []).filter(
      (v) => v.tenantId === p.tenantId && v.id === p.id,
    );
    const live = matches.length === 1 ? matches[0] : undefined;
    if (
      !live ||
      !live.roles.includes("operator") ||
      authority(live) !== authority(p)
    )
      fail(
        "CONTEXT_AUTHORITY_CHANGED",
        "Brak aktualnego uprawnienia do kontekstu rozmowy.",
        403,
      );
    return live;
  }
  private conversation(p: Principal, id: string) {
    const row = this.db
      .prepare(
        "SELECT authority_hash FROM conversations WHERE id=? AND tenant_id=? AND actor_id=?",
      )
      .get(id, p.tenantId, p.id);
    if (!row || row.authority_hash !== authority(p))
      fail(
        "CONTEXT_CONVERSATION_FORBIDDEN",
        "Brak dostępu do kontekstu rozmowy.",
        403,
      );
  }
  beginTurn(
    principal: Principal,
    conversationId: string,
    serverTurnKey: string,
  ): ContextTurn {
    const p = this.live(principal);
    this.conversation(p, conversationId);
    if (!serverTurnKey || serverTurnKey.length > 200)
      fail("CONTEXT_TURN_INVALID", "Niepoprawny identyfikator tury.", 400);
    const key = hash(serverTurnKey);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO context_turns(id,tenant_id,actor_id,conversation_id,turn_key,authority_hash,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        p.tenantId,
        p.id,
        conversationId,
        key,
        authority(p),
        this.now(),
      );
    const row = this.db
      .prepare(
        "SELECT id,authority_hash FROM context_turns WHERE tenant_id=? AND actor_id=? AND conversation_id=? AND turn_key=?",
      )
      .get(p.tenantId, p.id, conversationId, key)!;
    if (row.authority_hash !== authority(p))
      fail("CONTEXT_AUTHORITY_CHANGED", "Uprawnienia tury zmieniły się.", 403);
    return {
      id: String(row.id),
      conversationId,
      principal: { ...p, roles: [...p.roles], scopes: [...(p.scopes ?? [])] },
    };
  }
  private guard(turn: ContextTurn): Principal {
    const p = this.live(turn.principal);
    this.conversation(p, turn.conversationId);
    const row = this.db
      .prepare(
        "SELECT authority_hash FROM context_turns WHERE id=? AND tenant_id=? AND actor_id=? AND conversation_id=?",
      )
      .get(turn.id, p.tenantId, p.id, turn.conversationId);
    if (!row || row.authority_hash !== authority(p))
      fail("CONTEXT_TURN_FORBIDDEN", "Nieprawidłowy kontekst tury.", 403);
    return p;
  }
  /** Trusted orchestration guard; grants no new budget and exposes no records. */
  assertCurrent(turn: ContextTurn): Principal {
    const p = this.guard(turn);
    return { ...p, roles: [...p.roles], scopes: [...(p.scopes ?? [])] };
  }
  /** Claim one attempted provider call before I/O. Failures and process loss do
   * not refund it: a retry cannot prove that the provider did not receive it. */
  claimModelCall(turn: ContextTurn): void {
    const principal = this.guard(turn);
    const changed = this.db
      .prepare(
        "UPDATE context_turns SET model_calls=model_calls+1 WHERE id=? AND tenant_id=? AND actor_id=? AND conversation_id=? AND authority_hash=? AND model_calls<8",
      )
      .run(
        turn.id,
        principal.tenantId,
        principal.id,
        turn.conversationId,
        authority(principal),
      );
    if (Number(changed.changes) !== 1)
      fail(
        "CONTEXT_MODEL_CALL_LIMIT",
        "Osiągnięto limit ośmiu prób modelu tej tury.",
        429,
      );
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private takeRead(turn: ContextTurn) {
    const changed = this.db
      .prepare("UPDATE context_turns SET reads=reads+1 WHERE id=? AND reads<4")
      .run(turn.id);
    if (Number(changed.changes) !== 1)
      fail(
        "CONTEXT_READ_LIMIT",
        "Osiągnięto limit czterech odczytów tej tury.",
        429,
      );
  }
  private budget(turn: ContextTurn): BrokerResult["budget"] {
    const row = this.db
      .prepare("SELECT reads,bytes FROM context_turns WHERE id=?")
      .get(turn.id)!;
    return {
      reads: Number(row.reads),
      bytes: Number(row.bytes),
      maxReads: 4,
      maxBytes: 24576,
    };
  }
  read(
    turn: ContextTurn,
    toolName: ContextToolName,
    raw: unknown,
  ): BrokerResult {
    return this.capture(
      turn,
      Object.hasOwn(contextSchemas, toolName) ? toolName : "unknown",
      (p) => {
        if (!Object.hasOwn(contextSchemas, toolName))
          fail("CONTEXT_TOOL_FORBIDDEN", "Nieznany odczyt kontekstu.", 403);
        const parsed = contextSchemas[toolName].safeParse(raw);
        if (!parsed.success)
          fail(
            "CONTEXT_INPUT_INVALID",
            "Niepoprawne pola odczytu kontekstu.",
            400,
          );
        return this.dispatch(turn, p, toolName, parsed.data as JsonObject);
      },
    );
  }
  /** Trusted server entry for an explicit local UI/source selection, never an
   * extra model tool. It consumes the same durable read and byte budget. */
  reference(
    turn: ContextTurn,
    selected: {
      module:
        "people" | "cases" | "assets" | "documents" | "licenses" | "roles";
      id: string;
    },
    forPurpose: ContextPurpose,
  ): BrokerResult {
    return this.capture(turn, "context.reference", (p) => {
      const parsed = z
        .object({
          selected: z
            .object({
              module: z.enum([
                "people",
                "cases",
                "assets",
                "documents",
                "licenses",
                "roles",
              ]),
              id: z.string().min(1).max(200),
            })
            .strict(),
          purpose,
        })
        .strict()
        .safeParse({ selected, purpose: forPurpose });
      if (!parsed.success)
        fail("CONTEXT_INPUT_INVALID", "Niepoprawny wybór źródła.", 400);
      const {
        selected: { module, id },
        purpose: use,
      } = parsed.data;
      if (module !== "roles" && !z.string().uuid().safeParse(id).success)
        fail(
          "CONTEXT_REFERENCE_INVALID",
          "Wymagany identyfikator istniejącego rekordu.",
          400,
        );
      const kinds: Record<string, ContextKind> = {
        people: "person",
        cases: "case",
        assets: "asset",
        documents: "document",
        licenses: "application",
        roles: "role",
      };
      return this.result(turn, [
        this.projection(p, {
          kind: kinds[module]!,
          module: module === "roles" ? "company" : module,
          id,
          purpose: use,
        }),
      ]);
    });
  }
  private capture(
    turn: ContextTurn,
    toolName: string,
    operation: (p: Principal) => Omit<BrokerResult, "budget">,
  ): BrokerResult {
    const p = this.guard(turn);
    this.takeRead(turn);
    let count = 0,
      bytes = 0;
    try {
      const result = operation(p);
      count = result.items.length;
      bytes = Buffer.byteLength(canonical(result));
      this.guard(turn);
      const changed = this.db
        .prepare(
          "UPDATE context_turns SET bytes=bytes+? WHERE id=? AND bytes+?<=24576",
        )
        .run(bytes, turn.id, bytes);
      if (Number(changed.changes) !== 1)
        fail("CONTEXT_BYTE_LIMIT", "Osiągnięto limit kontekstu tej tury.", 429);
      this.audit(turn, toolName, "allowed", count, bytes);
      return { ...result, budget: this.budget(turn) };
    } catch (e) {
      this.audit(turn, toolName, "denied", 0, 0);
      throw e;
    }
  }
  private audit(
    turn: ContextTurn,
    tool: string,
    status: string,
    count: number,
    bytes: number,
  ) {
    this.db
      .prepare("INSERT INTO context_reads VALUES(?,?,?,?,?,?,?)")
      .run(randomUUID(), turn.id, tool, status, count, bytes, this.now());
  }
  private list(p: Principal, module: string): Entity[] {
    try {
      return this.workspace.list(p, module);
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 403) return [];
      throw error;
    }
  }
  private tasks(p: Principal) {
    try {
      return this.workspace.listTasks(p);
    } catch (error) {
      if (error instanceof DomainError && error.statusCode === 403) return [];
      throw error;
    }
  }
  private profile(tenantId: string): BrokerCompanyProfile {
    const p = this.company?.(tenantId);
    if (!p)
      fail(
        "CONTEXT_COMPANY_UNAVAILABLE",
        "Brak odczytu zatwierdzonej konfiguracji firmy.",
        409,
      );
    return p;
  }
  private projection(p: Principal, r: Reference): Projection {
    if (r.kind === "role") {
      const profile = this.profile(p.tenantId),
        role = enumValue(r.id, ["hr", "it", "manager"]);
      if (!role)
        fail(
          "CONTEXT_PROJECTION_FORBIDDEN",
          "Nieobsługiwana rola procesu.",
          403,
        );
      if (profile.version < 1 || !profile.updatedApprovedBy)
        fail(
          "CONTEXT_ROLE_UNCONFIRMED",
          "Obsada roli wymaga zatwierdzonego profilu.",
        );
      const principalId =
        profile.roleBindings?.[role as "hr" | "it" | "manager"];
      const candidates = (this.principals?.(p.tenantId) ?? []).filter(
        (account) =>
          account.tenantId === p.tenantId && account.id === principalId,
      );
      const scope = role === "hr" ? "people" : role === "it" ? "it" : "cases";
      const available =
        candidates.length === 1 &&
        candidates[0]!.roles.includes("operator") &&
        !!(
          candidates[0]!.scopes?.includes("*") ||
          candidates[0]!.scopes?.includes(scope)
        );
      const data: JsonObject = {
        role,
        configured: !!principalId,
        available,
        approved: true,
      };
      return {
        reference: r,
        label: `Odpowiedzialność: ${role}`,
        data,
        cloud: { ...data },
        version: profile.version,
        updatedAt: profile.updatedAt,
        classification: "company_operational",
      };
    }
    if (r.kind === "company") {
      const profile = this.profile(p.tenantId);
      const approved = profile.version > 0 && !!profile.updatedApprovedBy;
      const data: JsonObject = {
        timezone: label(profile.timezone, 100),
        approved,
        definitionVersion: label(profile.definitionVersion, 20),
        responsibilities: {
          hr: !!profile.roleBindings?.hr,
          it: !!profile.roleBindings?.it,
          manager: !!profile.roleBindings?.manager,
        },
      };
      if (profile.employmentPolicy)
        data.employmentPolicy = {
          mode: enumValue(profile.employmentPolicy.mode, [
            "single_open",
            "parallel_projects",
          ]),
          maxConcurrent: integer(profile.employmentPolicy.maxConcurrent),
          allowInternalOverlap:
            profile.employmentPolicy.allowInternalOverlap === true,
        };
      // Validate structural strings before cloud egress rather than copying config text.
      let timezone: string | null = null;
      try {
        timezone = new Intl.DateTimeFormat("en", {
          timeZone: profile.timezone,
        }).resolvedOptions().timeZone;
      } catch {
        /* invalid config is unavailable to model */
      }
      const cloud: JsonObject = {
        ...data,
        timezone,
        definitionVersion: /^\d{1,5}$/.test(profile.definitionVersion)
          ? profile.definitionVersion
          : null,
      };
      return {
        reference: r,
        label: "Konfiguracja firmy",
        data,
        cloud,
        version: profile.version,
        updatedAt: profile.updatedAt,
        classification: "company_operational",
      };
    }
    if (r.kind === "task") {
      const task = this.tasks(p).find(
        (t) => t.id === r.id && t.assigneePrincipalId === p.id,
      );
      if (!task)
        fail(
          "CONTEXT_SOURCE_FORBIDDEN",
          "Brak aktualnego dostępu do źródła.",
          403,
        );
      const data: JsonObject = {
        status: enumValue(task.status, operationalStatuses),
        kind: enumValue(task.kind, [
          "information",
          "decision",
          "work",
          "attestation",
        ]),
        dueDate: safeDate(task.dueDate),
        required: task.required,
        scopeRevision: task.scopeRevision,
        overdue: task.overdue,
        blockedDependencies: task.dependsOn.filter((d) => !d.completed).length,
      };
      return {
        reference: r,
        label: label(task.title),
        data,
        cloud: { ...data },
        version: task.version,
        updatedAt: task.updatedAt,
        classification: "task_operational",
      };
    }
    if (r.kind === "episode") {
      if (!r.parentId)
        fail(
          "CONTEXT_REFERENCE_INVALID",
          "Brak powiązania okresu współpracy.",
          400,
        );
      const person = this.workspace.get(p, "people", r.parentId);
      const episode = this.episodes(p, person).find((e) => e.id === r.id);
      if (!episode)
        fail(
          "CONTEXT_SOURCE_UNAVAILABLE",
          "Okres współpracy jest niedostępny.",
          404,
        );
      const data: JsonObject = {
        kind: enumValue(episode.kind, ["internal", "contractor"]),
        status: enumValue(episode.status, operationalStatuses),
        startDate: safeDate(episode.startDate),
        endDate: safeDate(episode.endDate),
        role: label(episode.role),
        hasEngagement: !!episode.engagementRef,
      };
      if (episode.engagementRef) {
        try {
          data.engagementLabel = label(
            this.workspace.get(
              p,
              episode.engagementRef.module,
              episode.engagementRef.id,
            ).title,
          );
        } catch {
          data.engagementLabel = "Brak dostępu do przedsięwzięcia";
        }
      }
      const { role: _role, engagementLabel: _engagement, ...cloud } = data;
      return {
        reference: r,
        label: `${episode.kind === "contractor" ? "Współpraca kontraktorska" : "Zatrudnienie"}: ${safeDate(episode.startDate) ?? "brak daty"}`,
        data,
        cloud,
        version: episode.version ?? person.version,
        updatedAt: person.updatedAt,
        classification: "person_operational",
      };
    }
    const e = this.workspace.get(p, r.module, r.id);
    const status = enumValue(e.status, operationalStatuses);
    let data: JsonObject, cloud: JsonObject;
    if (r.kind === "person") {
      data = {
        status,
        personCategory: enumValue(e.data.personCategory, [
          "internal",
          "contractor",
        ]),
        department: label(e.data.department),
        jobTitle: label(e.data.jobTitle),
      };
      cloud = { status, personCategory: data.personCategory! };
    } else if (r.kind === "asset") {
      data = {
        status,
        assetType: enumValue(e.data.assetType, [
          "laptop",
          "phone",
          "monitor",
          "other",
        ]),
        condition: enumValue(e.data.condition, ["good", "repair"]),
        location: label(e.data.location),
        availability:
          e.status === "available" ? "available_now" : "not_available",
        requestedReadyOn: safeDate(r.requestedReadyOn),
      };
      const { location: _location, ...safe } = data;
      cloud = safe;
    } else if (r.kind === "case") {
      const readiness = this.workspace.readiness(p, e.id);
      data = {
        status,
        caseType: enumValue(e.data.caseType, [
          "general",
          "onboarding",
          "offboarding",
          "procurement",
          "delivery",
          "it",
        ]),
        dueDate: safeDate(e.data.dueDate),
        scopeRevision: integer(e.data.scopeRevision),
        ready: readiness.ready,
        acceptanceCurrent: readiness.acceptanceCurrent,
        requirements: readiness.requirements.slice(0, 5).map((item) => ({
          kind: item.kind,
          status: item.status,
          required: item.required,
        })),
        missingRequirementCount: readiness.requirements.filter(
          (item) => item.required && item.status !== "satisfied",
        ).length,
        taskBlockerCount: readiness.taskBlockers.length,
      };
      cloud = { ...data };
    } else if (r.kind === "document") {
      data = {
        status,
        documentType: enumValue(e.data.documentType, [
          "policy",
          "contract",
          "offer",
          "report",
          "other",
        ]),
        revision: integer(e.data.revision),
        sourceCount: rows(e.data.sources).length,
      };
      cloud = { ...data };
    } else if (r.kind === "application" && e.module === "licenses") {
      data = {
        status,
        totalSeats: integer(e.data.totalSeats),
        assignedSeats: integer(e.data.assignedSeats),
        expiresOn: safeDate(e.data.expiresOn),
        externalAccessConfirmed: false,
      };
      cloud = { ...data };
    } else
      fail(
        "CONTEXT_PROJECTION_FORBIDDEN",
        "Nieobsługiwana projekcja źródła.",
        403,
      );
    return {
      reference: r,
      label: label(e.title),
      data,
      cloud,
      version: e.version,
      updatedAt: e.updatedAt,
      classification:
        r.kind === "person"
          ? "person_operational"
          : r.kind === "document"
            ? "document_metadata"
            : "company_operational",
    };
  }
  private episodes(p: Principal, person: Entity): Episode[] {
    const store = this.workspace as WorkspaceStore & {
      listEmploymentEpisodes?: (p: Principal, id: string) => Episode[];
    };
    return store.listEmploymentEpisodes
      ? store.listEmploymentEpisodes(p, person.id)
      : (rows(person.data.employmentEpisodes) as unknown as Episode[]);
  }
  private source(projection: Projection): ContextSource {
    return {
      module: projection.reference.module,
      id: projection.reference.id,
      version: projection.version,
      updatedAt: projection.updatedAt,
      observedAt: this.now(),
      classification: projection.classification,
      projectionVersion: "1",
      projectionHash: hash({
        kind: projection.reference.kind,
        label: projection.label,
        data: projection.data,
      }),
    };
  }
  private token(
    turn: ContextTurn,
    kind: string,
    binding: unknown,
    version: number,
    sourceHash: string,
  ): string {
    const ref = nonce();
    this.db
      .prepare("INSERT INTO context_tokens VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        hash(ref),
        turn.principal.tenantId,
        turn.principal.id,
        turn.conversationId,
        authority(turn.principal),
        kind,
        canonical(binding),
        version,
        sourceHash,
        this.now(),
        this.clock() + this.ttl,
      );
    return ref;
  }
  private tokenRow(turn: ContextTurn, ref: string, kind?: string): Row {
    if (!opaque.safeParse(ref).success)
      fail(
        "CONTEXT_REFERENCE_INVALID",
        "Niepoprawne odwołanie do kontekstu.",
        400,
      );
    const row = this.db
      .prepare(
        "SELECT * FROM context_tokens WHERE token_hash=? AND tenant_id=? AND actor_id=? AND conversation_id=? AND authority_hash=?",
      )
      .get(
        hash(ref),
        turn.principal.tenantId,
        turn.principal.id,
        turn.conversationId,
        authority(turn.principal),
      );
    if (!row || (kind && row.kind !== kind))
      fail(
        "CONTEXT_REFERENCE_FORBIDDEN",
        "Odwołanie nie należy do tego kontekstu.",
        403,
      );
    if (Number(row.expires_at) <= this.clock())
      fail(
        "CONTEXT_REFERENCE_EXPIRED",
        "Odwołanie wygasło. Odczytaj aktualne źródło.",
      );
    return row;
  }
  private resolveProjection(
    turn: ContextTurn,
    ref: string,
    expectedKind?: ContextKind,
  ): Projection {
    const p = this.guard(turn),
      row = this.tokenRow(turn, ref, "record");
    const reference = JSON.parse(String(row.binding_json)) as Reference;
    if (expectedKind && reference.kind !== expectedKind)
      fail("CONTEXT_REFERENCE_KIND", "Odwołanie ma inny rodzaj źródła.", 400);
    const projected = this.projection(p, reference),
      source = this.source(projected);
    if (
      projected.version !== row.source_version ||
      source.projectionHash !== row.source_hash
    )
      fail(
        "CONTEXT_SOURCE_STALE",
        "Źródło zmieniło się. Odczytaj je ponownie przed planem.",
      );
    return projected;
  }
  resolve(
    turn: ContextTurn,
    ref: string,
    expectedKind?: ContextKind,
  ): ResolvedReference {
    const projection = this.resolveProjection(turn, ref, expectedKind),
      r = projection.reference;
    return {
      kind: r.kind,
      purpose: r.purpose,
      module: r.module,
      id: r.id,
      version: projection.version,
      ...(r.kind === "person" ? { personId: r.id } : {}),
      ...(r.kind === "episode"
        ? { personId: r.parentId!, employmentEpisodeId: r.id }
        : {}),
      ...(r.kind === "case" ? { caseId: r.id } : {}),
      source: this.source(projection),
    };
  }
  private record(
    turn: ContextTurn,
    projection: Projection,
  ): { local: ContextRecord; cloud: CloudContextRecord } {
    const source = this.source(projection),
      r = projection.reference;
    const ref = this.token(
      turn,
      "record",
      r,
      projection.version,
      source.projectionHash,
    );
    const alias = `${r.kind.toUpperCase()}_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare("INSERT OR IGNORE INTO context_aliases VALUES(?,?,?,?,?,?)")
      .run(
        turn.principal.tenantId,
        turn.principal.id,
        turn.conversationId,
        r.kind,
        r.id,
        alias,
      );
    const stored = this.db
      .prepare(
        "SELECT alias FROM context_aliases WHERE tenant_id=? AND actor_id=? AND conversation_id=? AND kind=? AND source_id=?",
      )
      .get(
        turn.principal.tenantId,
        turn.principal.id,
        turn.conversationId,
        r.kind,
        r.id,
      )!;
    const { id: _sourceId, ...cloudSource } = source;
    // A hash of private names is itself a guessable side channel. The cloud
    // receipt therefore hashes only the projection actually sent to the model.
    cloudSource.projectionHash = hash({ kind: r.kind, data: projection.cloud });
    return {
      local: {
        ref,
        kind: r.kind,
        label: projection.label,
        data: projection.data,
        source,
        freshness: "current",
      },
      cloud: {
        ref,
        kind: r.kind,
        label: String(stored.alias),
        data: projection.cloud,
        source: cloudSource,
        freshness: "current",
      },
    };
  }
  private result(
    turn: ContextTurn,
    projections: Projection[],
    nextCursor?: string,
  ): Omit<BrokerResult, "budget"> {
    const records = projections.map((item) => this.record(turn, item));
    return {
      items: records.map((r) => r.local),
      ...(nextCursor ? { nextCursor } : {}),
      cloud: {
        items: records.map((r) => r.cloud),
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
  }
  private page(
    turn: ContextTurn,
    projections: Projection[],
    query: JsonObject,
    limit: number,
    cursor?: string,
  ): Omit<BrokerResult, "budget"> {
    const queryHash = hash(query);
    const collectionHash = hash(
      projections.map((item) => ({
        reference: item.reference,
        version: item.version,
        projectionHash: this.source(item).projectionHash,
      })),
    );
    let offset = 0;
    if (cursor) {
      const row = this.tokenRow(turn, cursor, "cursor"),
        binding = JSON.parse(String(row.binding_json)) as {
          queryHash: string;
          offset: number;
        };
      if (binding.queryHash !== queryHash)
        fail(
          "CONTEXT_CURSOR_MISMATCH",
          "Kursor dotyczy innego wyszukania.",
          400,
        );
      if (row.source_hash !== collectionHash)
        fail(
          "CONTEXT_SOURCE_STALE",
          "Wyniki zmieniły się. Rozpocznij nowe wyszukanie.",
        );
      offset = binding.offset;
    }
    const page = projections.slice(offset, offset + limit);
    const nextCursor =
      offset + page.length < projections.length
        ? this.token(
            turn,
            "cursor",
            { queryHash, offset: offset + page.length },
            1,
            collectionHash,
          )
        : undefined;
    return this.result(turn, page, nextCursor);
  }
  private dispatch(
    turn: ContextTurn,
    p: Principal,
    tool: ContextToolName,
    input: JsonObject,
  ): Omit<BrokerResult, "budget"> {
    const selectedPurpose = (input.purpose ??
      "equipment_request") as ContextPurpose;
    if (tool === "context.company")
      return this.result(turn, [
        this.projection(p, {
          kind: "company",
          module: "company",
          id: p.tenantId,
          purpose: selectedPurpose,
        }),
      ]);
    if (tool === "context.findPeople") {
      const query = fold(String(input.query)),
        words = query.split(/\s+/).filter(Boolean);
      // Aliases generate candidates only. Selection/identity remains an explicit caller decision.
      const forms = (word: string) =>
        ["anna", "ania", "ani"].includes(word) ? ["anna", "ania"] : [word];
      const people = this.list(p, "people")
        .filter((e) =>
          words.every((word) =>
            forms(word).some((form) =>
              fold(e.title)
                .split(/\s+/)
                .some((name) => name.startsWith(form)),
            ),
          ),
        )
        .sort(
          (a, b) =>
            a.title.localeCompare(b.title, "pl") || a.id.localeCompare(b.id),
        );
      const queryHash = hash({ query, limit: input.limit }),
        collectionHash = hash(
          people.map((e) => ({ id: e.id, version: e.version, title: e.title })),
        );
      let offset = 0;
      if (input.cursor) {
        const row = this.tokenRow(turn, String(input.cursor), "cursor"),
          cursor = JSON.parse(String(row.binding_json)) as {
            queryHash: string;
            offset: number;
          };
        if (cursor.queryHash !== queryHash)
          fail(
            "CONTEXT_CURSOR_MISMATCH",
            "Kursor dotyczy innego wyszukania.",
            400,
          );
        if (row.source_hash !== collectionHash)
          fail(
            "CONTEXT_SOURCE_STALE",
            "Wyniki zmieniły się. Rozpocznij nowe wyszukanie.",
          );
        offset = cursor.offset;
      }
      const page = people.slice(offset, offset + Number(input.limit));
      const nextCursor =
        offset + page.length < people.length
          ? this.token(
              turn,
              "cursor",
              { queryHash, offset: offset + page.length },
              1,
              collectionHash,
            )
          : undefined;
      return this.result(
        turn,
        page.map((e) =>
          this.projection(p, {
            kind: "person",
            module: "people",
            id: e.id,
            purpose: "equipment_request",
          }),
        ),
        nextCursor,
      );
    }
    if (tool === "context.personWork") {
      const person = this.resolve(turn, String(input.personRef), "person");
      const entity = this.workspace.get(p, "people", person.id);
      const episodes = this.episodes(p, entity).sort(
        (a, b) =>
          a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id),
      );
      return this.page(
        turn,
        episodes.map((e) =>
          this.projection(p, {
            kind: "episode",
            module: "people",
            id: e.id,
            parentId: person.id,
            purpose: selectedPurpose,
          }),
        ),
        { tool, personId: person.id, purpose: selectedPurpose },
        5,
        input.cursor ? String(input.cursor) : undefined,
      );
    }
    if (tool === "context.findCases") {
      const person = input.personRef
        ? this.resolve(turn, String(input.personRef), "person")
        : undefined;
      const episode = input.episodeRef
        ? this.resolve(turn, String(input.episodeRef), "episode")
        : undefined;
      if (person && episode && person.id !== episode.personId)
        fail(
          "CONTEXT_RELATION_MISMATCH",
          "Osoba i współpraca nie są powiązane.",
        );
      const cases = this.list(p, "cases").filter(
        (e) =>
          (!person || e.data.personId === person.id) &&
          (!episode || e.data.employmentEpisodeId === episode.id) &&
          (input.state === "any" || openCases.has(e.status)),
      );
      const caseIds = new Set(cases.map((e) => e.id));
      const taskCandidates =
        person || episode
          ? []
          : this.tasks(p).filter(
              (t) =>
                t.assigneePrincipalId === p.id &&
                !caseIds.has(t.caseId) &&
                (input.state === "any" ||
                  !["completed", "cancelled"].includes(t.status)),
            );
      const refs: Reference[] = [
        ...cases.map((e) => ({
          kind: "case" as const,
          module: "cases",
          id: e.id,
          purpose: "case_followup" as const,
        })),
        ...taskCandidates.map((t) => ({
          kind: "task" as const,
          module: "tasks",
          id: t.id,
          purpose: "case_followup" as const,
        })),
      ];
      refs.sort(
        (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
      );
      return this.page(
        turn,
        refs.map((r) => this.projection(p, r)),
        {
          tool,
          personId: person?.id ?? null,
          episodeId: episode?.id ?? null,
          state: input.state!,
          limit: input.limit!,
        },
        Number(input.limit),
        input.cursor ? String(input.cursor) : undefined,
      );
    }
    if (tool === "context.availableAssets") {
      const episode = this.resolve(turn, String(input.episodeRef), "episode");
      const active = this.resolveProjection(
        turn,
        String(input.episodeRef),
        "episode",
      );
      if (!["onboarding", "active"].includes(String(active.data.status)))
        fail(
          "CONTEXT_EPISODE_INACTIVE",
          "Współpraca nie przyjmuje nowego wyposażenia.",
        );
      if (!episode.personId)
        fail("CONTEXT_RELATION_MISMATCH", "Brak osoby wskazanego okresu.");
      const assets = this.list(p, "assets").filter(
        (e) => e.status === "available" && e.data.assetType === input.assetType,
      );
      return this.result(
        turn,
        assets.slice(0, Number(input.limit)).map((e) => {
          const projection = this.projection(p, {
            kind: "asset",
            module: "assets",
            id: e.id,
            purpose: "equipment_request",
            requestedReadyOn: String(input.readyOn),
          });
          // `readyOn` is a requested date, never a promise of a future reservation.
          // source.observedAt dates the independently rechecked available_now fact.
          return projection;
        }),
      );
    }
    const projection = this.resolveProjection(turn, String(input.ref));
    if (projection.reference.purpose !== selectedPurpose)
      fail("CONTEXT_PURPOSE_MISMATCH", "Źródło odczytano do innego celu.", 403);
    return this.result(turn, [projection]);
  }
}
