import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DomainError, type JsonObject, type ToolContext } from "./contracts.js";
import type { Entity } from "./workspace.js";

type Row = Record<string, unknown>;
export type CustodyAction =
  "reserve" | "issue" | "return" | "release" | "expire";
export interface Allocation {
  id: string;
  assetId: string;
  personId: string;
  employmentEpisodeId: string | null;
  caseId: string | null;
  version: number;
  status: "reserved" | "issued" | "released" | "returned";
  reservedUntil: string;
  issuedOn: string | null;
  returnedOn: string | null;
  expiresAt: string | null;
  timezone: string | null;
  profileVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  provenance: "legacy" | "p05";
  issueEventId: string | null;
  returnEventId: string | null;
  lastEventId: string | null;
}
export interface CustodyEvent {
  id: string;
  assetId: string;
  allocationId: string;
  allocationVersion: number;
  kind: CustodyAction;
  requestedBy: string;
  approvedBy: string | null;
  performedBy: string | null;
  occurredOn: string;
  recordedAt: string;
  runId: string;
  stepId: string;
  operationKey: string;
  snapshot: {
    allocation: Allocation;
    asset: JsonObject;
    note: string;
    event: JsonObject;
  };
  snapshotHash: string;
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const nullable = (value: unknown): string | null =>
  value == null ? null : String(value);
export function migrateAssetCustody(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE ops_allocations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE ops_allocations ADD COLUMN expires_at TEXT;
    ALTER TABLE ops_allocations ADD COLUMN timezone TEXT;
    ALTER TABLE ops_allocations ADD COLUMN profile_version INTEGER;
    ALTER TABLE ops_allocations ADD COLUMN created_at TEXT;
    ALTER TABLE ops_allocations ADD COLUMN updated_at TEXT;
    ALTER TABLE ops_allocations ADD COLUMN provenance TEXT NOT NULL DEFAULT 'legacy' CHECK(provenance IN('legacy','p05'));
    ALTER TABLE ops_allocations ADD COLUMN issue_event_id TEXT;
    ALTER TABLE ops_allocations ADD COLUMN return_event_id TEXT;
    ALTER TABLE ops_allocations ADD COLUMN last_event_id TEXT;
    CREATE TABLE ops_asset_events(
      tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
      allocation_version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('reserve','issue','return','release','expire')),
      requested_by TEXT NOT NULL,approved_by TEXT,performed_by TEXT,occurred_on TEXT NOT NULL,recorded_at TEXT NOT NULL,
      run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
      PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,allocation_id,allocation_version),UNIQUE(tenant_id,operation_key),
      FOREIGN KEY(tenant_id,allocation_id) REFERENCES ops_allocations(tenant_id,id),
      FOREIGN KEY(tenant_id,asset_id) REFERENCES ops_entities(tenant_id,id));
    CREATE INDEX ops_asset_event_history ON ops_asset_events(tenant_id,asset_id,recorded_at,id);
  `);
}
export function companyDay(now: string | number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  return ["year", "month", "day"]
    .map((kind) => parts.find((part) => part.type === kind)!.value)
    .join("-");
}
export function migrateCustodyMultipleAssets(db: DatabaseSync) {
  db.exec(`CREATE TABLE ops_asset_events_v7(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    allocation_version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('reserve','issue','return','release','expire')),
    requested_by TEXT NOT NULL,approved_by TEXT,performed_by TEXT,occurred_on TEXT NOT NULL,recorded_at TEXT NOT NULL,
    run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,allocation_id,allocation_version),UNIQUE(tenant_id,operation_key,asset_id),
    FOREIGN KEY(tenant_id,allocation_id) REFERENCES ops_allocations(tenant_id,id),
    FOREIGN KEY(tenant_id,asset_id) REFERENCES ops_entities(tenant_id,id));
    INSERT INTO ops_asset_events_v7 SELECT * FROM ops_asset_events ORDER BY rowid;
    DROP TABLE ops_asset_events;
    ALTER TABLE ops_asset_events_v7 RENAME TO ops_asset_events;
    CREATE INDEX ops_asset_event_history ON ops_asset_events(tenant_id,asset_id,recorded_at,id);`);
}
/** The reservation remains valid through its whole local calendar day. Find the
 * first UTC millisecond after that day, including midnight timezone transitions. */
export function reservationExpiresAt(until: string, timezone: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(until) ||
    !Number.isFinite(Date.parse(until)) ||
    new Date(until).toISOString().slice(0, 10) !== until
  )
    fail("INVALID_RESERVATION_DATE", "Niepoprawny dzień rezerwacji.");
  const noon = Date.parse(`${until}T12:00:00Z`);
  let low = noon - 48 * 3_600_000,
    high = noon + 48 * 3_600_000;
  if (companyDay(low, timezone) > until || companyDay(high, timezone) <= until)
    fail(
      "INVALID_RESERVATION_DATE",
      "Nie można ustalić końca dnia rezerwacji.",
    );
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (companyDay(mid, timezone) <= until) low = mid;
    else high = mid;
  }
  if (companyDay(low, timezone) !== until)
    fail(
      "INVALID_RESERVATION_DATE",
      "Ten dzień nie występuje w strefie firmy.",
    );
  return new Date(high).toISOString();
}
function allocation(row: Row): Allocation {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    personId: String(row.person_id),
    employmentEpisodeId: nullable(row.employment_episode_id),
    caseId: nullable(row.case_id),
    version: Number(row.version),
    status: row.status as Allocation["status"],
    reservedUntil: String(row.reserved_until),
    issuedOn: nullable(row.issued_on),
    returnedOn: nullable(row.returned_on),
    expiresAt: nullable(row.expires_at),
    timezone: nullable(row.timezone),
    profileVersion:
      row.profile_version == null ? null : Number(row.profile_version),
    createdAt: nullable(row.created_at),
    updatedAt: nullable(row.updated_at),
    provenance: row.provenance as Allocation["provenance"],
    issueEventId: nullable(row.issue_event_id),
    returnEventId: nullable(row.return_event_id),
    lastEventId: nullable(row.last_event_id),
  };
}
function event(row: Row): CustodyEvent {
  return {
    id: String(row.id),
    assetId: String(row.asset_id),
    allocationId: String(row.allocation_id),
    allocationVersion: Number(row.allocation_version),
    kind: row.kind as CustodyAction,
    requestedBy: String(row.requested_by),
    approvedBy: nullable(row.approved_by),
    performedBy: nullable(row.performed_by),
    occurredOn: String(row.occurred_on),
    recordedAt: String(row.recorded_at),
    runId: String(row.run_id),
    stepId: String(row.step_id),
    operationKey: String(row.operation_key),
    snapshot: JSON.parse(String(row.snapshot_json)),
    snapshotHash: String(row.snapshot_hash),
  };
}
export class AssetCustody {
  constructor(private db: DatabaseSync) {}
  get(tenant: string, assetId: string, allocationId: string): Allocation {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_allocations WHERE tenant_id=? AND asset_id=? AND id=?",
      )
      .get(tenant, assetId, allocationId);
    if (!row)
      fail(
        "ALLOCATION_NOT_FOUND",
        "Nie znaleziono wskazanej alokacji urządzenia.",
        404,
      );
    return allocation(row);
  }
  rows(tenant: string, assetId: string): Allocation[] {
    return this.db
      .prepare(
        "SELECT * FROM ops_allocations WHERE tenant_id=? AND asset_id=? ORDER BY rowid",
      )
      .all(tenant, assetId)
      .map(allocation);
  }
  event(tenant: string, id: string): CustodyEvent | undefined {
    const row = this.db
      .prepare("SELECT * FROM ops_asset_events WHERE tenant_id=? AND id=?")
      .get(tenant, id);
    return row ? event(row) : undefined;
  }
  byOperation(ctx: ToolContext, assetId: string): CustodyEvent | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_asset_events WHERE tenant_id=? AND operation_key=? AND asset_id=?",
      )
      .get(ctx.tenantId, ctx.operationKey, assetId);
    return row ? event(row) : undefined;
  }
  history(tenant: string, assetId: string, limit = 50, offset = 0) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    )
      fail("INVALID_PAGE", "Niepoprawny zakres historii.", 400);
    return {
      events: this.db
        .prepare(
          "SELECT * FROM ops_asset_events WHERE tenant_id=? AND asset_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?",
        )
        .all(tenant, assetId, limit, offset)
        .map(event),
      totalEvents: Number(
        this.db
          .prepare(
            "SELECT count(*) AS n FROM ops_asset_events WHERE tenant_id=? AND asset_id=?",
          )
          .get(tenant, assetId)!.n,
      ),
      limit,
      offset,
    };
  }
  private assertEvent(e: CustodyEvent, current: Allocation) {
    if (
      digest(e.snapshot) !== e.snapshotHash ||
      canonical(e.snapshot.event) !==
        canonical({
          kind: e.kind,
          requestedBy: e.requestedBy,
          approvedBy: e.approvedBy,
          performedBy: e.performedBy,
          occurredOn: e.occurredOn,
          recordedAt: e.recordedAt,
          runId: e.runId,
          stepId: e.stepId,
          operationKey: e.operationKey,
        }) ||
      e.assetId !== current.assetId ||
      e.allocationId !== current.id ||
      e.allocationVersion !== e.snapshot.allocation.version ||
      e.snapshot.allocation.id !== current.id ||
      e.snapshot.allocation.assetId !== current.assetId ||
      e.snapshot.allocation.personId !== current.personId ||
      e.snapshot.allocation.employmentEpisodeId !==
        current.employmentEpisodeId ||
      e.snapshot.allocation.caseId !== current.caseId ||
      !e.requestedBy ||
      ((e.kind === "issue" || e.kind === "return") &&
        (e.performedBy !== e.requestedBy || !e.performedBy))
    )
      fail(
        "CUSTODY_STATE_INCONSISTENT",
        "Stan przekazania nie odpowiada zapisanej historii.",
      );
  }
  assertConsistent(tenant: string, current: Allocation): void {
    if (!current.lastEventId) {
      if (
        current.provenance !== "legacy" ||
        current.version !== 1 ||
        current.issueEventId ||
        current.returnEventId
      )
        fail("CUSTODY_STATE_INCONSISTENT", "Brak właściwej historii alokacji.");
      return;
    }
    const latest = this.event(tenant, current.lastEventId);
    if (!latest) fail("CUSTODY_STATE_INCONSISTENT", "Brak zdarzenia alokacji.");
    this.assertEvent(latest, current);
    if (
      canonical(latest.snapshot.allocation) !== canonical(current) ||
      latest.allocationVersion !== current.version
    )
      fail(
        "CUSTODY_STATE_INCONSISTENT",
        "Alokacja zmieniła się bez zdarzenia historii.",
      );
    const events = this.db
      .prepare(
        "SELECT * FROM ops_asset_events WHERE tenant_id=? AND allocation_id=? ORDER BY allocation_version",
      )
      .all(tenant, current.id)
      .map(event);
    const firstVersion = current.provenance === "p05" ? 1 : 2;
    if (events.length !== current.version - firstVersion + 1)
      fail(
        "CUSTODY_STATE_INCONSISTENT",
        "Historia alokacji jest niekompletna.",
      );
    events.forEach((item, index) => {
      this.assertEvent(item, current);
      if (item.allocationVersion !== firstVersion + index)
        fail(
          "CUSTODY_STATE_INCONSISTENT",
          "Historia alokacji ma nieprawidłową kolejność.",
        );
    });
    if (current.issueEventId) {
      const issued = this.event(tenant, current.issueEventId);
      if (
        !issued ||
        issued.kind !== "issue" ||
        issued.snapshot.allocation.status !== "issued" ||
        issued.snapshot.allocation.issuedOn !== current.issuedOn
      )
        fail(
          "CUSTODY_STATE_INCONSISTENT",
          "Brak zgodnego poświadczenia wydania.",
        );
      this.assertEvent(issued, current);
    }
    if (current.returnEventId) {
      const returned = this.event(tenant, current.returnEventId);
      if (
        !returned ||
        returned.kind !== "return" ||
        returned.snapshot.allocation.status !== "returned" ||
        returned.snapshot.allocation.returnedOn !== current.returnedOn
      )
        fail(
          "CUSTODY_STATE_INCONSISTENT",
          "Brak zgodnego poświadczenia zwrotu.",
        );
      this.assertEvent(returned, current);
    }
  }
  verify(tenant: string, assetId: string): boolean {
    try {
      this.rows(tenant, assetId).forEach((a) =>
        this.assertConsistent(tenant, a),
      );
      return true;
    } catch {
      return false;
    }
  }
  verifyCommitted(ctx: ToolContext, assetId: string): boolean {
    try {
      const e = this.byOperation(ctx, assetId);
      if (
        !e ||
        e.assetId !== assetId ||
        e.runId !== ctx.runId ||
        e.stepId !== ctx.stepId ||
        e.requestedBy !== ctx.actorId ||
        e.approvedBy !== (ctx.approvedBy ?? null)
      )
        return false;
      this.assertConsistent(
        ctx.tenantId,
        this.get(ctx.tenantId, assetId, e.allocationId),
      );
      return true;
    } catch {
      return false;
    }
  }
  verifyReplacement(
    ctx: ToolContext,
    sourceId: string,
    targetId: string,
  ): boolean {
    if (
      sourceId === targetId ||
      !this.verifyCommitted(ctx, sourceId) ||
      !this.verifyCommitted(ctx, targetId)
    )
      return false;
    const source = this.byOperation(ctx, sourceId)!,
      target = this.byOperation(ctx, targetId)!;
    const a = source.snapshot.allocation,
      b = target.snapshot.allocation;
    const count = this.db
      .prepare(
        "SELECT count(*) n FROM ops_asset_events WHERE tenant_id=? AND operation_key=?",
      )
      .get(ctx.tenantId, ctx.operationKey)!.n;
    return (
      count === 2 &&
      source.kind === "release" &&
      target.kind === "reserve" &&
      a.status === "released" &&
      b.status === "reserved" &&
      a.id !== b.id &&
      [
        "personId",
        "employmentEpisodeId",
        "caseId",
        "reservedUntil",
        "expiresAt",
        "timezone",
        "profileVersion",
      ].every(
        (key) => a[key as keyof Allocation] === b[key as keyof Allocation],
      )
    );
  }
  private append(
    ctx: ToolContext,
    asset: Entity,
    a: Allocation,
    kind: CustodyAction,
    now: string,
    occurredOn: string,
    note: string,
  ): CustodyEvent {
    if (!ctx.actorId)
      fail("ASSET_ACTOR_FORBIDDEN", "Brak tożsamości operatora sprzętu.", 403);
    const snapshot = {
      allocation: a,
      asset: {
        id: asset.id,
        version: asset.version + 1,
        status: asset.status,
        assetType: asset.data.assetType ?? null,
        serial: asset.data.serial ?? null,
        location: asset.data.location ?? null,
        condition: asset.data.condition ?? null,
      },
      note,
      event: {
        kind,
        requestedBy: ctx.actorId,
        approvedBy: ctx.approvedBy ?? null,
        performedBy: kind === "issue" || kind === "return" ? ctx.actorId : null,
        occurredOn,
        recordedAt: now,
        runId: ctx.runId,
        stepId: ctx.stepId,
        operationKey: ctx.operationKey,
      },
    };
    const e: CustodyEvent = {
      id: a.lastEventId!,
      assetId: asset.id,
      allocationId: a.id,
      allocationVersion: a.version,
      kind,
      requestedBy: ctx.actorId,
      approvedBy: ctx.approvedBy ?? null,
      performedBy: kind === "issue" || kind === "return" ? ctx.actorId : null,
      occurredOn,
      recordedAt: now,
      runId: ctx.runId,
      stepId: ctx.stepId,
      operationKey: ctx.operationKey,
      snapshot,
      snapshotHash: digest(snapshot),
    };
    this.db
      .prepare(
        "INSERT INTO ops_asset_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ctx.tenantId,
        e.id,
        e.assetId,
        e.allocationId,
        e.allocationVersion,
        kind,
        e.requestedBy,
        e.approvedBy,
        e.performedBy,
        occurredOn,
        now,
        e.runId,
        e.stepId,
        e.operationKey,
        canonical(snapshot),
        e.snapshotHash,
      );
    return e;
  }
  reserve(
    ctx: ToolContext,
    asset: Entity,
    input: JsonObject,
    now: string,
    timezone: string,
    profileVersion: number | null,
    pinnedExpiry?: string,
  ): CustodyEvent {
    if (asset.status !== "available")
      fail("INVALID_TRANSITION", "Urządzenie nie jest dostępne do rezerwacji.");
    const until = String(input.until),
      expiresAt = pinnedExpiry ?? reservationExpiresAt(until, timezone);
    if (Date.parse(now) >= Date.parse(expiresAt))
      fail("RESERVATION_EXPIRED", "Data rezerwacji jest w przeszłości.");
    if (asset.data.condition !== "good")
      fail(
        "ASSET_NOT_READY",
        "Niesprawne urządzenie nie może zostać zarezerwowane.",
      );
    if (
      this.db
        .prepare(
          "SELECT id FROM ops_allocations WHERE tenant_id=? AND asset_id=? AND status IN('reserved','issued')",
        )
        .get(ctx.tenantId, asset.id)
    )
      fail("ASSET_ALREADY_ALLOCATED", "Urządzenie ma aktywną alokację.");
    const id = randomUUID(),
      eventId = randomUUID();
    this.db
      .prepare(
        "INSERT INTO ops_allocations(tenant_id,id,asset_id,person_id,status,reserved_until,employment_episode_id,case_id,version,expires_at,timezone,profile_version,created_at,updated_at,provenance,last_event_id) VALUES(?,?,?,?,'reserved',?,?,?,1,?,?,?,?,?,'p05',?)",
      )
      .run(
        ctx.tenantId,
        id,
        asset.id,
        String(input.personId),
        until,
        String(input.employmentEpisodeId),
        String(input.caseId),
        expiresAt,
        timezone,
        profileVersion,
        now,
        now,
        eventId,
      );
    asset.status = "reserved";
    asset.data.reservationPurpose = String(input.purpose);
    return this.append(
      ctx,
      asset,
      this.get(ctx.tenantId, asset.id, id),
      "reserve",
      now,
      companyDay(now, timezone),
      String(input.purpose),
    );
  }
  transition(
    ctx: ToolContext,
    asset: Entity,
    kind: Exclude<CustodyAction, "reserve">,
    input: JsonObject,
    now: string,
    fallbackTimezone: string,
  ): CustodyEvent {
    const a = this.get(ctx.tenantId, asset.id, String(input.allocationId));
    if (a.version !== input.expectedAllocationVersion)
      fail(
        "ALLOCATION_VERSION_CONFLICT",
        "Alokacja zmieniła się. Odczytaj aktualną wersję.",
      );
    this.assertConsistent(ctx.tenantId, a);
    const timezone = a.timezone ?? fallbackTimezone,
      today = companyDay(now, timezone);
    const eventId = randomUUID();
    let issuedOn = a.issuedOn,
      returnedOn = a.returnedOn,
      issueEventId = a.issueEventId,
      returnEventId = a.returnEventId,
      nextStatus = a.status,
      occurredOn = today,
      note: string;
    if (kind === "issue") {
      if (asset.status !== "reserved" || a.status !== "reserved")
        fail("INVALID_TRANSITION", "Wydanie wymaga bieżącej rezerwacji.");
      if (
        a.provenance !== "p05" ||
        !a.expiresAt ||
        !a.employmentEpisodeId ||
        !a.caseId
      )
        fail(
          "LEGACY_ALLOCATION_UNRESOLVED",
          "Rezerwacja nie ma pełnego potwierdzonego zakresu. Zwolnij ją i przygotuj nową.",
        );
      if (a.personId !== input.personId)
        fail("WRONG_RECIPIENT", "Wydanie musi dotyczyć osoby z rezerwacji.");
      if (
        a.employmentEpisodeId !== input.employmentEpisodeId ||
        a.caseId !== input.caseId
      )
        fail(
          "RESOURCE_EPISODE_MISMATCH",
          "Wydanie nie dotyczy okresu i sprawy z rezerwacji.",
        );
      if (
        Date.parse(now) >= Date.parse(a.expiresAt) ||
        String(input.issuedOn) > a.reservedUntil
      )
        fail(
          "RESERVATION_EXPIRED",
          "Rezerwacja wygasła. Wydanie jest zablokowane.",
        );
      if (String(input.issuedOn) > today)
        fail("FUTURE_HANDOVER", "Nie można poświadczyć przyszłego wydania.");
      if (
        a.createdAt &&
        String(input.issuedOn) < companyDay(a.createdAt, timezone)
      )
        fail(
          "INVALID_HANDOVER_DATE",
          "Wydanie nie może poprzedzać rezerwacji.",
        );
      if (input.condition !== "good" || asset.data.condition !== "good")
        fail(
          "ASSET_NOT_READY",
          "Stan sprzętu wymaga wyjaśnienia przed wydaniem.",
        );
      nextStatus = "issued";
      issuedOn = String(input.issuedOn);
      issueEventId = eventId;
      occurredOn = issuedOn;
      note = String(input.handoverNote);
      asset.status = "issued";
      asset.data.location = String(input.location);
      asset.data.condition = "good";
      asset.data.handover = {
        note,
        confirmedBy: ctx.actorId!,
        confirmedAt: now,
        issueEventId: eventId,
      };
    } else if (kind === "return") {
      if (asset.status !== "issued" || a.status !== "issued")
        fail(
          "INVALID_TRANSITION",
          "Zwrot wymaga wskazanego wydanego urządzenia.",
        );
      if (String(input.returnedOn) > today)
        fail("FUTURE_RETURN", "Nie można poświadczyć przyszłego zwrotu.");
      if (a.issuedOn && String(input.returnedOn) < a.issuedOn)
        fail("INVALID_RETURN_DATE", "Zwrot nie może poprzedzać wydania.");
      nextStatus = "returned";
      returnedOn = String(input.returnedOn);
      returnEventId = eventId;
      occurredOn = returnedOn;
      note = String(input.receiptNote);
      asset.status = input.condition === "good" ? "available" : "maintenance";
      asset.data.location = String(input.location);
      asset.data.condition = String(input.condition);
      asset.data.returnReceipt = {
        note,
        confirmedBy: ctx.actorId!,
        confirmedAt: now,
        returnEventId: eventId,
      };
    } else {
      if (asset.status !== "reserved" || a.status !== "reserved")
        fail(
          "INVALID_TRANSITION",
          "Można zwolnić wyłącznie wskazaną rezerwację.",
        );
      if (kind === "expire") {
        if (!a.expiresAt)
          fail(
            "LEGACY_EXPIRY_UNRESOLVED",
            "Brak utrwalonego terminu. Użyj jawnego zwolnienia rezerwacji.",
          );
        if (Date.parse(now) < Date.parse(a.expiresAt))
          fail("RESERVATION_NOT_EXPIRED", "Rezerwacja jeszcze nie wygasła.");
      }
      nextStatus = "released";
      asset.status = "available";
      note = String(input.reason);
      asset.data.releaseReason = note;
    }
    if (kind === "issue" || kind === "return") {
      if (input.humanConfirmed !== true || !ctx.actorId)
        fail(
          "HUMAN_CONFIRMATION_REQUIRED",
          "Wymagane jawne poświadczenie wykonawcy.",
          403,
        );
    }
    const changed = this.db
      .prepare(
        "UPDATE ops_allocations SET status=?,issued_on=?,returned_on=?,version=version+1,updated_at=?,issue_event_id=?,return_event_id=?,last_event_id=? WHERE tenant_id=? AND asset_id=? AND id=? AND version=?",
      )
      .run(
        nextStatus,
        issuedOn,
        returnedOn,
        now,
        issueEventId,
        returnEventId,
        eventId,
        ctx.tenantId,
        asset.id,
        a.id,
        a.version,
      );
    if (changed.changes !== 1)
      fail("ALLOCATION_VERSION_CONFLICT", "Inna operacja zmieniła alokację.");
    return this.append(
      ctx,
      asset,
      this.get(ctx.tenantId, asset.id, a.id),
      kind,
      now,
      occurredOn,
      note,
    );
  }
}
export function readIssuedAllocationProof(
  db: DatabaseSync,
  tenant: string,
  selected: { assetId: string; allocationId: string; issueEventId: string },
): {
  title: string;
  version: number;
  revision: number | null;
  identity: JsonObject;
  hash: string;
} {
  const custody = new AssetCustody(db),
    a = custody.get(tenant, selected.assetId, selected.allocationId);
  custody.assertConsistent(tenant, a);
  const issue = custody.event(tenant, selected.issueEventId);
  if (
    !issue ||
    issue.kind !== "issue" ||
    a.issueEventId !== issue.id ||
    issue.allocationId !== a.id ||
    a.provenance !== "p05"
  )
    fail("ISSUANCE_PROOF_REQUIRED", "Brak właściwego poświadczenia wydania.");
  const asset = db
    .prepare(
      "SELECT * FROM ops_entities WHERE tenant_id=? AND id=? AND module='assets'",
    )
    .get(tenant, a.assetId);
  if (!asset)
    fail(
      "EVIDENCE_SOURCE_NOT_FOUND",
      "Brak urządzenia będącego źródłem dowodu.",
    );
  const data = JSON.parse(String(asset.data_json)) as JsonObject;
  const identity: JsonObject = {
    assetId: a.assetId,
    assetType: data.assetType ?? null,
    assetStatus: String(asset.status),
    allocationId: a.id,
    allocationVersion: a.version,
    personId: a.personId,
    employmentEpisodeId: a.employmentEpisodeId,
    caseId: a.caseId,
    status: a.status,
    issuedOn: a.issuedOn,
    returnedOn: a.returnedOn,
    issueEventId: issue.id,
    issueEventVersion: issue.allocationVersion,
    issueOccurredOn: issue.occurredOn,
    performedBy: issue.performedBy,
    requestedBy: issue.requestedBy,
    approvedBy: issue.approvedBy,
    provenance: a.provenance,
    currentCondition: data.condition ?? null,
    location: data.location ?? null,
    eventHash: issue.snapshotHash,
  };
  return {
    title: String(asset.title),
    version: Number(asset.version),
    revision: issue.allocationVersion,
    identity,
    hash: digest(identity),
  };
}
