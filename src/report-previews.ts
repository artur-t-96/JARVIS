import type { DatabaseSync } from "node:sqlite";
import { DomainError, type JsonObject, type ToolContext } from "./contracts.js";
import { hash } from "./engine.js";
import {
  readReportSnapshot,
  type OperationalReportSnapshot,
} from "./operational-reports.js";
type Row = Record<string, unknown>;
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
export function migrateReportPreviews(db: DatabaseSync) {
  db.exec(`CREATE TABLE ops_report_previews(
    tenant_id TEXT NOT NULL, id TEXT NOT NULL, requested_by TEXT NOT NULL,
    snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL, operation_key TEXT, document_id TEXT,
    PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,document_id) REFERENCES ops_entities(tenant_id,id),
    CHECK((operation_key IS NULL) = (document_id IS NULL))
  ); CREATE INDEX ops_report_preview_expiry ON ops_report_previews(tenant_id,expires_at) WHERE operation_key IS NULL;`);
}
/** Bounded private drafts. Publishing and its domain receipt use the same SQLite transaction. */
export class ReportPreviews {
  constructor(private readonly db: DatabaseSync) {}
  stage(
    tenant: string,
    actor: string,
    id: string,
    snapshot: OperationalReportSnapshot,
    now: string,
  ) {
    const previous = this.db
      .prepare("SELECT id FROM ops_report_previews WHERE tenant_id=? AND id=?")
      .get(tenant, id);
    if (previous) {
      const saved = this.read(tenant, id);
      if (
        saved.requestedBy !== actor ||
        saved.snapshot.previewHash !== snapshot.previewHash
      )
        fail(
          "REPORT_PREVIEW_CONFLICT",
          "Identyfikator podglądu jest już związany z innym zakresem.",
        );
      return saved;
    }
    this.db
      .prepare(
        "DELETE FROM ops_report_previews WHERE tenant_id=? AND operation_key IS NULL AND expires_at < ?",
      )
      .run(tenant, now);
    const count = Number(
      this.db
        .prepare(
          "SELECT count(*) AS n FROM ops_report_previews WHERE tenant_id=? AND operation_key IS NULL",
        )
        .get(tenant)!.n,
    );
    if (count >= 100)
      fail(
        "REPORT_PREVIEW_LIMIT",
        "Osiągnięto limit 100 otwartych podglądów raportów. Zakończ istniejące zlecenia lub zaczekaj na wygaśnięcie szkiców.",
      );
    this.db
      .prepare(
        "INSERT INTO ops_report_previews(tenant_id,id,requested_by,snapshot_json,snapshot_hash,expires_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        tenant,
        id,
        actor,
        JSON.stringify(snapshot),
        hash(snapshot),
        new Date(Date.parse(now) + 7 * 86400_000).toISOString(),
      );
    return this.read(tenant, id);
  }
  read(tenant: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM ops_report_previews WHERE tenant_id=? AND id=?")
      .get(tenant, id) as Row | undefined;
    if (!row)
      fail(
        "REPORT_PREVIEW_NOT_FOUND",
        "Podgląd raportu jest niedostępny lub wygasł. Przygotuj nowy podgląd.",
        404,
      );
    const snapshot = readReportSnapshot(
      tenant,
      JSON.parse(String(row.snapshot_json)),
    );
    if (hash(snapshot) !== row.snapshot_hash)
      fail(
        "REPORT_PREVIEW_INCONSISTENT",
        "Podgląd raportu nie odpowiada zapisanej sumie.",
      );
    return {
      id,
      requestedBy: String(row.requested_by),
      snapshot,
      expiresAt: String(row.expires_at),
      documentId: row.document_id ? String(row.document_id) : null,
      operationKey: row.operation_key ? String(row.operation_key) : null,
    };
  }
  input(tenant: string, input: JsonObject) {
    const saved = this.read(tenant, String(input.previewId));
    if (
      saved.snapshot.previewHash !== input.previewHash ||
      hash(saved.snapshot.definition) !== hash(input.definition) ||
      saved.snapshot.profileVersion !== input.profileVersion
    )
      fail(
        "REPORT_PREVIEW_MISMATCH",
        "Plan nie odpowiada zapisanemu podglądowi raportu.",
      );
    return saved;
  }
  requirePending(ctx: ToolContext, input: JsonObject, now: string) {
    const saved = this.input(ctx.tenantId, input);
    if (saved.requestedBy !== ctx.actorId)
      fail(
        "REPORT_AUTHOR_FORBIDDEN",
        "Podgląd należy do innego autora zlecenia.",
        403,
      );
    if (saved.operationKey)
      fail(
        "REPORT_PREVIEW_USED",
        "Ten podgląd został już zapisany jako dokument.",
      );
    if (saved.expiresAt <= now)
      fail(
        "REPORT_PREVIEW_EXPIRED",
        "Podgląd wygasł. Przygotuj nowy podgląd i zgodę.",
      );
    return saved.snapshot;
  }
  publish(ctx: ToolContext, input: JsonObject, documentId: string) {
    const result = this.db
      .prepare(
        "UPDATE ops_report_previews SET operation_key=?, document_id=? WHERE tenant_id=? AND id=? AND operation_key IS NULL",
      )
      .run(ctx.operationKey, documentId, ctx.tenantId, String(input.previewId));
    if (Number(result.changes) !== 1)
      fail("REPORT_PREVIEW_USED", "Ten podgląd został już wykorzystany.");
  }
}
