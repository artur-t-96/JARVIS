import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DomainError, type JsonObject, type ToolContext } from "./contracts.js";
import { companyDay, reservationExpiresAt } from "./asset-custody.js";
import {
  applicationDataSchema,
  accessBundleDataSchema,
  type AccessGrant,
  type AccessEvent,
  type AccessMember,
} from "./access-models.js";
import type { Entity } from "./workspace.js";

type Row = Record<string, unknown>;
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
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const plusDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

export function migrateAccessRegister(db: DatabaseSync) {
  db.exec(`CREATE TABLE ops_access_grants(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,application_id TEXT NOT NULL,person_id TEXT NOT NULL,
    employment_episode_id TEXT NOT NULL,case_id TEXT NOT NULL,role TEXT NOT NULL,account_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('active','revoked')),version INTEGER NOT NULL CHECK(version>0),
    snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,last_event_id TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,application_id) REFERENCES ops_entities(tenant_id,id),
    FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id),
    FOREIGN KEY(tenant_id,employment_episode_id) REFERENCES ops_employment(tenant_id,id),
    FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
    CREATE UNIQUE INDEX ops_access_active_role ON ops_access_grants(tenant_id,person_id,employment_episode_id,application_id,role) WHERE status='active';
    CREATE UNIQUE INDEX ops_access_active_account ON ops_access_grants(tenant_id,application_id,account_ref,role) WHERE status='active';
    CREATE INDEX ops_access_case ON ops_access_grants(tenant_id,case_id,id);
    CREATE TABLE ops_access_events(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,grant_id TEXT NOT NULL,grant_version INTEGER NOT NULL,
    event_json TEXT NOT NULL,event_hash TEXT NOT NULL,operation_key TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,grant_id,grant_version),UNIQUE(tenant_id,operation_key),
    FOREIGN KEY(tenant_id,grant_id) REFERENCES ops_access_grants(tenant_id,id));
    CREATE UNIQUE INDEX ops_application_key ON ops_entities(tenant_id,json_extract(data_json,'$.applicationKey')) WHERE module='it' AND json_extract(data_json,'$.kind')='application';
    CREATE UNIQUE INDEX ops_access_bundle_key ON ops_entities(tenant_id,json_extract(data_json,'$.accessKey')) WHERE module='it' AND json_extract(data_json,'$.kind')='access_bundle';`);
}

/** Operations-owned data. The caller holds the common command transaction;
 * these methods never create their own Core approval or send network requests. */
export class AccessRegister {
  constructor(private readonly db: DatabaseSync) {}
  private entity(tenant: string, module: string, id: string): Entity {
    const r = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module=? AND id=?",
      )
      .get(tenant, module, id);
    if (!r)
      fail(
        "ACCESS_SOURCE_NOT_FOUND",
        "Brak właściwego źródła w tej organizacji.",
        404,
      );
    const e: Entity = {
      id: String(r.id),
      module: module as Entity["module"],
      title: String(r.title),
      status: String(r.status),
      version: Number(r.version),
      data: JSON.parse(String(r.data_json)),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
    const snapshot = this.db
      .prepare(
        "SELECT snapshot_hash,snapshot_json FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, id, e.version);
    if (
      !snapshot ||
      snapshot.snapshot_hash !== hash(e) ||
      hash(JSON.parse(String(snapshot.snapshot_json))) !==
        snapshot.snapshot_hash
    )
      fail(
        "ACCESS_SOURCE_INCONSISTENT",
        "Źródło dostępu nie odpowiada zapisanej wersji.",
      );
    if (module === "licenses") {
      const seats = this.db
        .prepare(
          "SELECT id,person_id AS personId,employment_episode_id AS employmentEpisodeId,case_id AS caseId,status,assigned_at AS assignedAt,revoked_at AS revokedAt FROM ops_license_seats WHERE tenant_id=? AND license_id=? ORDER BY rowid",
        )
        .all(tenant, id);
      if (canonical(seats) !== canonical(e.data.assignments))
        fail(
          "ACCESS_SOURCE_INCONSISTENT",
          "Przydziały licencji nie odpowiadają zatwierdzonej wersji.",
        );
    }
    return e;
  }
  application(tenant: string, id: string, version: number) {
    const e = this.entity(tenant, "it", id);
    const parsed = applicationDataSchema.safeParse(e.data);
    if (!parsed.success || e.status !== "active" || e.version !== version)
      fail(
        "APPLICATION_CHANGED",
        "Aplikacja jest nieaktywna lub zmieniła wersję. Odczytaj aktualny katalog.",
      );
    return { entity: e, data: parsed.data };
  }
  validateMembers(tenant: string, members: AccessMember[]) {
    for (const member of members) {
      const app = this.application(
        tenant,
        member.applicationId,
        member.applicationVersion,
      );
      if (!app.data.supportedRoles.includes(member.role))
        fail(
          "ACCESS_ROLE_UNSUPPORTED",
          "Rola nie należy do zatwierdzonego katalogu aplikacji.",
        );
      if (member.licenseId) {
        const license = this.entity(tenant, "licenses", member.licenseId);
        if (license.status !== "active")
          fail("ACCESS_LICENSE_INACTIVE", "Wymagana licencja jest nieaktywna.");
      }
    }
  }
  bundle(tenant: string, id: string, version: number) {
    const e = this.entity(tenant, "it", id),
      parsed = accessBundleDataSchema.safeParse(e.data);
    if (!parsed.success || e.status !== "active" || e.version !== version)
      fail(
        "ACCESS_BUNDLE_CHANGED",
        "Zestaw dostępów jest nieaktywny lub zmienił wersję. Wymagana właściwa rewizja sprawy.",
      );
    this.validateMembers(tenant, parsed.data.members);
    return { entity: e, data: parsed.data };
  }
  requirement(tenant: string, caseId: string, requirementId: string) {
    const c = this.entity(tenant, "cases", caseId);
    const r = this.db
      .prepare(
        "SELECT * FROM ops_case_requirements WHERE tenant_id=? AND case_id=? AND scope_revision=? AND id=? AND kind='access_attested'",
      )
      .get(tenant, caseId, Number(c.data.scopeRevision), requirementId);
    if (
      !r ||
      !r.person_id ||
      !r.employment_episode_id ||
      r.person_id !== c.data.personId ||
      r.employment_episode_id !== c.data.employmentEpisodeId
    )
      fail(
        "ACCESS_REQUIREMENT_MISMATCH",
        "Warunek nie dotyczy tej osoby, współpracy i rewizji sprawy.",
      );
    const expected = JSON.parse(String(r.expected_json)) as JsonObject;
    if (
      typeof expected.bundleId !== "string" ||
      typeof expected.bundleVersion !== "number"
    )
      fail(
        "ACCESS_BUNDLE_UNCONFIGURED",
        "Warunek nie ma zatwierdzonej wersji zestawu aplikacji i ról. Uzupełnij konfigurację oraz rewizję sprawy.",
      );
    const bundle = this.bundle(
      tenant,
      expected.bundleId,
      expected.bundleVersion,
    );
    if (bundle.data.accessKey !== expected.accessKey)
      fail(
        "ACCESS_REQUIREMENT_MISMATCH",
        "Zestaw nie odpowiada wymaganemu kluczowi dostępu.",
      );
    const episode = this.db
      .prepare(
        "SELECT * FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
      )
      .get(tenant, String(r.employment_episode_id), String(r.person_id));
    if (!episode)
      fail("EMPLOYMENT_REQUIRED", "Brak właściwego okresu współpracy.");
    return { entity: c, row: r, expected, bundle, episode };
  }
  revokePins(tenant: string, input: JsonObject): JsonObject {
    const grant = this.get(tenant, String(input.grantId));
    const c = this.entity(tenant, "cases", String(input.id));
    if (
      grant.caseId !== c.id ||
      grant.personId !== c.data.personId ||
      grant.employmentEpisodeId !== c.data.employmentEpisodeId
    )
      fail(
        "ACCESS_SCOPE_CHANGED",
        "Poświadczenie nie należy do wskazanej sprawy i współpracy.",
      );
    const episode = this.db
      .prepare(
        "SELECT version FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
      )
      .get(tenant, grant.employmentEpisodeId, grant.personId);
    if (!episode) fail("EMPLOYMENT_REQUIRED", "Brak właściwej współpracy.");
    return {
      personId: grant.personId,
      employmentEpisodeId: grant.employmentEpisodeId,
      expectedEpisodeVersion: Number(episode.version),
      scopeRevision: Number(c.data.scopeRevision),
    };
  }
  pins(tenant: string, input: JsonObject): JsonObject {
    const scope = this.requirement(
      tenant,
      String(input.id),
      String(input.requirementId),
    );
    const member = scope.bundle.data.members.find(
      (m) => m.key === input.memberKey,
    );
    if (!member)
      fail(
        "ACCESS_MEMBER_NOT_FOUND",
        "Pozycja nie należy do wymaganego zestawu.",
      );
    const pins: JsonObject = {
      personId: String(scope.row.person_id),
      employmentEpisodeId: String(scope.row.employment_episode_id),
      expectedEpisodeVersion: Number(scope.episode.version),
      scopeRevision: Number(scope.row.scope_revision),
      bundleId: scope.bundle.entity.id,
      bundleVersion: scope.bundle.entity.version,
      applicationId: member.applicationId,
      applicationVersion: member.applicationVersion,
    };
    if (member.licenseId)
      pins.licenseVersion = this.entity(
        tenant,
        "licenses",
        member.licenseId,
      ).version;
    return pins;
  }
  private licenseValid(
    tenant: string,
    member: AccessMember,
    grant: Pick<
      AccessGrant,
      "licenseSeatId" | "personId" | "employmentEpisodeId"
    >,
    now: string,
    timezone: string,
    expectedVersion?: number,
  ) {
    if (!member.licenseId) return grant.licenseSeatId === null;
    if (!grant.licenseSeatId) return false;
    const license = this.entity(tenant, "licenses", member.licenseId);
    const seat = this.db
      .prepare(
        "SELECT * FROM ops_license_seats WHERE tenant_id=? AND id=? AND license_id=? AND person_id=? AND employment_episode_id=?",
      )
      .get(
        tenant,
        grant.licenseSeatId,
        member.licenseId,
        grant.personId,
        grant.employmentEpisodeId,
      );
    return (
      !!seat &&
      seat.status === "assigned" &&
      license.status === "active" &&
      (expectedVersion === undefined || license.version === expectedVersion) &&
      (!license.data.expiresOn ||
        String(license.data.expiresOn) >= companyDay(now, timezone))
    );
  }
  get(tenant: string, id: string): AccessGrant {
    const r = this.db
      .prepare("SELECT * FROM ops_access_grants WHERE tenant_id=? AND id=?")
      .get(tenant, id);
    if (!r)
      fail(
        "ACCESS_GRANT_NOT_FOUND",
        "Brak wskazanego poświadczenia w tej organizacji.",
        404,
      );
    const grant = JSON.parse(String(r.snapshot_json)) as AccessGrant;
    if (
      hash(grant) !== r.snapshot_hash ||
      grant.id !== r.id ||
      grant.version !== r.version ||
      grant.applicationId !== r.application_id ||
      grant.personId !== r.person_id ||
      grant.employmentEpisodeId !== r.employment_episode_id ||
      grant.caseId !== r.case_id ||
      grant.role !== r.role ||
      grant.accountRef !== r.account_ref ||
      grant.status !== r.status ||
      grant.lastEventId !== r.last_event_id
    )
      fail(
        "ACCESS_HISTORY_INCONSISTENT",
        "Rejestr dostępu nie odpowiada zapisanej historii.",
      );
    this.assertHistory(tenant, grant);
    return grant;
  }
  list(tenant: string, caseId: string): AccessGrant[] {
    return this.db
      .prepare(
        "SELECT id FROM ops_access_grants WHERE tenant_id=? AND case_id=? ORDER BY rowid",
      )
      .all(tenant, caseId)
      .map((r) => this.get(tenant, String(r.id)));
  }
  history(tenant: string, grantId: string): AccessEvent[] {
    return this.db
      .prepare(
        "SELECT event_json FROM ops_access_events WHERE tenant_id=? AND grant_id=? ORDER BY grant_version",
      )
      .all(tenant, grantId)
      .map((r) => JSON.parse(String(r.event_json)) as AccessEvent);
  }
  private assertHistory(tenant: string, grant: AccessGrant) {
    const rows = this.db
      .prepare(
        "SELECT * FROM ops_access_events WHERE tenant_id=? AND grant_id=? ORDER BY grant_version",
      )
      .all(tenant, grant.id);
    if (rows.length !== grant.version)
      fail(
        "ACCESS_HISTORY_INCONSISTENT",
        "Historia poświadczenia jest niekompletna.",
      );
    let prior: Row | undefined;
    let previous: AccessEvent | undefined;
    for (const [index, r] of rows.entries()) {
      const e = JSON.parse(String(r.event_json)) as AccessEvent;
      if (
        e.id !== r.id ||
        e.grantId !== grant.id ||
        e.grantVersion !== index + 1 ||
        e.grantVersion !== r.grant_version ||
        e.snapshot.id !== grant.id ||
        e.snapshot.version !== e.grantVersion ||
        e.snapshot.lastEventId !== e.id ||
        hash(e.snapshot) !== e.snapshotHash ||
        hash(e) !== r.event_hash ||
        e.operationKey !== r.operation_key ||
        e.previousHash !== (prior ? prior.event_hash : null) ||
        e.performedBy !== e.requestedBy ||
        !e.performedBy ||
        e.snapshot.performedBy !== e.performedBy ||
        e.snapshot.approvedBy !== e.approvedBy ||
        e.recordedAt !== e.snapshot.recordedAt ||
        (index === 0
          ? e.kind !== "attest"
          : !["renew", "revoke"].includes(e.kind) ||
            previous?.snapshot.status !== "active") ||
        (e.kind === "revoke"
          ? e.snapshot.status !== "revoked" || !e.snapshot.revokedOn
          : e.snapshot.status !== "active" || e.snapshot.revokedOn !== null) ||
        e.snapshot.applicationId !== grant.applicationId ||
        e.snapshot.personId !== grant.personId ||
        e.snapshot.employmentEpisodeId !== grant.employmentEpisodeId ||
        e.snapshot.caseId !== grant.caseId ||
        e.snapshot.role !== grant.role ||
        e.snapshot.accountRef !== grant.accountRef ||
        (index === rows.length - 1 &&
          canonical(e.snapshot) !== canonical(grant))
      )
        fail(
          "ACCESS_HISTORY_INCONSISTENT",
          "Zdarzenie nie potwierdza właściwego dostępu i autora.",
        );
      prior = r;
      previous = e;
    }
  }
  private append(
    ctx: ToolContext,
    grant: AccessGrant,
    kind: AccessEvent["kind"],
    now: string,
  ): AccessEvent {
    if (!ctx.actorId)
      fail(
        "ACCESS_ACTOR_REQUIRED",
        "Poświadczenie wymaga wskazanego wykonawcy.",
        403,
      );
    const prior = this.db
      .prepare(
        "SELECT event_hash FROM ops_access_events WHERE tenant_id=? AND grant_id=? ORDER BY grant_version DESC LIMIT 1",
      )
      .get(ctx.tenantId, grant.id);
    const event: AccessEvent = {
      id: grant.lastEventId,
      grantId: grant.id,
      grantVersion: grant.version,
      kind,
      snapshot: grant,
      snapshotHash: hash(grant),
      previousHash: prior ? String(prior.event_hash) : null,
      requestedBy: ctx.actorId,
      approvedBy: ctx.approvedBy ?? null,
      performedBy: ctx.actorId,
      runId: ctx.runId,
      stepId: ctx.stepId,
      operationKey: ctx.operationKey,
      recordedAt: now,
    };
    this.db
      .prepare(
        "INSERT INTO ops_access_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status,version=excluded.version,snapshot_json=excluded.snapshot_json,snapshot_hash=excluded.snapshot_hash,last_event_id=excluded.last_event_id",
      )
      .run(
        ctx.tenantId,
        grant.id,
        grant.applicationId,
        grant.personId,
        grant.employmentEpisodeId,
        grant.caseId,
        grant.role,
        grant.accountRef,
        grant.status,
        grant.version,
        canonical(grant),
        hash(grant),
        grant.lastEventId,
      );
    this.db
      .prepare("INSERT INTO ops_access_events VALUES(?,?,?,?,?,?,?)")
      .run(
        ctx.tenantId,
        event.id,
        grant.id,
        grant.version,
        canonical(event),
        hash(event),
        ctx.operationKey,
      );
    return event;
  }
  attest(
    ctx: ToolContext,
    input: JsonObject,
    now: string,
    timezone: string,
    profileVersion: number,
    renew = false,
  ): AccessEvent {
    if (!ctx.actorId || input.humanConfirmed !== true)
      fail(
        "HUMAN_REQUIRED",
        "Wymagane jest jawne poświadczenie wykonawcy.",
        400,
      );
    const pins = this.pins(ctx.tenantId, input);
    if (Object.entries(pins).some(([key, value]) => input[key] !== value))
      fail(
        "ACCESS_SCOPE_CHANGED",
        "Zakres lub wersja poświadczenia zmieniły się. Przygotuj nowy plan i zgodę.",
      );
    const scope = this.requirement(
        ctx.tenantId,
        String(input.id),
        String(input.requirementId),
      ),
      member = scope.bundle.data.members.find(
        (m) => m.key === input.memberKey,
      )!;
    if (
      !["open", "needs_changes"].includes(scope.entity.status) ||
      !["onboarding", "active"].includes(String(scope.episode.status))
    )
      fail(
        "ACCESS_PERIOD_CLOSED",
        "Sprawa lub współpraca nie dopuszcza nowego poświadczenia.",
      );
    const observedOn = String(input.observedOn),
      validUntil = String(input.validUntil);
    if (
      observedOn > companyDay(now, timezone) ||
      observedOn < companyDay(scope.entity.createdAt, timezone) ||
      validUntil < observedOn ||
      validUntil > plusDays(observedOn, member.validityDays - 1)
    )
      fail(
        "ACCESS_OBSERVATION_DATE_INVALID",
        "Daty poświadczenia nie odpowiadają okresowi współpracy i ważności wymaganej przez zestaw.",
      );
    const expiresAt = reservationExpiresAt(validUntil, timezone);
    if (Date.parse(expiresAt) <= Date.parse(now))
      fail("ACCESS_OBSERVATION_EXPIRED", "Poświadczenie jest już nieaktualne.");
    const previous = renew
      ? this.get(ctx.tenantId, String(input.grantId))
      : undefined;
    if (
      previous &&
      (previous.version !== input.expectedGrantVersion ||
        previous.status !== "active" ||
        previous.caseId !== input.id ||
        previous.personId !== pins.personId ||
        previous.employmentEpisodeId !== pins.employmentEpisodeId ||
        previous.applicationId !== member.applicationId ||
        previous.role !== member.role ||
        previous.accountRef !== input.accountRef ||
        observedOn < previous.observedOn)
    )
      fail(
        "ACCESS_GRANT_CHANGED",
        "Odnowienie musi dotyczyć tej samej osoby, współpracy, aplikacji, roli i konta oraz bieżącej wersji poświadczenia.",
      );
    const grant: AccessGrant = {
      id: previous?.id ?? randomUUID(),
      version: previous ? previous.version + 1 : 1,
      applicationId: member.applicationId,
      applicationVersion: member.applicationVersion,
      personId: String(pins.personId),
      employmentEpisodeId: String(pins.employmentEpisodeId),
      caseId: String(input.id),
      scopeRevision: Number(pins.scopeRevision),
      requirementId: String(input.requirementId),
      bundleId: scope.bundle.entity.id,
      bundleVersion: scope.bundle.entity.version,
      memberKey: member.key,
      role: member.role,
      accountRef: String(input.accountRef),
      licenseSeatId:
        typeof input.licenseSeatId === "string" ? input.licenseSeatId : null,
      status: "active",
      observedOn,
      validUntil,
      expiresAt,
      timezone,
      profileVersion,
      verificationMethod: String(input.verificationMethod),
      note: String(input.note),
      performedBy: ctx.actorId,
      approvedBy: ctx.approvedBy ?? null,
      recordedAt: now,
      revokedOn: null,
      lastEventId: randomUUID(),
    };
    if (
      !this.licenseValid(
        ctx.tenantId,
        member,
        grant,
        now,
        timezone,
        typeof input.licenseVersion === "number"
          ? input.licenseVersion
          : undefined,
      )
    )
      fail(
        "ACCESS_LICENSE_UNCONFIRMED",
        "Wymagany aktualny przydział właściwej licencji tej osobie i współpracy.",
      );
    if (
      this.db
        .prepare(
          "SELECT id FROM ops_access_grants WHERE tenant_id=? AND status='active' AND application_id=? AND role=? AND (account_ref=? OR (person_id=? AND employment_episode_id=?)) AND id<>?",
        )
        .get(
          ctx.tenantId,
          member.applicationId,
          member.role,
          grant.accountRef,
          grant.personId,
          grant.employmentEpisodeId,
          grant.id,
        )
    )
      fail(
        "ACCESS_ALREADY_ACTIVE",
        "Istnieje aktywny zapis tej roli lub konta. Najpierw jawnie rozstrzygnij dotychczasowy dostęp i jego współprace.",
      );
    return this.append(ctx, grant, renew ? "renew" : "attest", now);
  }
  revoke(
    ctx: ToolContext,
    input: JsonObject,
    now: string,
    timezone: string,
  ): AccessEvent {
    if (!ctx.actorId || input.humanConfirmed !== true)
      fail(
        "HUMAN_REQUIRED",
        "Wymagane jest poświadczenie cofnięcia dostępu.",
        400,
      );
    const grant = this.get(ctx.tenantId, String(input.grantId));
    if (
      Object.entries(this.revokePins(ctx.tenantId, input)).some(
        ([key, value]) => input[key] !== value,
      )
    )
      fail(
        "ACCESS_SCOPE_CHANGED",
        "Sprawa lub współpraca zmieniła wersję. Przygotuj nowy plan cofnięcia dostępu.",
      );
    if (
      grant.version !== input.expectedGrantVersion ||
      grant.status !== "active"
    )
      fail(
        "ACCESS_GRANT_CHANGED",
        "Poświadczenie zmieniło wersję albo jest już cofnięte.",
      );
    if (
      grant.personId !== input.personId ||
      grant.employmentEpisodeId !== input.employmentEpisodeId
    )
      fail("ACCESS_SCOPE_CHANGED", "Dostęp nie dotyczy wskazanej współpracy.");
    const revokedOn = String(input.revokedOn);
    if (revokedOn < grant.observedOn || revokedOn > companyDay(now, timezone))
      fail(
        "ACCESS_OBSERVATION_DATE_INVALID",
        "Data cofnięcia jest wcześniejsza od poświadczenia lub późniejsza od dzisiaj.",
      );
    const next: AccessGrant = {
      ...grant,
      version: grant.version + 1,
      status: "revoked",
      revokedOn,
      note: String(input.note),
      verificationMethod: String(input.verificationMethod),
      performedBy: ctx.actorId,
      approvedBy: ctx.approvedBy ?? null,
      recordedAt: now,
      lastEventId: randomUUID(),
    };
    return this.append(ctx, next, "revoke", now);
  }
  verifyCommitted(ctx: ToolContext): boolean {
    try {
      const r = this.db
        .prepare(
          "SELECT event_json FROM ops_access_events WHERE tenant_id=? AND operation_key=?",
        )
        .get(ctx.tenantId, ctx.operationKey);
      if (!r) return false;
      const event = JSON.parse(String(r.event_json)) as AccessEvent;
      this.get(ctx.tenantId, event.grantId);
      return (
        event.runId === ctx.runId &&
        event.stepId === ctx.stepId &&
        event.requestedBy === ctx.actorId &&
        event.approvedBy === (ctx.approvedBy ?? null)
      );
    } catch {
      return false;
    }
  }
  assessment(
    tenant: string,
    caseId: string,
    requirementId: string,
    now: string,
  ) {
    const scope = this.requirement(tenant, caseId, requirementId);
    const grants = this.list(tenant, caseId);
    const members = scope.bundle.data.members.map((member) => {
      const matches = grants.filter(
        (g) =>
          g.applicationId === member.applicationId &&
          g.role === member.role &&
          g.personId === scope.row.person_id &&
          g.employmentEpisodeId === scope.row.employment_episode_id &&
          g.status === "active",
      );
      const grant = matches.length === 1 ? matches[0] : undefined;
      const current =
        !!grant &&
        grant.applicationVersion === member.applicationVersion &&
        grant.bundleId === scope.bundle.entity.id &&
        grant.bundleVersion === scope.bundle.entity.version &&
        grant.scopeRevision === scope.row.scope_revision &&
        grant.requirementId === requirementId &&
        Date.parse(grant.expiresAt) > Date.parse(now) &&
        grant.validUntil <=
          plusDays(grant.observedOn, member.validityDays - 1) &&
        this.licenseValid(tenant, member, grant, now, grant.timezone);
      return {
        key: member.key,
        applicationId: member.applicationId,
        applicationVersion: member.applicationVersion,
        role: member.role,
        validityDays: member.validityDays,
        licenseId: member.licenseId ?? null,
        current,
        grantId: grant?.id ?? null,
        grantVersion: grant?.version ?? null,
        eventId: grant?.lastEventId ?? null,
        snapshotHash: grant ? hash(grant) : null,
        expiresAt: grant?.expiresAt ?? null,
        performedBy: grant?.performedBy ?? null,
        approvedBy: grant?.approvedBy ?? null,
      };
    });
    const identity = {
      bundleId: scope.bundle.entity.id,
      bundleVersion: scope.bundle.entity.version,
      accessKey: scope.bundle.data.accessKey,
      caseId,
      scopeRevision: Number(scope.row.scope_revision),
      personId: String(scope.row.person_id),
      employmentEpisodeId: String(scope.row.employment_episode_id),
      current:
        ["onboarding", "active"].includes(String(scope.episode.status)) &&
        scope.entity.status !== "cancelled" &&
        members.every((m) => m.current),
      members,
    };
    return {
      title: scope.bundle.entity.title,
      version: scope.bundle.entity.version,
      revision: null,
      identity: identity as JsonObject,
      hash: hash(identity),
    };
  }
}
