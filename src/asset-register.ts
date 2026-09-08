import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { DomainError, type ToolContext } from "./contracts.js";
import type { Entity } from "./workspace.js";

type Row = Record<string, unknown>;
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
export interface AssetRegisterEvent {
  id: string;
  assetId: string;
  assetVersion: number;
  toolId: string;
  requestedBy: string;
  approvedBy: string | null;
  recordedAt: string;
  runId: string;
  stepId: string;
  operationKey: string;
  previousEventId: string | null;
  previousEventHash: string | null;
  snapshotHash: string;
}
export function migrateAssetRegister(db: DatabaseSync) {
  db.exec(`CREATE TABLE ops_asset_register_events(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_version INTEGER NOT NULL,
    event_json TEXT NOT NULL,event_hash TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,asset_id,asset_version),
    FOREIGN KEY(tenant_id,asset_id,asset_version) REFERENCES ops_entity_versions(tenant_id,entity_id,version));
    CREATE INDEX ops_asset_register_history ON ops_asset_register_events(tenant_id,asset_id,asset_version);`);
}
/** Administrative history. Physical handovers keep their separate custody proofs. */
export class AssetRegister {
  constructor(private db: DatabaseSync) {}
  prepare(entity: Entity) {
    if (entity.module !== "assets") return;
    // No fabricated history for pre-migration versions.
    entity.data.registerHistoryFromVersion ??= entity.version;
  }
  record(ctx: ToolContext, toolId: string, entity: Entity) {
    if (entity.module !== "assets") return;
    const previous = this.db
      .prepare(
        "SELECT id,event_hash FROM ops_asset_register_events WHERE tenant_id=? AND asset_id=? ORDER BY asset_version DESC LIMIT 1",
      )
      .get(ctx.tenantId, entity.id) as Row | undefined;
    const event: AssetRegisterEvent = {
      id: randomUUID(),
      assetId: entity.id,
      assetVersion: entity.version,
      toolId,
      requestedBy: ctx.actorId!,
      approvedBy: ctx.approvedBy ?? null,
      recordedAt: entity.updatedAt,
      runId: ctx.runId,
      stepId: ctx.stepId,
      operationKey: ctx.operationKey,
      previousEventId: previous ? String(previous.id) : null,
      previousEventHash: previous ? String(previous.event_hash) : null,
      snapshotHash: digest(entity),
    };
    this.db
      .prepare("INSERT INTO ops_asset_register_events VALUES(?,?,?,?,?,?,?,?)")
      .run(
        ctx.tenantId,
        event.id,
        entity.id,
        entity.version,
        canonical(event),
        digest(event),
        event.requestedBy,
        event.approvedBy,
      );
  }
  verify(tenant: string, entity: Entity): boolean {
    const first = entity.data.registerHistoryFromVersion;
    const rows = this.db
      .prepare(
        "SELECT * FROM ops_asset_register_events WHERE tenant_id=? AND asset_id=? ORDER BY asset_version",
      )
      .all(tenant, entity.id) as Row[];
    if (first === undefined) return rows.length === 0;
    if (
      typeof first !== "number" ||
      !Number.isInteger(first) ||
      first < 1 ||
      first > entity.version ||
      rows.length !== entity.version - first + 1
    )
      return false;
    let previous: Row | undefined;
    try {
      for (const [index, row] of rows.entries()) {
        const event = JSON.parse(String(row.event_json)) as AssetRegisterEvent;
        const version = this.db
          .prepare(
            "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
          )
          .get(tenant, entity.id, first + index) as Row | undefined;
        if (!version) return false;
        const snapshot = JSON.parse(String(version.snapshot_json)) as Entity;
        if (
          event.requestedBy !== row.requested_by ||
          event.approvedBy !== row.approved_by ||
          event.id !== row.id ||
          event.assetId !== entity.id ||
          event.assetVersion !== first + index ||
          event.assetVersion !== row.asset_version ||
          digest(event) !== row.event_hash ||
          event.previousEventId !== (previous ? previous.id : null) ||
          event.previousEventHash !== (previous ? previous.event_hash : null) ||
          event.snapshotHash !== version.snapshot_hash ||
          digest(snapshot) !== event.snapshotHash ||
          snapshot.data.registerHistoryFromVersion !== first ||
          snapshot.updatedAt !== event.recordedAt
        )
          return false;
        const audit = this.db
          .prepare(
            "SELECT 1 FROM ops_audit WHERE tenant_id=? AND entity_id=? AND entity_version=? AND tool_id=? AND actor_id=? AND operation_key=? AND run_id=? AND step_id=?",
          )
          .get(
            tenant,
            entity.id,
            event.assetVersion,
            event.toolId,
            event.requestedBy,
            event.operationKey,
            event.runId,
            event.stepId,
          );
        if (!audit) return false;
        if (index === rows.length - 1 && event.snapshotHash !== digest(entity))
          return false;
        previous = row;
      }
      return true;
    } catch {
      return false;
    }
  }
  verifyCommitted(ctx: ToolContext, assetId: string): boolean {
    const rows = this.db
      .prepare(
        "SELECT event_json,event_hash FROM ops_asset_register_events WHERE tenant_id=? AND asset_id=? AND json_extract(event_json,'$.operationKey')=?",
      )
      .all(ctx.tenantId, assetId, ctx.operationKey) as Row[];
    return (
      rows.length > 0 &&
      rows.every((row) => {
        try {
          const e = JSON.parse(String(row.event_json)) as AssetRegisterEvent;
          return (
            digest(e) === row.event_hash &&
            e.requestedBy === ctx.actorId &&
            e.approvedBy === (ctx.approvedBy ?? null) &&
            e.runId === ctx.runId &&
            e.stepId === ctx.stepId
          );
        } catch {
          return false;
        }
      })
    );
  }
  history(tenant: string, assetId: string, limit = 50, offset = 0) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1_000_000
    )
      throw new DomainError(
        "INVALID_PAGE",
        "Niepoprawna strona historii.",
        400,
      );
    const total = Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM ops_asset_register_events WHERE tenant_id=? AND asset_id=?",
        )
        .get(tenant, assetId)!.n,
    );
    const events = (
      this.db
        .prepare(
          "SELECT event_json FROM ops_asset_register_events WHERE tenant_id=? AND asset_id=? ORDER BY asset_version DESC LIMIT ? OFFSET ?",
        )
        .all(tenant, assetId, limit, offset) as Row[]
    ).map((row) => {
      const event = JSON.parse(String(row.event_json)) as AssetRegisterEvent;
      const stored = this.db
        .prepare(
          "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
        )
        .get(tenant, assetId, event.assetVersion) as Row | undefined;
      const snapshot = stored
        ? (JSON.parse(String(stored.snapshot_json)) as Entity)
        : undefined;
      const valid =
        snapshot &&
        digest(snapshot) === event.snapshotHash &&
        stored?.snapshot_hash === event.snapshotHash;
      const last = snapshot?.data.lastRegisterAction;
      return {
        ...event,
        state: valid
          ? {
              status: snapshot.status,
              location: snapshot.data.location ?? null,
              condition: snapshot.data.condition ?? null,
              custodianPrincipalId: snapshot.data.custodianPrincipalId ?? null,
            }
          : null,
        attestation:
          valid &&
          last &&
          typeof last === "object" &&
          !Array.isArray(last) &&
          last.action === event.toolId.split(".").at(-1)
            ? last
            : null,
      };
    });
    return { events, total, limit, offset };
  }
}
