import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type Principal,
  type ToolContext,
  type ToolAccessContext,
  type JsonObject,
} from "./contracts.js";
import {
  type RoleBindings,
  type TaskKind,
  type TaskRole,
  type TaskStatus,
} from "./workspace-models.js";

/** Called by operations migration v3, inside its transaction after renaming the legacy table. */
export const taskTablesSql = `
CREATE TABLE ops_tasks(
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,
 title TEXT NOT NULL,assignee_id TEXT,required INTEGER NOT NULL CHECK(required IN(0,1)),
 status TEXT NOT NULL CHECK(status IN('unassigned','offered','accepted','declined','completed','cancelled')),
 completed_by TEXT,completed_at TEXT,evidence_note TEXT,due_date TEXT,depends_on_json TEXT NOT NULL DEFAULT '[]',
 kind TEXT NOT NULL DEFAULT 'work' CHECK(kind IN('information','decision','work','attestation')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),assignee_principal_id TEXT,assignee_role TEXT,
 required_scopes_json TEXT NOT NULL DEFAULT '[]',requirement_keys_json TEXT NOT NULL DEFAULT '[]',
 performed_by TEXT,requested_by TEXT,approved_by TEXT,created_at TEXT,updated_at TEXT,
 provenance TEXT NOT NULL DEFAULT 'p03',
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE INDEX ops_tasks_assignee ON ops_tasks(tenant_id,assignee_principal_id,status);
CREATE TABLE ops_task_events(
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,
 task_version INTEGER NOT NULL,action TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,
 previous_assignee_principal_id TEXT,assignee_principal_id TEXT,requested_by TEXT,approved_by TEXT,performed_by TEXT,
 reason TEXT,run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,task_id,task_version),
 FOREIGN KEY(tenant_id,task_id) REFERENCES ops_tasks(tenant_id,id));
`;

export interface TaskRecord {
  id: string;
  caseId: string;
  scopeRevision: number;
  title: string;
  assigneeId: string | null;
  required: boolean;
  status: TaskStatus;
  completedBy: string | null;
  completedAt: string | null;
  evidenceNote: string | null;
  dueDate: string | null;
  dependsOn: string[];
  kind: TaskKind;
  version: number;
  assigneePrincipalId: string | null;
  assigneeRole: TaskRole | null;
  requiredScopes: string[];
  requirementKeys: string[];
  performedBy: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  provenance: string;
}
export interface TaskContext {
  ctx: ToolContext;
  now: string;
  caseId: string;
  scopeRevision: number;
  /** Computed by WorkspaceStore using current full-case ACL, never from command input. */
  canManage?: boolean;
  ownerPrincipalId?: string;
}
export interface NewTask {
  id?: string;
  title: string;
  required: boolean;
  kind: TaskKind;
  assigneeId?: string;
  assigneePrincipalId?: string;
  assigneeRole?: TaskRole;
  dueDate?: string;
  dependsOn?: string[];
  requiredScopes: string[];
  requirementKeys?: string[];
  /** Lifecycle templates may remain unassigned when a configured account is unavailable. */
  allowUnassigned?: boolean;
}
export type TaskAction =
  "acceptTask" | "declineTask" | "transferTask" | "completeTask" | "cancelTask";
export interface TaskTransition {
  taskId: string;
  expectedTaskVersion: number;
  humanConfirmed: true;
  assigneePrincipalId?: string;
  reason?: string;
  evidenceNote?: string;
}
export interface TaskEvent {
  taskVersion: number;
  action: string;
  fromStatus: string | null;
  toStatus: string;
  assigneePrincipalId: string | null;
  previousAssigneePrincipalId: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  performedBy: string | null;
  reason: string | null;
  createdAt: string;
  runId: string;
  stepId: string;
  operationKey: string;
}
export interface TaskProjection extends Omit<
  TaskRecord,
  | "assigneeId"
  | "requiredScopes"
  | "requirementKeys"
  | "dependsOn"
  | "completedBy"
> {
  caseVersion: number;
  overdue: boolean;
  dependsOn: { id: string; completed: boolean }[];
  allowedActions: TaskAction[];
  events: TaskEvent[];
}
export type PrincipalProvider = (tenantId: string) => Principal[];
type Row = Record<string, unknown>;
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const nullable = (value: unknown) => (value == null ? null : String(value));
const scopesAllow = (p: Principal, scopes: string[]) =>
  scopes.every((scope) => p.scopes?.includes("*") || p.scopes?.includes(scope));
export const roleScopes: Record<TaskRole, string[]> = {
  hr: ["people"],
  it: ["it"],
  manager: ["cases"],
};

/** Domain task adapter. It deliberately owns no transaction or operation ledger;
 * WorkspaceStore includes each change in the same durable command transaction. */
export class WorkspaceTasks {
  constructor(
    private readonly db: DatabaseSync,
    private provider?: PrincipalProvider,
    private readonly canManageCase?: (
      principal: Principal,
      caseId: string,
    ) => boolean,
  ) {}
  setPrincipalProvider(provider: PrincipalProvider) {
    this.provider = provider;
  }
  private account(
    tenantId: string,
    id: string | undefined,
  ): Principal | undefined {
    if (!id) return undefined;
    const matches = (this.provider?.(tenantId) ?? []).filter(
      (p) => p.tenantId === tenantId && p.id === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  private actor(context: TaskContext, requiredScopes: string[]): Principal {
    context.ctx.signal.throwIfAborted();
    const p = this.account(context.ctx.tenantId, context.ctx.actorId);
    if (!p || !p.roles.includes("operator") || !scopesAllow(p, requiredScopes))
      return fail(
        "TASK_ACTOR_FORBIDDEN",
        "Konto wykonawcy jest nieaktywne lub nie ma wymaganych uprawnień.",
        403,
      );
    return p;
  }
  resolveRole(
    tenantId: string,
    bindings: RoleBindings,
    role: TaskRole,
  ): string | undefined {
    const p = this.account(tenantId, bindings[role]);
    return p?.roles.includes("operator") && scopesAllow(p, roleScopes[role])
      ? p.id
      : undefined;
  }
  private decode(row: Row): TaskRecord {
    return {
      id: String(row.id),
      caseId: String(row.case_id),
      scopeRevision: Number(row.scope_revision),
      title: String(row.title),
      assigneeId: nullable(row.assignee_id),
      required: row.required === 1,
      status: row.status as TaskStatus,
      completedBy: nullable(row.completed_by),
      completedAt: nullable(row.completed_at),
      evidenceNote: nullable(row.evidence_note),
      dueDate: nullable(row.due_date),
      dependsOn: JSON.parse(String(row.depends_on_json)),
      kind: row.kind as TaskKind,
      version: Number(row.version),
      assigneePrincipalId: nullable(row.assignee_principal_id),
      assigneeRole: nullable(row.assignee_role) as TaskRole | null,
      requiredScopes: JSON.parse(String(row.required_scopes_json)),
      requirementKeys: JSON.parse(String(row.requirement_keys_json)),
      performedBy: nullable(row.performed_by),
      requestedBy: nullable(row.requested_by),
      approvedBy: nullable(row.approved_by),
      createdAt: nullable(row.created_at),
      updatedAt: nullable(row.updated_at),
      provenance: String(row.provenance),
    };
  }
  get(tenantId: string, taskId: string): TaskRecord {
    const row = this.db
      .prepare("SELECT * FROM ops_tasks WHERE tenant_id=? AND id=?")
      .get(tenantId, taskId);
    return row
      ? this.decode(row)
      : fail("TASK_NOT_FOUND", "Nie znaleziono zadania.", 404);
  }
  rows(tenantId: string, caseId: string, revision: number): TaskRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM ops_tasks WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY rowid",
      )
      .all(tenantId, caseId, revision)
      .map((row) => this.decode(row));
  }
  private dependencies(
    tenantId: string,
    task: Pick<TaskRecord, "id" | "caseId" | "scopeRevision" | "dependsOn">,
  ) {
    if (
      new Set(task.dependsOn).size !== task.dependsOn.length ||
      task.dependsOn.includes(task.id)
    )
      fail(
        "INVALID_TASK_DEPENDENCIES",
        "Zależności muszą być unikalne i nie mogą wskazywać tego zadania.",
      );
    return task.dependsOn.map((id) => {
      const dep = this.get(tenantId, id);
      if (
        dep.caseId !== task.caseId ||
        dep.scopeRevision !== task.scopeRevision
      )
        fail(
          "INVALID_TASK_DEPENDENCIES",
          "Zależność musi należeć do tej samej sprawy i rewizji.",
        );
      return dep;
    });
  }
  insert(context: TaskContext, input: NewTask): TaskRecord {
    context.ctx.signal.throwIfAborted();
    const taskId = input.id ?? randomUUID();
    const deps = input.dependsOn ?? [];
    this.dependencies(context.ctx.tenantId, {
      id: taskId,
      caseId: context.caseId,
      scopeRevision: context.scopeRevision,
      dependsOn: deps,
    });
    let assignee = this.account(
      context.ctx.tenantId,
      input.assigneePrincipalId,
    );
    if (
      assignee &&
      (!assignee.roles.includes("operator") ||
        !scopesAllow(assignee, input.requiredScopes))
    )
      assignee = undefined;
    if (input.assigneePrincipalId && !assignee && !input.allowUnassigned)
      fail(
        "TASK_ASSIGNEE_FORBIDDEN",
        "Wykonawca musi być aktywnym kontem z uprawnieniami zadania.",
        403,
      );
    this.db
      .prepare(
        `INSERT INTO ops_tasks(tenant_id,id,case_id,scope_revision,title,assignee_id,required,status,
    due_date,depends_on_json,kind,version,assignee_principal_id,assignee_role,required_scopes_json,requirement_keys_json,
    requested_by,approved_by,created_at,updated_at,provenance) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        context.ctx.tenantId,
        taskId,
        context.caseId,
        context.scopeRevision,
        input.title,
        input.assigneeId ?? null,
        input.required ? 1 : 0,
        assignee ? "offered" : "unassigned",
        input.dueDate ?? null,
        JSON.stringify(deps),
        input.kind,
        1,
        assignee?.id ?? null,
        input.assigneeRole ?? null,
        JSON.stringify(input.requiredScopes),
        JSON.stringify(input.requirementKeys ?? []),
        context.ctx.actorId ?? null,
        context.ctx.approvedBy ?? null,
        context.now,
        context.now,
        "p03",
      );
    const task = this.get(context.ctx.tenantId, taskId);
    this.event(context, task, "created", null, null, null);
    return task;
  }
  transition(
    context: TaskContext,
    action: TaskAction,
    input: TaskTransition,
  ): TaskRecord {
    if (input.humanConfirmed !== true)
      fail("HUMAN_REQUIRED", "Wymagane jawne działanie człowieka.", 400);
    const task = this.get(context.ctx.tenantId, input.taskId);
    if (
      task.caseId !== context.caseId ||
      task.scopeRevision !== context.scopeRevision
    )
      fail(
        "TASK_REVISION_CONFLICT",
        "Zadanie nie należy do bieżącej rewizji sprawy.",
      );
    if (task.version !== input.expectedTaskVersion)
      fail(
        "TASK_VERSION_CONFLICT",
        "Zadanie zmieniło się; odczytaj aktualną wersję.",
      );
    // A manager may reassign a revoked worker without inheriting that worker's domain permissions.
    const managerAction =
      (action === "transferTask" || action === "cancelTask") &&
      context.canManage === true;
    const actor = this.actor(context, managerAction ? [] : task.requiredScopes);
    const assigned = task.assigneePrincipalId === actor.id;
    if (!assigned && !managerAction)
      fail(
        "TASK_ASSIGNEE_ONLY",
        "To działanie może wykonać tylko przypisane konto.",
        403,
      );
    if (["completed", "cancelled"].includes(task.status))
      fail("TASK_TERMINAL", "Zakończone zadanie jest niezmienne.");
    let status = task.status;
    let assignee = task.assigneePrincipalId;
    let reason: string | null = null;
    if (action === "acceptTask") {
      if (task.status !== "offered")
        fail(
          "TASK_NOT_OFFERED",
          "Przyjąć można zadanie oczekujące na przyjęcie.",
        );
      status = "accepted";
    } else if (action === "declineTask") {
      if (!["offered", "accepted"].includes(task.status))
        fail("TASK_NOT_OFFERED", "Tego zadania nie można odmówić.");
      if (!input.reason?.trim())
        fail("REASON_REQUIRED", "Podaj powód odmowy.", 400);
      status = "declined";
      reason = input.reason;
    } else if (action === "transferTask") {
      if (!input.reason?.trim())
        fail("REASON_REQUIRED", "Podaj powód przekazania.", 400);
      const next = this.account(
        context.ctx.tenantId,
        input.assigneePrincipalId,
      );
      if (
        !next?.roles.includes("operator") ||
        !scopesAllow(next, task.requiredScopes)
      )
        fail(
          "TASK_ASSIGNEE_FORBIDDEN",
          "Nowy wykonawca nie ma aktywnego konta i uprawnień zadania.",
          403,
        );
      if (next.id === task.assigneePrincipalId && task.status !== "declined")
        fail("TASK_SAME_ASSIGNEE", "Wybierz inne konto wykonawcy.");
      status = "offered";
      assignee = next.id;
      reason = input.reason;
    } else if (action === "cancelTask") {
      if (!context.canManage)
        fail(
          "TASK_MANAGER_REQUIRED",
          "Anulowanie wymaga uprawnień do zarządzania sprawą.",
          403,
        );
      if (!input.reason?.trim())
        fail("REASON_REQUIRED", "Podaj powód anulowania.", 400);
      status = "cancelled";
      reason = input.reason;
    } else {
      if (task.status !== "accepted")
        fail("TASK_NOT_ACCEPTED", "Najpierw przyjmij zadanie.");
      if (!input.evidenceNote?.trim())
        fail("EVIDENCE_REQUIRED", "Opisz wykonanie zadania.", 400);
      if (
        this.dependencies(context.ctx.tenantId, task).some(
          (dep) => dep.status !== "completed",
        )
      )
        fail(
          "TASK_DEPENDENCIES_OPEN",
          "Najpierw ukończ zadania poprzedzające.",
        );
      status = "completed";
      reason = input.evidenceNote;
    }
    const result = this.db
      .prepare(
        `UPDATE ops_tasks SET status=?,assignee_principal_id=?,version=version+1,
    requested_by=?,approved_by=?,updated_at=?,performed_by=?,completed_by=?,completed_at=?,evidence_note=?
    WHERE tenant_id=? AND id=? AND version=?`,
      )
      .run(
        status,
        assignee,
        actor.id,
        context.ctx.approvedBy ?? null,
        context.now,
        status === "completed" ? actor.id : null,
        status === "completed" ? actor.id : null,
        status === "completed" ? context.now : null,
        status === "completed" ? input.evidenceNote! : null,
        context.ctx.tenantId,
        task.id,
        task.version,
      );
    if (Number(result.changes) !== 1)
      fail("TASK_VERSION_CONFLICT", "Zadanie zmieniło się.");
    const next = this.get(context.ctx.tenantId, task.id);
    this.event(
      context,
      next,
      action,
      task.status,
      task.assigneePrincipalId,
      reason,
    );
    return next;
  }
  private event(
    context: TaskContext,
    task: TaskRecord,
    action: string,
    fromStatus: TaskStatus | null,
    previousAssignee: string | null,
    reason: string | null,
  ) {
    this.db
      .prepare(
        "INSERT INTO ops_task_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        context.ctx.tenantId,
        randomUUID(),
        task.id,
        task.caseId,
        task.scopeRevision,
        task.version,
        action,
        fromStatus,
        task.status,
        previousAssignee,
        task.assigneePrincipalId,
        context.ctx.actorId ?? null,
        context.ctx.approvedBy ?? null,
        action === "completeTask" ? (context.ctx.actorId ?? null) : null,
        reason,
        context.ctx.runId,
        context.ctx.stepId,
        context.ctx.operationKey,
        context.now,
      );
  }
  history(tenantId: string, taskId: string): TaskEvent[] {
    return this.db
      .prepare(
        "SELECT * FROM ops_task_events WHERE tenant_id=? AND task_id=? ORDER BY task_version",
      )
      .all(tenantId, taskId)
      .map((row) => ({
        taskVersion: Number(row.task_version),
        action: String(row.action),
        fromStatus: nullable(row.from_status),
        toStatus: String(row.to_status),
        assigneePrincipalId: nullable(row.assignee_principal_id),
        previousAssigneePrincipalId: nullable(
          row.previous_assignee_principal_id,
        ),
        requestedBy: nullable(row.requested_by),
        approvedBy: nullable(row.approved_by),
        performedBy: nullable(row.performed_by),
        reason: nullable(row.reason),
        createdAt: String(row.created_at),
        runId: String(row.run_id),
        stepId: String(row.step_id),
        operationKey: String(row.operation_key),
      }));
  }
  /** Recovery authorization is bound to the already persisted action, not to an
   * assignment that that action itself may have changed. The caller still checks
   * the command ledger's exact input hash and trusted Core approval. */
  verifyCommitted(ctx: ToolContext, taskId: string): boolean {
    ctx.signal.throwIfAborted();
    const task = this.get(ctx.tenantId, taskId),
      actor = this.account(ctx.tenantId, ctx.actorId);
    if (!actor?.roles.includes("operator")) return false;
    const event = this.history(ctx.tenantId, taskId).find(
      (event) =>
        event.operationKey === ctx.operationKey &&
        event.requestedBy === ctx.actorId &&
        event.runId === ctx.runId &&
        event.stepId === ctx.stepId,
    );
    if (!event) return false;
    if (event.approvedBy !== (ctx.approvedBy ?? null)) return false;
    return (
      scopesAllow(actor, task.requiredScopes) ||
      (["transferTask", "cancelTask"].includes(event.action) &&
        this.manages(actor, task.caseId))
    );
  }
  private activeViewer(principal: Principal): Principal {
    const live = this.account(principal.tenantId, principal.id);
    if (
      !live ||
      !live.roles.includes("operator") ||
      !principal.roles.includes("operator")
    )
      return fail(
        "TASK_VIEW_FORBIDDEN",
        "Brak aktywnego konta wykonawcy.",
        403,
      );
    // Intersect token authority with current account authority; a stale caller cannot gain new scopes.
    return {
      ...live,
      scopes: live.scopes?.includes("*")
        ? principal.scopes
        : principal.scopes?.includes("*")
          ? live.scopes
          : (live.scopes ?? []).filter((scope) =>
              principal.scopes?.includes(scope),
            ),
    };
  }
  private manages(principal: Principal, caseId: string): boolean {
    try {
      return this.canManageCase?.(principal, caseId) === true;
    } catch {
      return false;
    }
  }
  canAccess(
    principal: Principal,
    input: JsonObject,
    context: ToolAccessContext | undefined,
    action: TaskAction,
  ): boolean {
    const account = this.account(principal.tenantId, principal.id);
    if (!account) return false;
    const live: Principal = {
      ...account,
      roles: account.roles.filter((role) => principal.roles.includes(role)),
      scopes: account.scopes?.includes("*")
        ? principal.scopes
        : principal.scopes?.includes("*")
          ? account.scopes
          : (account.scopes ?? []).filter((scope) =>
              principal.scopes?.includes(scope),
            ),
    };
    let task: TaskRecord;
    try {
      task = this.get(principal.tenantId, String(input.taskId));
    } catch {
      return false;
    }
    if (task.caseId !== input.id) return false;
    const scoped = scopesAllow(live, task.requiredScopes);
    const manager = this.manages(live, task.caseId);
    const assigned =
      live.roles.includes("operator") &&
      task.assigneePrincipalId === live.id &&
      scoped;
    const purpose = context?.purpose ?? "propose";
    if (purpose === "read" || purpose === "approve") {
      if (live.roles.includes("approver") && scoped) return true;
      if (purpose === "approve") return false;
      if (assigned || manager) return true;
    } else if (purpose === "propose" || purpose === "execute") {
      return action === "cancelTask"
        ? manager
        : action === "transferTask"
          ? assigned || manager
          : assigned;
    } else if (assigned || manager) return true;
    // A receipt remains readable/reconcilable by its own requester after its
    // transfer changed the assignee. It does not unlock anyone else's run.
    if (
      !live.roles.includes("operator") ||
      (!scoped && !manager) ||
      context?.requestedBy !== live.id ||
      !context.runId ||
      !context.stepId ||
      !context.operationKey
    )
      return false;
    return this.history(principal.tenantId, task.id).some(
      (event) =>
        event.runId === context.runId &&
        event.stepId === context.stepId &&
        event.operationKey === context.operationKey &&
        event.requestedBy === live.id &&
        event.action === action,
    );
  }
  project(
    principal: Principal,
    filter: { caseId?: string; today?: string } = {},
  ): TaskProjection[] {
    const live = this.activeViewer(principal);
    const rows = this.db
      .prepare(
        `SELECT t.*,e.version AS case_version,e.status AS case_status FROM ops_tasks t JOIN ops_entities e
    ON e.tenant_id=t.tenant_id AND e.id=t.case_id WHERE t.tenant_id=? AND e.status!='cancelled'
    AND t.scope_revision=json_extract(e.data_json,'$.scopeRevision') ${filter.caseId ? "AND t.case_id=?" : ""} ORDER BY t.rowid`,
      )
      .all(
        ...(filter.caseId
          ? [principal.tenantId, filter.caseId]
          : [principal.tenantId]),
      );
    const today = filter.today ?? new Date().toISOString().slice(0, 10);
    return rows.flatMap((row) => {
      const task = this.decode(row),
        manager = this.manages(live, task.caseId);
      if (
        !manager &&
        !(
          task.assigneePrincipalId === live.id &&
          scopesAllow(live, task.requiredScopes)
        )
      )
        return [];
      const allowedActions: TaskAction[] = [];
      const actionableCase = ["open", "needs_changes"].includes(
        String(row.case_status),
      );
      const assigned =
        task.assigneePrincipalId === live.id &&
        scopesAllow(live, task.requiredScopes);
      if (actionableCase && assigned && task.status === "offered")
        allowedActions.push("acceptTask", "declineTask");
      if (actionableCase && assigned && task.status === "accepted")
        allowedActions.push("completeTask", "declineTask");
      if (actionableCase && !["completed", "cancelled"].includes(task.status)) {
        if (manager || assigned) allowedActions.push("transferTask");
        if (manager) allowedActions.push("cancelTask");
      }
      const {
        assigneeId: _businessPerson,
        requiredScopes: _scopes,
        requirementKeys: _keys,
        dependsOn: _deps,
        completedBy: _oldActor,
        ...safe
      } = task;
      return [
        {
          ...safe,
          caseVersion: Number(row.case_version),
          overdue:
            actionableCase &&
            !!task.dueDate &&
            task.dueDate < today &&
            !["completed", "cancelled"].includes(task.status),
          dependsOn: this.dependencies(principal.tenantId, task).map((dep) => ({
            id: dep.id,
            completed: dep.status === "completed",
          })),
          allowedActions,
          events: this.history(principal.tenantId, task.id),
        },
      ];
    });
  }
  eligibleAssignees(principal: Principal, taskId: string): { id: string }[] {
    const live = this.activeViewer(principal),
      task = this.get(principal.tenantId, taskId);
    if (
      !this.manages(live, task.caseId) &&
      !(
        task.assigneePrincipalId === live.id &&
        scopesAllow(live, task.requiredScopes)
      )
    )
      return fail("TASK_VIEW_FORBIDDEN", "Brak uprawnień do zadania.", 403);
    const all = this.provider?.(principal.tenantId) ?? [];
    return all
      .filter(
        (p) =>
          p.tenantId === principal.tenantId &&
          p.roles.includes("operator") &&
          scopesAllow(p, task.requiredScopes) &&
          all.filter(
            (other) => other.tenantId === p.tenantId && other.id === p.id,
          ).length === 1,
      )
      .map((p) => ({ id: p.id }));
  }
}
