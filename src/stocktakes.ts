import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "./contracts.js";
import { hash } from "./engine.js";
import { companyDay } from "./company-calendar.js";
import {
  stocktakeCreateSchema,
  stocktakePinsSchema,
} from "./stocktake-models.js";
import type { Entity } from "./workspace.js";

interface AssetPin {
  id: string;
  version: number;
  hash: string;
  title: string;
  serial: string;
  location: string;
  condition: string;
  status: string;
}
interface Authorship {
  actorId: string;
  approvedBy: string;
  runId: string;
  stepId: string;
  operationKey: string;
  at: string;
}
interface Observation extends Authorship {
  id: string;
  asset: AssetPin;
  present: boolean;
  location: string | null;
  condition: string | null;
  observedOn: string;
  note: string;
  hash: string;
}
interface Resolution extends Authorship {
  asset: AssetPin;
  observationId: string;
  observationHash: string;
  reason: string;
  hash: string;
}
interface Line {
  baseline: AssetPin;
  observation: Observation | null;
  discrepancy: { id: string; firstSeenAt: string; reasons: string[] } | null;
  resolution: Resolution | null;
}
interface State {
  kind: "stocktake";
  ownerPrincipalId: string;
  dueDate: string;
  note: string;
  timezone: string;
  profileVersion: number;
  startedOn: string;
  scopeRevision: number;
  lines: Line[];
  acceptance?: JsonObject;
  cancellation?: JsonObject;
  ownership?: JsonObject;
  revisionReason?: string;
}
export interface StocktakeServices {
  ctx: ToolContext;
  now: string;
  timezone: string;
  profileVersion: number;
  principal(id: string): Principal | undefined;
  asset(id: string): Entity;
  save(e: Entity): Entity;
  insert(title: string, data: JsonObject, status: string): Entity;
}
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as JsonObject;
function fail(
  message: string,
  code = "STOCKTAKE_CONFLICT",
  status = 409,
): never {
  throw new DomainError(code, message, status);
}
const data = (e: Entity) => e.data as unknown as State;
const pin = (e: Entity): AssetPin => ({
  id: e.id,
  version: e.version,
  hash: hash(e),
  title: e.title,
  serial: String(e.data.serial),
  location: String(e.data.location),
  condition: String(e.data.condition),
  status: e.status,
});
const signed = <T extends object>(v: T) => ({ ...v, hash: hash(v) });
const signatureValid = (v: { hash: string }) => {
  const { hash: stored, ...body } = v;
  return stored === hash(body);
};
const matches = (o: Observation, a: AssetPin) =>
  o.present && o.location === a.location && o.condition === a.condition;
export function stocktakeAuthority(s: StocktakeServices) {
  for (const [id, role] of [
    [s.ctx.actorId, "operator"],
    [s.ctx.approvedBy, "approver"],
  ] as const) {
    const p = id && s.principal(id);
    if (
      !p ||
      !p.roles.includes(role) ||
      !["assets", "inventory"].every(
        (scope) => p.scopes?.includes("*") || p.scopes?.includes(scope),
      )
    )
      fail(
        "Wymagany aktywny operator i zatwierdzający z dostępem do sprzętu oraz spisów.",
        "STOCKTAKE_AUTHORITY_REQUIRED",
        403,
      );
  }
}
const author = (s: StocktakeServices): Authorship => ({
  actorId: s.ctx.actorId!,
  approvedBy: s.ctx.approvedBy!,
  runId: s.ctx.runId,
  stepId: s.ctx.stepId,
  operationKey: s.ctx.operationKey,
  at: s.now,
});
function owner(s: StocktakeServices, id: string) {
  const p = s.principal(id);
  if (
    !p?.roles.includes("operator") ||
    !["assets", "inventory"].every(
      (scope) => p.scopes?.includes("*") || p.scopes?.includes(scope),
    )
  )
    fail(
      "Właściciel musi mieć aktywne konto operatora sprzętu i spisów.",
      "STOCKTAKE_OWNER_REQUIRED",
    );
}

/** Uses the shared entity/version/command transaction. Observations never mutate custody. */
export class Stocktakes {
  constructor(private readonly db: DatabaseSync) {}
  private fromRow(row: Record<string, unknown>): Entity {
    return {
      id: String(row.id),
      module: String(row.module) as Entity["module"],
      title: String(row.title),
      status: String(row.status),
      version: Number(row.version),
      data: JSON.parse(String(row.data_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
  private validPin(tenant: string, p: AssetPin) {
    const row = this.db
      .prepare(
        "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, p.id, p.version);
    if (!row || row.snapshot_hash !== p.hash) return false;
    const e = JSON.parse(String(row.snapshot_json)) as Entity;
    return (
      e.module === "assets" && hash(e) === p.hash && hash(pin(e)) === hash(p)
    );
  }
  verifySnapshot(tenant: string, e: Entity): boolean {
    try {
      const d = data(e);
      if (
        e.module !== "inventory" ||
        d.kind !== "stocktake" ||
        !["open", "accepted", "cancelled"].includes(e.status) ||
        !d.lines.length ||
        d.lines.length > 200 ||
        new Set(d.lines.map((l) => l.baseline.id)).size !== d.lines.length
      )
        return false;
      if (
        !d.ownerPrincipalId ||
        !d.dueDate ||
        !d.startedOn ||
        !Number.isInteger(d.scopeRevision) ||
        d.scopeRevision < 1
      )
        return false;
      for (const l of d.lines) {
        if (!this.validPin(tenant, l.baseline)) return false;
        if (
          l.observation &&
          (!signatureValid(l.observation) ||
            !this.validPin(tenant, l.observation.asset) ||
            l.observation.asset.id !== l.baseline.id ||
            !l.observation.actorId ||
            !l.observation.approvedBy)
        )
          return false;
        if (
          l.resolution &&
          (!signatureValid(l.resolution) ||
            !this.validPin(tenant, l.resolution.asset) ||
            l.resolution.asset.id !== l.baseline.id ||
            !l.observation ||
            l.resolution.observationId !== l.observation.id ||
            l.resolution.observationHash !== l.observation.hash ||
            !matches(l.observation, l.resolution.asset))
        )
          return false;
        if (
          l.discrepancy &&
          (!l.observation ||
            l.resolution ||
            !l.discrepancy.id ||
            !l.discrepancy.reasons.length)
        )
          return false;
      }
      if (
        e.status === "accepted" &&
        (!d.acceptance || d.lines.some((l) => !l.observation || l.discrepancy))
      )
        return false;
      return true;
    } catch {
      return false;
    }
  }
  read(tenant: string, id: string): Entity {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND id=? AND module='inventory'",
      )
      .get(tenant, id);
    if (!row) fail("Brak spisu w tej organizacji.", "ENTITY_NOT_FOUND", 404);
    const e = this.fromRow(row);
    this.assertCurrent(tenant, e);
    return e;
  }
  private assertCurrent(tenant: string, e: Entity) {
    const snapshot = this.db
      .prepare(
        "SELECT snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, e.id, e.version);
    const audit = this.db
      .prepare(
        "SELECT operation_key FROM ops_audit WHERE tenant_id=? AND entity_id=? AND entity_version=?",
      )
      .get(tenant, e.id, e.version);
    const ledger =
      audit &&
      this.db
        .prepare(
          "SELECT changes_json FROM ops_commands WHERE tenant_id=? AND operation_key=?",
        )
        .get(tenant, audit.operation_key!);
    const recorded =
      ledger &&
      (
        JSON.parse(String(ledger.changes_json)) as {
          id: string;
          version: number;
          hash: string;
        }[]
      ).some(
        (c) => c.id === e.id && c.version === e.version && c.hash === hash(e),
      );
    if (
      !snapshot ||
      snapshot.snapshot_hash !== hash(e) ||
      !recorded ||
      !this.verifySnapshot(tenant, e)
    )
      fail(
        "Spis nie odpowiada zapisanym wersjom i źródłom.",
        "STOCKTAKE_STATE_INCONSISTENT",
      );
  }
  holds(tenant: string, assetId: string) {
    const result: {
      stocktakeId: string;
      discrepancyId: string;
      ownerPrincipalId: string;
      dueDate: string;
      reasons: string[];
    }[] = [];
    // Check records before filtering. Corrupting a status cannot hide a known hold.
    for (const row of this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module='inventory'",
      )
      .all(tenant)) {
      const e = this.fromRow(row);
      this.assertCurrent(tenant, e);
      const d = data(e),
        l = d.lines.find((line) => line.baseline.id === assetId);
      if (l?.discrepancy)
        result.push({
          stocktakeId: e.id,
          discrepancyId: l.discrepancy.id,
          ownerPrincipalId: d.ownerPrincipalId,
          dueDate: d.dueDate,
          reasons: l.discrepancy.reasons,
        });
    }
    return result;
  }
  assertAvailable(tenant: string, assetId: string) {
    if (this.holds(tenant, assetId).length)
      fail(
        "Urządzenie ma niewyjaśnioną rozbieżność ze spisu. Najpierw wyjaśnij stan sprzętu.",
        "ASSET_INVENTORY_HOLD",
      );
  }
  occupancy(tenant: string) {
    const result: { assetId: string; stocktakeId: string }[] = [];
    for (const row of this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module='inventory'",
      )
      .all(tenant)) {
      const e = this.fromRow(row);
      this.assertCurrent(tenant, e);
      for (const l of data(e).lines)
        if (e.status === "open" || l.discrepancy)
          result.push({ assetId: l.baseline.id, stocktakeId: e.id });
    }
    return result;
  }
  list(
    tenant: string,
    page: { limit: number; offset: number; status?: string },
  ) {
    const where =
      "tenant_id=? AND module='inventory'" +
      (page.status ? " AND status=?" : "");
    const args = page.status ? [tenant, page.status] : [tenant];
    const items = this.db
      .prepare(
        `SELECT * FROM ops_entities WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, page.limit, page.offset)
      .map((row) => {
        const e = this.fromRow(row);
        this.assertCurrent(tenant, e);
        const d = data(e);
        return {
          id: e.id,
          title: e.title,
          status: e.status,
          version: e.version,
          ownerPrincipalId: d.ownerPrincipalId,
          dueDate: d.dueDate,
          assets: d.lines.length,
          observed: d.lines.filter((l) => l.observation).length,
          unresolved: d.lines.filter((l) => l.discrepancy).length,
        };
      });
    return {
      items,
      total: Number(
        this.db
          .prepare(`SELECT count(*) n FROM ops_entities WHERE ${where}`)
          .get(...args)!.n,
      ),
      limit: page.limit,
      offset: page.offset,
    };
  }
  private lines(
    s: StocktakeServices,
    raw: unknown,
    excludeId?: string,
  ): Line[] {
    const pins = stocktakePinsSchema.parse(raw);
    const existing = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module='inventory'",
      )
      .all(s.ctx.tenantId)
      .map((r) => this.fromRow(r));
    for (const e of existing) this.assertCurrent(s.ctx.tenantId, e);
    return pins.map((p) => {
      const asset = s.asset(p.id);
      if (asset.version !== p.expectedVersion || asset.status === "retired")
        fail(
          "Zakres spisu zmienił się albo urządzenie jest wycofane.",
          "STOCKTAKE_SCOPE_CHANGED",
        );
      for (const e of existing) {
        if (
          e.id !== excludeId &&
          data(e).lines.some(
            (l) =>
              l.baseline.id === p.id && (e.status === "open" || l.discrepancy),
          )
        )
          fail(
            "Urządzenie należy już do otwartego spisu lub ma niewyjaśnioną rozbieżność.",
            "STOCKTAKE_ALREADY_OPEN",
          );
      }
      return {
        baseline: pin(asset),
        observation: null,
        discrepancy: null,
        resolution: null,
      };
    });
  }
  create(s: StocktakeServices, title: string, raw: JsonObject) {
    stocktakeAuthority(s);
    const input = stocktakeCreateSchema.parse(raw);
    owner(s, input.ownerPrincipalId);
    const today = companyDay(s.now, s.timezone);
    if (input.profileVersion !== s.profileVersion)
      fail(
        "Konfiguracja firmy zmieniła się. Przygotuj zakres ponownie.",
        "PROFILE_VERSION_CONFLICT",
      );
    if (input.dueDate < today)
      fail("Termin spisu nie może poprzedzać otwarcia.");
    const d: State = {
      kind: "stocktake",
      ownerPrincipalId: input.ownerPrincipalId,
      dueDate: input.dueDate,
      note: input.note,
      timezone: s.timezone,
      profileVersion: s.profileVersion,
      startedOn: today,
      scopeRevision: 1,
      lines: this.lines(s, input.assetPins),
    };
    return s.insert(title, json(d), "open");
  }
  private requireOwner(s: StocktakeServices, e: Entity) {
    owner(s, data(e).ownerPrincipalId);
    if (s.ctx.actorId !== data(e).ownerPrincipalId)
      fail(
        "Ta decyzja należy do aktualnego właściciela spisu.",
        "STOCKTAKE_OWNER_REQUIRED",
        403,
      );
  }
  change(
    s: StocktakeServices,
    record: Entity,
    action: string,
    input: JsonObject,
  ) {
    stocktakeAuthority(s);
    const e = this.read(s.ctx.tenantId, record.id),
      d = data(e);
    if (e.version !== input.expectedVersion)
      fail("Spis zmienił się. Odczytaj bieżącą wersję.", "VERSION_CONFLICT");
    if (e.status === "accepted")
      fail(
        "Odebrany spis jest zamknięty. Nowe ustalenia wymagają nowego spisu.",
      );
    const today = companyDay(s.now, d.timezone);
    if (action === "assignStocktakeOwner") {
      owner(s, String(input.ownerPrincipalId));
      if (String(input.dueDate) < today)
        fail("Nowy termin nie może być w przeszłości.");
      d.ownership = json({
        ...author(s),
        previousOwner: d.ownerPrincipalId,
        previousDueDate: d.dueDate,
        reason: input.reason,
      });
      d.ownerPrincipalId = String(input.ownerPrincipalId);
      d.dueDate = String(input.dueDate);
    } else if (action === "cancelStocktake") {
      this.requireOwner(s, e);
      if (e.status !== "open") fail("Spis jest już anulowany.");
      d.cancellation = json({ ...author(s), reason: input.reason });
      e.status = "cancelled";
    } else if (action === "reviseStocktake") {
      this.requireOwner(s, e);
      if (e.status !== "open" || d.lines.some((l) => l.observation))
        fail(
          "Zakres można zmienić tylko przed pierwszą obserwacją. Ustalenia pozostają w obecnym spisie.",
        );
      d.lines = this.lines(s, input.assetPins, e.id);
      d.scopeRevision++;
      d.revisionReason = String(input.reason);
    } else if (action === "acceptStocktake") {
      this.requireOwner(s, e);
      const report = this.report(s, e);
      if (
        e.status !== "open" ||
        !report.ready ||
        report.hash !== input.reportHash
      )
        fail(
          "Odbiór wymaga aktualnego raportu, wszystkich obserwacji i wyjaśnionych rozbieżności.",
          "STOCKTAKE_NOT_READY",
        );
      d.acceptance = json({
        ...author(s),
        reportHash: report.hash,
        scopeRevision: d.scopeRevision,
        note: input.note,
      });
      e.status = "accepted";
    } else {
      const line = d.lines.find((l) => l.baseline.id === input.assetId);
      if (!line)
        fail(
          "Urządzenie nie należy do zakresu spisu.",
          "STOCKTAKE_ASSET_NOT_FOUND",
        );
      const asset = s.asset(String(input.assetId)),
        current = pin(asset);
      const allocations = Array.isArray(asset.data.allocations)
        ? (asset.data.allocations as JsonObject[])
        : [];
      const lastRegister = asset.data.lastRegisterAction as
        JsonObject | undefined;
      const physicalDays = [
        companyDay(asset.createdAt, d.timezone),
        ...allocations.flatMap((a) => [a.issuedOn, a.returnedOn]),
        lastRegister?.occurredOn ??
          (typeof lastRegister?.recordedAt === "string"
            ? companyDay(lastRegister.recordedAt, d.timezone)
            : null),
      ].filter((v): v is string => typeof v === "string");
      if (asset.version !== input.expectedAssetVersion)
        fail(
          "Ewidencja urządzenia zmieniła się. Sprawdź aktualne dane.",
          "ASSET_VERSION_CONFLICT",
        );
      if (e.status === "cancelled" && !line.discrepancy)
        fail(
          "Anulowany spis pozwala tylko wyjaśniać wcześniej zapisane rozbieżności.",
        );
      if (action === "recordObservation") {
        const observedOn = String(input.observedOn);
        if (
          physicalDays.some((day) => observedOn < day) ||
          observedOn < d.startedOn ||
          observedOn > today ||
          (line.observation && observedOn < line.observation.observedOn)
        )
          fail(
            "Data obserwacji musi przypadać po otwarciu i ostatniej obserwacji, najpóźniej w bieżącym dniu firmy.",
            "INVALID_OBSERVATION_DATE",
          );
        const o: Observation = signed({
          ...author(s),
          id: randomUUID(),
          asset: current,
          present: input.present === true,
          location: typeof input.location === "string" ? input.location : null,
          condition:
            typeof input.condition === "string" ? input.condition : null,
          observedOn,
          note: String(input.note),
        });
        const reasons: string[] = [];
        if (!o.present) reasons.push("Nie odnaleziono urządzenia.");
        else {
          if (
            o.location !== line.baseline.location ||
            o.location !== current.location
          )
            reasons.push("Obserwowana lokalizacja różni się od ewidencji.");
          if (
            o.condition !== line.baseline.condition ||
            o.condition !== current.condition
          )
            reasons.push("Obserwowany stan techniczny różni się od ewidencji.");
        }
        if (current.hash !== line.baseline.hash)
          reasons.push("Ewidencja zmieniła się od otwarcia spisu.");
        if (line.discrepancy && !reasons.length)
          reasons.push(
            "Nowa obserwacja wymaga decyzji o zamknięciu wcześniejszej rozbieżności.",
          );
        line.observation = o;
        line.resolution = null;
        line.discrepancy = reasons.length
          ? {
              id: line.discrepancy?.id ?? randomUUID(),
              firstSeenAt: line.discrepancy?.firstSeenAt ?? s.now,
              reasons,
            }
          : null;
      } else if (action === "resolveDiscrepancy") {
        this.requireOwner(s, e);
        const o = line.observation;
        if (
          !line.discrepancy ||
          !o ||
          o.id !== input.observationId ||
          o.hash !== input.observationHash ||
          physicalDays.some((day) => o.observedOn < day) ||
          !matches(o, current)
        )
          fail(
            "Wyjaśnienie wymaga aktualnej obserwacji znalezionego sprzętu zgodnej z konkretną wersją ewidencji.",
            "STOCKTAKE_RESOLUTION_REQUIRED",
          );
        line.resolution = signed({
          ...author(s),
          asset: current,
          observationId: o.id,
          observationHash: o.hash,
          reason: String(input.reason),
        });
        line.discrepancy = null;
      } else fail("Nieobsługiwana operacja spisu.");
    }
    e.data = json(d);
    return s.save(e);
  }
  report(s: StocktakeServices, e: Entity) {
    const d = data(e);
    const lines = d.lines.map((line) => {
      const current = pin(s.asset(line.baseline.id)),
        receipt = line.resolution?.asset ?? line.observation?.asset;
      const stale = Boolean(receipt && receipt.hash !== current.hash);
      return {
        ...line,
        current,
        stale,
        ready: Boolean(
          line.observation &&
          !line.discrepancy &&
          !stale &&
          matches(line.observation, current),
        ),
      };
    });
    const body = {
      stocktakeId: e.id,
      scopeRevision: d.scopeRevision,
      ownerPrincipalId: d.ownerPrincipalId,
      dueDate: d.dueDate,
      lines,
    };
    return {
      ...body,
      hash: hash(body),
      ready: e.status === "open" && lines.every((l) => l.ready),
      overdue: e.status === "open" && d.dueDate < companyDay(s.now, d.timezone),
      observed: lines.filter((l) => l.observation).length,
      unresolved: lines.filter((l) => l.discrepancy).length,
    };
  }
  history(tenant: string, id: string, limit: number, offset: number) {
    this.read(tenant, id);
    const rows = this.db
      .prepare(
        "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? ORDER BY version DESC LIMIT ? OFFSET ?",
      )
      .all(tenant, id, limit, offset);
    const items = rows.map((r) => {
      const e = JSON.parse(String(r.snapshot_json)) as Entity;
      if (hash(e) !== r.snapshot_hash || !this.verifySnapshot(tenant, e))
        fail(
          "Historia spisu nie odpowiada zapisanym źródłom.",
          "STOCKTAKE_STATE_INCONSISTENT",
        );
      const audit = this.db
        .prepare(
          "SELECT actor_id,run_id,tool_id,operation_key FROM ops_audit WHERE tenant_id=? AND entity_id=? AND entity_version=?",
        )
        .get(tenant, id, e.version);
      const ledger =
        audit &&
        this.db
          .prepare(
            "SELECT changes_json FROM ops_commands WHERE tenant_id=? AND operation_key=?",
          )
          .get(tenant, audit.operation_key!);
      if (
        !audit ||
        !ledger ||
        !(
          JSON.parse(String(ledger.changes_json)) as {
            id: string;
            version: number;
            hash: string;
          }[]
        ).some(
          (c) =>
            c.id === id &&
            c.version === e.version &&
            c.hash === r.snapshot_hash,
        )
      )
        fail(
          "Brak źródłowej komendy historii spisu.",
          "STOCKTAKE_STATE_INCONSISTENT",
        );
      return {
        record: e,
        actorId: String(audit.actor_id),
        runId: String(audit.run_id),
        toolId: String(audit.tool_id),
      };
    });
    return {
      items,
      total: Number(
        this.db
          .prepare(
            "SELECT count(*) n FROM ops_entity_versions WHERE tenant_id=? AND entity_id=?",
          )
          .get(tenant, id)!.n,
      ),
      limit,
      offset,
    };
  }
  requireCommitted(
    tenant: string,
    changes: { id: string; version: number; hash: string }[],
  ) {
    if (!changes.length)
      fail("Brak zapisanego skutku spisu.", "STOCKTAKE_STATE_INCONSISTENT");
    for (const c of changes) {
      this.read(tenant, c.id);
      const row = this.db
        .prepare(
          "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
        )
        .get(tenant, c.id, c.version);
      if (
        !row ||
        row.snapshot_hash !== c.hash ||
        hash(JSON.parse(String(row.snapshot_json))) !== c.hash ||
        !this.verifySnapshot(tenant, JSON.parse(String(row.snapshot_json)))
      )
        fail(
          "Zapisany skutek spisu jest niespójny.",
          "STOCKTAKE_STATE_INCONSISTENT",
        );
    }
  }
}
