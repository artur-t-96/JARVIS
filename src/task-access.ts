import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolAccessContext,
  type ToolContext,
} from "./contracts.js";
import { AccessRegister } from "./access-register.js";
import { accessBundleDataSchema, type AccessGrant } from "./access-models.js";
import { WorkspaceTasks, type TaskRecord } from "./workspace-tasks.js";

export const accessTaskActions = [
  "attestAccessForTask",
  "renewAccessForTask",
  "revokeAccessForTask",
  "bindAccessForTask",
] as const;
export type AccessTaskAction = (typeof accessTaskActions)[number];
type Row = Record<string, unknown>;
const canonical = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? "[" + v.map(canonical).join(",") + "]"
      : "{" +
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
          .join(",") +
        "}";
const hash = (v: unknown) =>
  createHash("sha256").update(canonical(v)).digest("hex");
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const scopesAllow = (p: Principal, scopes: string[]) =>
  scopes.every((s) => p.scopes?.includes("*") || p.scopes?.includes(s));

export interface TaskAccessMember {
  key: string;
  applicationLabel: string;
  role: string;
  validityDays: number;
  licenseRequired: boolean;
  licenseSeats: { id: string; label: string }[];
  current: boolean;
  grant: Pick<
    AccessGrant,
    | "id"
    | "version"
    | "accountRef"
    | "status"
    | "observedOn"
    | "validUntil"
    | "performedBy"
    | "approvedBy"
  > | null;
  history: {
    kind: string;
    recordedAt: string;
    observedOn: string;
    validUntil: string;
    revokedOn: string | null;
    performedBy: string;
    approvedBy: string | null;
  }[];
  commandBindings: Partial<Record<AccessTaskAction, JsonObject>>;
}
export interface TaskAccessProjection {
  task: Pick<
    TaskRecord,
    "id" | "title" | "version" | "status" | "scopeRevision"
  >;
  recipientLabel: string;
  engagementLabel: string;
  dependenciesReady: boolean;
  requirements: {
    id: string;
    title: string;
    bundleTitle: string | null;
    problem: string | null;
    bound: boolean;
    bindingCurrent: boolean;
    current: boolean;
    members: TaskAccessMember[];
    bindInput?: JsonObject;
  }[];
}

/** Capability limited to a currently assigned IT task. No full entity, HR fields,
 * licence roster, source notes or other task payload is projected through it. */
export class TaskAccess {
  constructor(
    private readonly db: DatabaseSync,
    private readonly tasks: WorkspaceTasks,
    private readonly access: AccessRegister,
    private readonly account: (
      tenant: string,
      id?: string,
    ) => Principal | undefined,
    private readonly scopeHash: (tenant: string, caseId: string) => string,
    private readonly profileVersion: (tenant: string) => number,
  ) {}
  private live(p: Principal): Principal {
    const a = this.account(p.tenantId, p.id);
    if (!a) fail("TASK_VIEW_FORBIDDEN", "Brak aktywnego konta wykonawcy.", 403);
    return {
      ...a,
      roles: a.roles.filter((r) => p.roles.includes(r)),
      scopes: a.scopes?.includes("*")
        ? p.scopes
        : p.scopes?.includes("*")
          ? a.scopes
          : (a.scopes ?? []).filter((s) => p.scopes?.includes(s)),
    };
  }
  private scope(tenant: string, task: TaskRecord) {
    const c = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module='cases' AND id=?",
      )
      .get(tenant, task.caseId);
    if (!c) fail("TASK_ACCESS_SCOPE_INVALID", "Brak właściwej sprawy zadania.");
    const data = JSON.parse(String(c.data_json)) as JsonObject;
    if (
      task.assigneeRole !== "it" ||
      !task.requiredScopes.includes("it") ||
      task.scopeRevision !== data.scopeRevision ||
      !["open", "needs_changes"].includes(String(c.status))
    )
      fail(
        "TASK_ACCESS_SCOPE_INVALID",
        "Zadanie nie ma aktualnego zakresu dostępów w otwartej sprawie.",
      );
    const snapshot = (data.tasks as JsonObject[]).find((t) => t.id === task.id);
    if (canonical(snapshot) !== canonical(task))
      fail(
        "TASK_STATE_INCONSISTENT",
        "Stan zadania nie odpowiada zapisanej wersji sprawy.",
      );
    const person = this.db
      .prepare(
        "SELECT id,title FROM ops_entities WHERE tenant_id=? AND module='people' AND id=?",
      )
      .get(tenant, String(data.personId ?? ""));
    const episode = this.db
      .prepare(
        "SELECT * FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
      )
      .get(
        tenant,
        String(data.employmentEpisodeId ?? ""),
        String(data.personId ?? ""),
      );
    if (
      !person ||
      !episode ||
      !["onboarding", "active"].includes(String(episode.status))
    )
      fail(
        "TASK_ACCESS_SCOPE_INVALID",
        "Zadanie nie wskazuje otwartej współpracy właściwej osoby.",
      );
    const requirements = this.db
      .prepare(
        "SELECT * FROM ops_case_requirements WHERE tenant_id=? AND case_id=? AND scope_revision=? AND kind='access_attested' ORDER BY requirement_key",
      )
      .all(tenant, task.caseId, task.scopeRevision)
      .filter((r) => task.requirementKeys.includes(String(r.requirement_key)));
    if (
      !requirements.length ||
      requirements.some(
        (r) =>
          r.person_id !== person.id || r.employment_episode_id !== episode.id,
      )
    )
      fail(
        "TASK_ACCESS_SCOPE_INVALID",
        "To zadanie nie obejmuje dostępu właściwej osoby i współpracy.",
      );
    const scopeHash = this.scopeHash(tenant, task.caseId);
    if (!/^[a-f0-9]{64}$/.test(scopeHash))
      fail(
        "TASK_ACCESS_SCOPE_INVALID",
        "Nie można potwierdzić zakresu sprawy.",
      );
    let engagementLabel =
      episode.kind === "internal"
        ? "Współpraca wewnętrzna"
        : "Współpraca konsultanta";
    if (episode.engagement_id) {
      const project = this.db
        .prepare(
          "SELECT title FROM ops_entities WHERE tenant_id=? AND id=? AND module IN('cases','sales') AND module=?",
        )
        .get(
          tenant,
          String(episode.engagement_id),
          String(episode.engagement_module),
        );
      if (!project)
        fail(
          "TASK_ACCESS_SCOPE_INVALID",
          "Brak jednoznacznej współpracy projektowej.",
        );
      engagementLabel = String(project.title).slice(0, 200);
    }
    engagementLabel +=
      " · " +
      String(episode.start_date) +
      (episode.end_date ? " – " + String(episode.end_date) : "");
    const dependenciesReady = task.dependsOn.every((id) => {
      const dep = this.tasks.get(tenant, id);
      if (
        dep.caseId !== task.caseId ||
        dep.scopeRevision !== task.scopeRevision
      )
        fail(
          "INVALID_TASK_DEPENDENCIES",
          "Zależność nie należy do tej rewizji.",
        );
      return dep.status === "completed";
    });
    return {
      c,
      data,
      person,
      episode,
      requirements,
      scopeHash,
      dependenciesReady,
      recipientLabel: String(person.title).slice(0, 200),
      engagementLabel,
    };
  }
  /** Frozen task scope remains sufficient to withdraw a witnessed role even if
   * its application is retired. New/renewed attestations still need live sources. */
  private definition(tenant: string, requirement: Row) {
    const expected = JSON.parse(String(requirement.expected_json));
    const row = this.db
      .prepare(
        "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(
        tenant,
        String(expected.bundleId ?? ""),
        Number(expected.bundleVersion ?? 0),
      );
    if (!row)
      fail(
        "ACCESS_BUNDLE_UNCONFIGURED",
        "Wymaganie nie ma zatwierdzonej wersji zestawu. Właściciel sprawy musi uzupełnić zakres.",
      );
    const e = JSON.parse(String(row.snapshot_json));
    if (
      hash(e) !== row.snapshot_hash ||
      e.module !== "it" ||
      e.id !== expected.bundleId ||
      e.version !== expected.bundleVersion
    )
      fail(
        "ACCESS_SOURCE_INCONSISTENT",
        "Zapisana definicja zestawu jest niespójna.",
      );
    const data = accessBundleDataSchema.parse(e.data);
    if (data.accessKey !== expected.accessKey)
      fail(
        "ACCESS_REQUIREMENT_MISMATCH",
        "Zestaw nie odpowiada wymaganiu zadania.",
      );
    return {
      id: String(e.id),
      version: Number(e.version),
      title: String(e.title),
      members: data.members,
    };
  }
  prepare(
    tenant: string,
    input: JsonObject,
    action: AccessTaskAction,
    now: string,
  ): JsonObject {
    const task = this.tasks.get(tenant, String(input.taskId)),
      scope = this.scope(tenant, task);
    if (input.id !== task.caseId)
      fail(
        "TASK_ACCESS_SCOPE_INVALID",
        "Zadanie nie należy do wskazanej sprawy.",
      );
    const r = scope.requirements.find((r) => r.id === input.requirementId);
    if (!r)
      fail(
        "TASK_ACCESS_REQUIREMENT_MISMATCH",
        "Warunek nie należy do zakresu tego zadania.",
      );
    const definition = this.definition(tenant, r);
    const pins: JsonObject = {
      personId: String(scope.person.id),
      employmentEpisodeId: String(scope.episode.id),
      expectedEpisodeVersion: Number(scope.episode.version),
      scopeRevision: task.scopeRevision,
      scopeHash: scope.scopeHash,
      profileVersion: this.profileVersion(tenant),
    };
    if (action === "bindAccessForTask") {
      const source = this.access.assessment(
        tenant,
        task.caseId,
        String(r.id),
        now,
      );
      Object.assign(pins, {
        sourceId: definition.id,
        sourceVersion: definition.version,
        accessProofHash: source.hash,
      });
    } else if (action === "revokeAccessForTask") {
      const grant = this.access.get(tenant, String(input.grantId));
      if (
        grant.caseId !== task.caseId ||
        grant.personId !== scope.person.id ||
        grant.employmentEpisodeId !== scope.episode.id ||
        !definition.members.some(
          (m) =>
            m.applicationId === grant.applicationId && m.role === grant.role,
        )
      )
        fail(
          "TASK_ACCESS_GRANT_MISMATCH",
          "Poświadczenie nie należy do aplikacji i roli z tego zadania.",
        );
      Object.assign(pins, this.access.revokePins(tenant, input));
    } else Object.assign(pins, this.access.pins(tenant, input));
    const prepared = { ...input };
    for (const [key, value] of Object.entries(pins)) {
      if (prepared[key] === undefined) prepared[key] = value;
      else if (prepared[key] !== value)
        fail(
          "TASK_ACCESS_SCOPE_CHANGED",
          "Zakres lub wersja zmieniły się. Przygotuj nowy plan i zgodę.",
        );
    }
    return prepared;
  }
  private eventMatches(
    tenant: string,
    taskId: string,
    input: JsonObject,
    action: AccessTaskAction,
    context: {
      runId?: string;
      stepId?: string;
      operationKey?: string;
      requestedBy?: string;
    },
  ) {
    return this.tasks.history(tenant, taskId).some((e) => {
      if (
        e.action !== action ||
        e.runId !== context.runId ||
        e.stepId !== context.stepId ||
        e.operationKey !== context.operationKey ||
        e.requestedBy !== context.requestedBy ||
        e.taskVersion !== Number(input.expectedTaskVersion) + 1
      )
        return false;
      try {
        const proof = JSON.parse(e.reason ?? "");
        return proof.inputHash === hash(input);
      } catch {
        return false;
      }
    });
  }
  canAccess(
    p: Principal,
    input: JsonObject,
    context: ToolAccessContext | undefined,
    action: AccessTaskAction,
  ): boolean {
    try {
      const live = this.live(p),
        task = this.tasks.get(p.tenantId, String(input.taskId));
      if (
        !scopesAllow(live, ["it", ...task.requiredScopes]) ||
        task.assigneeRole !== "it" ||
        task.caseId !== input.id
      )
        return false;
      const purpose = context?.purpose ?? "propose";
      if (
        ["read", "approve"].includes(purpose) &&
        live.roles.includes("approver")
      )
        return true;
      if (purpose === "approve" || !live.roles.includes("operator"))
        return false;
      if (
        ["read", "recover"].includes(purpose) &&
        context?.requestedBy === live.id &&
        this.eventMatches(p.tenantId, task.id, input, action, context)
      )
        return true;
      if (task.assigneePrincipalId === live.id && task.status === "accepted") {
        this.scope(p.tenantId, task);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  authorize(
    ctx: ToolContext,
    input: JsonObject,
    action: AccessTaskAction,
    now: string,
  ) {
    ctx.signal.throwIfAborted();
    const actor = this.account(ctx.tenantId, ctx.actorId),
      task = this.tasks.get(ctx.tenantId, String(input.taskId));
    if (
      !actor?.roles.includes("operator") ||
      !scopesAllow(actor, ["it", ...task.requiredScopes]) ||
      task.assigneePrincipalId !== actor.id ||
      task.status !== "accepted"
    )
      fail(
        "TASK_ACCESS_ACTOR_FORBIDDEN",
        "Poświadcza wyłącznie bieżący wykonawca przyjętego zadania.",
        403,
      );
    if (task.version !== input.expectedTaskVersion)
      fail("TASK_VERSION_CONFLICT", "Zadanie zmieniło wersję.");
    if (input.humanConfirmed !== true)
      fail("HUMAN_REQUIRED", "Potwierdź konkretną czynność.", 400);
    const prepared = this.prepare(ctx.tenantId, input, action, now);
    if (canonical(prepared) !== canonical(input))
      fail(
        "TASK_ACCESS_PINS_REQUIRED",
        "Plan nie zawiera pełnego zakresu zgody.",
      );
    if (!this.scope(ctx.tenantId, task).dependenciesReady)
      fail("TASK_DEPENDENCIES_BLOCKED", "Najpierw wykonaj zależności zadania.");
  }
  record(
    ctx: ToolContext,
    input: JsonObject,
    action: AccessTaskAction,
    proof: JsonObject,
    now: string,
  ) {
    const task = this.tasks.get(ctx.tenantId, String(input.taskId));
    if (
      task.version !== input.expectedTaskVersion ||
      task.status !== "accepted" ||
      task.assigneePrincipalId !== ctx.actorId
    )
      fail(
        "TASK_VERSION_CONFLICT",
        "Poświadczenie straciło powiązanie z zadaniem.",
      );
    const update = this.db
      .prepare(
        "UPDATE ops_tasks SET version=version+1,requested_by=?,approved_by=?,updated_at=? WHERE tenant_id=? AND id=? AND version=?",
      )
      .run(
        ctx.actorId ?? null,
        ctx.approvedBy ?? null,
        now,
        ctx.tenantId,
        task.id,
        task.version,
      );
    if (Number(update.changes) !== 1)
      fail("TASK_VERSION_CONFLICT", "Zadanie zmieniło wersję.");
    this.db
      .prepare(
        "INSERT INTO ops_task_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ctx.tenantId,
        randomUUID(),
        task.id,
        task.caseId,
        task.scopeRevision,
        task.version + 1,
        action,
        task.status,
        task.status,
        task.assigneePrincipalId,
        task.assigneePrincipalId,
        ctx.actorId ?? null,
        ctx.approvedBy ?? null,
        action === "bindAccessForTask" ? null : (ctx.actorId ?? null),
        canonical({
          ...proof,
          requirementId: input.requirementId,
          inputHash: hash(input),
        }),
        ctx.runId,
        ctx.stepId,
        ctx.operationKey,
        now,
      );
  }
  verifyCommitted(
    ctx: ToolContext,
    input: JsonObject,
    action: AccessTaskAction,
  ): boolean {
    try {
      const actor = this.account(ctx.tenantId, ctx.actorId),
        task = this.tasks.get(ctx.tenantId, String(input.taskId));
      const event = this.tasks
        .history(ctx.tenantId, task.id)
        .find(
          (e) => e.operationKey === ctx.operationKey && e.action === action,
        );
      if (!event) return false;
      const proof = JSON.parse(event.reason ?? "");
      if (proof.requirementId !== input.requirementId) return false;
      if (action === "bindAccessForTask") {
        const binding = this.db
          .prepare(
            "SELECT * FROM ops_requirement_bindings WHERE tenant_id=? AND requirement_id=? AND operation_key=?",
          )
          .get(ctx.tenantId, String(input.requirementId), ctx.operationKey);
        if (
          !binding ||
          binding.run_id !== ctx.runId ||
          binding.step_id !== ctx.stepId ||
          binding.requested_by !== ctx.actorId ||
          binding.approved_by !== (ctx.approvedBy ?? null) ||
          binding.source_id !== input.sourceId ||
          binding.source_version !== input.sourceVersion ||
          binding.source_hash !== input.accessProofHash ||
          proof.sourceId !== input.sourceId ||
          proof.accessProofHash !== input.accessProofHash
        )
          return false;
      } else {
        const row = this.db
          .prepare(
            "SELECT event_json FROM ops_access_events WHERE tenant_id=? AND operation_key=?",
          )
          .get(ctx.tenantId, ctx.operationKey);
        if (!row) return false;
        const witness = JSON.parse(String(row.event_json));
        if (
          proof.grantId !== witness.grantId ||
          proof.eventId !== witness.id ||
          !this.access.verifyCommitted(ctx)
        )
          return false;
      }
      return (
        !!actor?.roles.includes("operator") &&
        scopesAllow(actor, ["it", ...task.requiredScopes]) &&
        this.tasks.verifyCommitted(ctx, task.id) &&
        this.eventMatches(ctx.tenantId, task.id, input, action, {
          ...ctx,
          requestedBy: ctx.actorId,
        })
      );
    } catch {
      return false;
    }
  }
  context(p: Principal, taskId: string) {
    const live = this.live(p),
      task = this.tasks.get(p.tenantId, taskId);
    if (
      !live.roles.includes("operator") ||
      !scopesAllow(live, ["it", ...task.requiredScopes]) ||
      task.assigneePrincipalId !== live.id ||
      !["offered", "accepted"].includes(task.status)
    )
      fail(
        "TASK_VIEW_FORBIDDEN",
        "Dostępy widzi wyłącznie bieżący wykonawca przypisanego zadania.",
        403,
      );
    const scope = this.scope(p.tenantId, task);
    return { task, scope };
  }
  projection(p: Principal, taskId: string, now: string): TaskAccessProjection {
    const { task, scope } = this.context(p, taskId);
    const result: TaskAccessProjection = {
      task: {
        id: task.id,
        title: task.title,
        version: task.version,
        status: task.status,
        scopeRevision: task.scopeRevision,
      },
      recipientLabel: scope.recipientLabel,
      engagementLabel: scope.engagementLabel,
      dependenciesReady: scope.dependenciesReady,
      requirements: [],
    };
    if (task.status !== "accepted") return result;
    const grants = this.access.list(p.tenantId, task.caseId);
    const bindings = this.db
      .prepare(
        "SELECT requirement_id,source_hash,source_version FROM ops_requirement_bindings WHERE tenant_id=? AND case_id=? AND scope_revision=?",
      )
      .all(p.tenantId, task.caseId, task.scopeRevision);
    for (const r of scope.requirements) {
      const requirement: TaskAccessProjection["requirements"][number] = {
        id: String(r.id),
        title: String(r.title),
        bundleTitle: null,
        problem: null,
        bound: bindings.some((b) => b.requirement_id === r.id),
        bindingCurrent: false,
        current: false,
        members: [],
      };
      result.requirements.push(requirement);
      try {
        const definition = this.definition(p.tenantId, r);
        requirement.bundleTitle = definition.title;
        let assessment: ReturnType<AccessRegister["assessment"]> | undefined;
        try {
          assessment = this.access.assessment(
            p.tenantId,
            task.caseId,
            String(r.id),
            now,
          );
          requirement.current = assessment.identity.current === true;
          requirement.bindingCurrent =
            requirement.current &&
            bindings.some(
              (b) =>
                b.requirement_id === r.id &&
                b.source_hash === assessment!.hash &&
                b.source_version === assessment!.version,
            );
        } catch (error) {
          requirement.problem =
            error instanceof DomainError
              ? error.message
              : "Źródło dostępu wymaga sprawdzenia.";
        }
        const base: JsonObject = {
          id: task.caseId,
          expectedVersion: Number(scope.c.version),
          taskId,
          expectedTaskVersion: task.version,
          requirementId: String(r.id),
        };
        for (const member of definition.members) {
          const candidates = grants.filter(
            (g) =>
              g.personId === scope.person.id &&
              g.employmentEpisodeId === scope.episode.id &&
              g.applicationId === member.applicationId &&
              g.role === member.role,
          );
          const active = candidates.filter((g) => g.status === "active"),
            grant = active.length === 1 ? active[0] : undefined;
          const app = this.db
            .prepare(
              "SELECT title FROM ops_entities WHERE tenant_id=? AND module='it' AND id=?",
            )
            .get(p.tenantId, member.applicationId);
          const entry: TaskAccessMember = {
            key: member.key,
            applicationLabel: app ? String(app.title) : "Aplikacja niedostępna",
            role: member.role,
            validityDays: member.validityDays,
            licenseRequired: !!member.licenseId,
            licenseSeats: [],
            current: !!(
              assessment?.identity.members as JsonObject[] | undefined
            )?.find((m) => m.key === member.key && m.current === true),
            grant: grant
              ? {
                  id: grant.id,
                  version: grant.version,
                  accountRef: grant.accountRef,
                  status: grant.status,
                  observedOn: grant.observedOn,
                  validUntil: grant.validUntil,
                  performedBy: grant.performedBy,
                  approvedBy: grant.approvedBy,
                }
              : null,
            history: [],
            commandBindings: {},
          };
          requirement.members.push(entry);
          entry.history = candidates
            .flatMap((g) => this.access.history(p.tenantId, g.id))
            .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
            .slice(0, 50)
            .map((e) => ({
              kind: e.kind,
              recordedAt: e.recordedAt,
              observedOn: e.snapshot.observedOn,
              validUntil: e.snapshot.validUntil,
              revokedOn: e.snapshot.revokedOn,
              performedBy: e.performedBy,
              approvedBy: e.approvedBy,
            }));
          if (member.licenseId)
            entry.licenseSeats = this.db
              .prepare(
                "SELECT s.id,e.title FROM ops_license_seats s JOIN ops_entities e ON e.tenant_id=s.tenant_id AND e.id=s.license_id WHERE s.tenant_id=? AND s.license_id=? AND s.person_id=? AND s.employment_episode_id=? AND s.status='assigned' AND e.module='licenses' AND e.status='active'",
              )
              .all(
                p.tenantId,
                member.licenseId,
                String(scope.person.id),
                String(scope.episode.id),
              )
              .map((s) => ({ id: String(s.id), label: String(s.title) }));
          if (!scope.dependenciesReady) continue;
          if (assessment) {
            const action = grant ? "renewAccessForTask" : "attestAccessForTask";
            entry.commandBindings[action] = this.prepare(
              p.tenantId,
              {
                ...base,
                memberKey: member.key,
                ...(grant
                  ? { grantId: grant.id, expectedGrantVersion: grant.version }
                  : {}),
              },
              action,
              now,
            );
          }
          if (grant)
            entry.commandBindings.revokeAccessForTask = this.prepare(
              p.tenantId,
              {
                ...base,
                grantId: grant.id,
                expectedGrantVersion: grant.version,
              },
              "revokeAccessForTask",
              now,
            );
        }
        if (
          requirement.current &&
          !requirement.bound &&
          scope.dependenciesReady
        )
          requirement.bindInput = this.prepare(
            p.tenantId,
            base,
            "bindAccessForTask",
            now,
          );
      } catch (error) {
        requirement.problem =
          error instanceof DomainError
            ? error.message
            : "Nie można potwierdzić zakresu dostępów.";
      }
    }
    return result;
  }
}
