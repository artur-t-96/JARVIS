import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "./contracts.js";
import { hash } from "./engine.js";
import { companyDay } from "./company-calendar.js";
import {
  assetImportCommandSchema,
  assetImportPrepareSchema,
  assetImportPreviewSchema,
  decodeAssetCsv,
  parseAssetCsv,
  type AssetImportCommand,
  type ImportedAssetValues,
} from "./asset-import-csv.js";
import {
  AssetImportFiles,
  type AssetImportFileReference,
} from "./asset-import-files.js";
import { equipmentSerialKey } from "./purchase-delivery-models.js";
import type { Entity } from "./workspace.js";

export interface AssetImportServices {
  ctx: ToolContext;
  now: string;
  timezone: string;
  profileVersion: number;
  principal(id: string): Principal | undefined;
  matchingAssets(serialKeys: string[]): Entity[];
  create(values: ImportedAssetValues, provenance: JsonObject): Entity;
}
interface CreatedLine {
  sourceRow: number;
  firstLine: number;
  lastLine: number;
  id: string;
  version: number;
  hash: string;
  title: string;
  serial: string;
}
export interface AssetImportReceipt {
  formatVersion: 1;
  id: string;
  tenantId: string;
  operationKey: string;
  runId: string;
  stepId: string;
  actorId: string;
  approvedBy: string;
  importedAt: string;
  source: AssetImportFileReference;
  created: CreatedLine[];
  skippedRows: number[];
  hash: string;
}
function fail(
  message: string,
  code = "ASSET_IMPORT_CONFLICT",
  status = 409,
): never {
  throw new DomainError(code, message, status);
}
export function migrateAssetImports(db: DatabaseSync) {
  db.exec(`CREATE TABLE ops_asset_imports (
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,operation_key TEXT NOT NULL,
    imported_at TEXT NOT NULL,receipt_json TEXT NOT NULL,receipt_hash TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,operation_key));
    CREATE INDEX ops_asset_import_history ON ops_asset_imports(tenant_id,imported_at,id);`);
}
export function assetImportAuthority(s: AssetImportServices) {
  for (const [id, role] of [
    [s.ctx.actorId, "operator"],
    [s.ctx.approvedBy, "approver"],
  ] as const) {
    const p = id && s.principal(id);
    if (
      !p ||
      p.tenantId !== s.ctx.tenantId ||
      !p.roles.includes(role) ||
      !(p.scopes?.includes("*") || p.scopes?.includes("assets"))
    )
      fail(
        "Import wymaga aktywnego operatora i zatwierdzającego z dostępem do sprzętu.",
        "ASSET_IMPORT_AUTHORITY_REQUIRED",
        403,
      );
  }
}
const commandFrom = (r: AssetImportFileReference): AssetImportCommand =>
  assetImportCommandSchema.parse({
    uploadId: r.id,
    manifestHash: r.manifestHash,
    previewHash: r.previewHash,
    sha256: r.source.sha256,
    filename: r.source.filename,
    sourceName: r.source.sourceName,
    observedOn: r.source.observedOn,
    parserVersion: r.source.parserVersion,
    bytes: r.source.bytes,
    selectedRows: r.selectedRows,
    profileVersion: r.profileVersion,
    expiresAt: r.expiresAt,
    note: r.note,
  });
function provenance(
  r: AssetImportFileReference,
  row: { sourceRow: number; firstLine: number; lastLine: number },
): JsonObject {
  return {
    importId: r.id,
    sourceName: r.source.sourceName,
    observedOn: r.source.observedOn,
    filename: r.source.filename,
    sha256: r.source.sha256,
    manifestHash: r.manifestHash,
    sourceRow: row.sourceRow,
    firstLine: row.firstLine,
    lastLine: row.lastLine,
    custody: "not_imported",
  };
}

/** One approved batch shares the existing entity, register, ledger and outbox transaction. */
export class AssetImports {
  constructor(
    private readonly db: DatabaseSync,
    private readonly files: AssetImportFiles,
  ) {}
  preview(s: AssetImportServices, raw: unknown) {
    const input = assetImportPreviewSchema.parse(raw),
      { contentBase64, ...source } = input;
    const parsed = parseAssetCsv(decodeAssetCsv(contentBase64), source);
    if (source.observedOn > companyDay(s.now, s.timezone))
      fail(
        "Data źródła nie może być przyszła.",
        "ASSET_IMPORT_FUTURE_SOURCE",
        400,
      );
    const keys = [
      ...new Set(
        parsed.rows.flatMap((r) => (r.serialKey ? [r.serialKey] : [])),
      ),
    ];
    const existing = s.matchingAssets(keys);
    const rows = parsed.rows.map((row) => {
      const matches = existing
        .filter(
          (e) => equipmentSerialKey(String(e.data.serial)) === row.serialKey,
        )
        .map((e) => ({
          id: e.id,
          version: e.version,
          title: e.title,
          serial: String(e.data.serial),
          status: e.status,
          hash: hash(e),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return {
        ...row,
        existing: matches,
        eligible:
          !!row.asset &&
          !row.errors.length &&
          !matches.length &&
          !parsed.mappingErrors.length,
      };
    });
    const preview = {
      ...parsed,
      rows,
      profileVersion: s.profileVersion,
      timezone: s.timezone,
      counts: {
        total: rows.length,
        eligible: rows.filter((r) => r.eligible).length,
        existing: rows.filter((r) => r.existing.length).length,
        invalid: rows.filter((r) => r.errors.length).length,
      },
    };
    return {
      ...preview,
      previewHash: hash({ tenantId: s.ctx.tenantId, ...preview }),
    };
  }
  prepare(s: AssetImportServices, p: Principal, raw: unknown) {
    if (!p.roles.includes("operator"))
      fail(
        "Przygotowanie importu wymaga operatora.",
        "ASSET_IMPORT_AUTHORITY_REQUIRED",
        403,
      );
    const input = assetImportPrepareSchema.parse(raw);
    const {
      uploadId,
      previewHash,
      selectedRows,
      profileVersion,
      note,
      ...source
    } = input;
    const preview = this.preview(s, source);
    this.selection(preview, selectedRows);
    if (
      previewHash !== preview.previewHash ||
      profileVersion !== s.profileVersion
    )
      fail(
        "Podgląd lub profil firmy zmienił się. Sprawdź plik ponownie.",
        "ASSET_IMPORT_PREVIEW_CHANGED",
      );
    if (
      this.db
        .prepare("SELECT 1 FROM ops_asset_imports WHERE tenant_id=? AND id=?")
        .get(p.tenantId, uploadId)
    )
      fail(
        "Ten plik ma już zapisany import. Otwórz jego historię.",
        "ASSET_IMPORT_ALREADY_APPLIED",
      );
    const reference = this.files.stage(
      p,
      uploadId,
      decodeAssetCsv(input.contentBase64),
      {
        source: preview.source,
        previewHash,
        selectedRows: [...selectedRows].sort((a, b) => a - b),
        profileVersion,
        timezone: s.timezone,
        note,
      },
    );
    return commandFrom(reference);
  }
  private selection(
    preview: ReturnType<AssetImports["preview"]>,
    selected: number[],
  ) {
    if (
      preview.mappingErrors.length ||
      selected.some(
        (n) => !preview.rows.find((r) => r.sourceRow === n)?.eligible,
      )
    )
      fail(
        "Wybrana partia zawiera błędny lub istniejący wiersz. Popraw mapowanie i wybór.",
        "ASSET_IMPORT_SELECTION_INVALID",
      );
  }
  proposal(s: AssetImportServices, actorId: string, raw: unknown) {
    const input = assetImportCommandSchema.parse(raw);
    if (
      this.db
        .prepare("SELECT 1 FROM ops_asset_imports WHERE tenant_id=? AND id=?")
        .get(s.ctx.tenantId, input.uploadId)
    ) {
      const report = this.report(s.ctx.tenantId, input.uploadId);
      if (
        hash(commandFrom(report.source)) !== hash(input) ||
        report.actorId !== actorId
      )
        fail(
          "Import nie odpowiada temu wykonaniu.",
          "ASSET_IMPORT_SCOPE_CHANGED",
        );
      return { status: "applied" as const, report };
    }
    const { reference, body } = this.files.staged(
      s.ctx.tenantId,
      actorId,
      input.uploadId,
    );
    if (hash(commandFrom(reference)) !== hash(input))
      fail("Plik nie odpowiada temu wykonaniu.", "ASSET_IMPORT_SCOPE_CHANGED");
    const {
      parserVersion: _,
      bytes: __,
      sha256: ___,
      ...source
    } = reference.source;
    const preview = this.preview(s, {
      ...source,
      contentBase64: body.toString("base64"),
    });
    return {
      status: "pending" as const,
      preview,
      selectedRows: reference.selectedRows,
      note: reference.note,
      expiresAt: reference.expiresAt,
      current:
        preview.previewHash === input.previewHash &&
        Date.parse(reference.expiresAt) > Date.parse(s.now),
    };
  }
  apply(s: AssetImportServices, raw: unknown) {
    assetImportAuthority(s);
    const input = assetImportCommandSchema.parse(raw);
    if (
      this.db
        .prepare("SELECT 1 FROM ops_asset_imports WHERE tenant_id=? AND id=?")
        .get(s.ctx.tenantId, input.uploadId)
    )
      fail(
        "To źródło zostało już zapisane w innej operacji.",
        "ASSET_IMPORT_ALREADY_APPLIED",
      );
    const { reference, body } = this.files.staged(
      s.ctx.tenantId,
      s.ctx.actorId!,
      input.uploadId,
    );
    if (hash(commandFrom(reference)) !== hash(input))
      fail(
        "Plan nie odpowiada przygotowanemu plikowi i wyborowi wierszy.",
        "ASSET_IMPORT_SCOPE_CHANGED",
      );
    const {
      parserVersion: _,
      bytes: __,
      sha256: ___,
      ...source
    } = reference.source;
    const preview = this.preview(s, {
      ...source,
      contentBase64: body.toString("base64"),
    });
    if (
      preview.previewHash !== input.previewHash ||
      s.profileVersion !== input.profileVersion ||
      s.timezone !== reference.timezone
    )
      fail(
        "Ewidencja lub profil zmienił się od podglądu. Przygotuj nowy plan.",
        "ASSET_IMPORT_PREVIEW_CHANGED",
      );
    this.selection(preview, input.selectedRows);
    // Publication is immutable and repeatable; an uncommitted copy cannot attest a database effect.
    this.files.publish(s.ctx, input.uploadId, input.manifestHash);
    const chosen = preview.rows.filter((r) =>
      input.selectedRows.includes(r.sourceRow),
    );
    const assets = chosen.map((row) =>
      s.create(row.asset!, provenance(reference, row)),
    );
    const data: Omit<AssetImportReceipt, "hash"> = {
      formatVersion: 1,
      id: input.uploadId,
      tenantId: s.ctx.tenantId,
      operationKey: s.ctx.operationKey,
      runId: s.ctx.runId,
      stepId: s.ctx.stepId,
      actorId: s.ctx.actorId!,
      approvedBy: s.ctx.approvedBy!,
      importedAt: s.now,
      source: reference,
      created: assets.map((e, i) => ({
        sourceRow: chosen[i]!.sourceRow,
        firstLine: chosen[i]!.firstLine,
        lastLine: chosen[i]!.lastLine,
        id: e.id,
        version: e.version,
        hash: hash(e),
        title: e.title,
        serial: String(e.data.serial),
      })),
      skippedRows: preview.rows
        .filter((r) => !input.selectedRows.includes(r.sourceRow))
        .map((r) => r.sourceRow),
    };
    const receipt: AssetImportReceipt = { ...data, hash: hash(data) };
    this.db
      .prepare("INSERT INTO ops_asset_imports VALUES(?,?,?,?,?,?)")
      .run(
        s.ctx.tenantId,
        receipt.id,
        s.ctx.operationKey,
        s.now,
        JSON.stringify(receipt),
        receipt.hash,
      );
    return { assets, receipt };
  }
  private stored(tenant: string, id: string): AssetImportReceipt {
    z.string().uuid().parse(id);
    const row = this.db
      .prepare("SELECT * FROM ops_asset_imports WHERE tenant_id=? AND id=?")
      .get(tenant, id);
    if (!row) fail("Nie znaleziono importu.", "ASSET_IMPORT_NOT_FOUND", 404);
    const r = JSON.parse(String(row.receipt_json)) as AssetImportReceipt,
      { hash: stored, ...data } = r;
    if (
      r.formatVersion !== 1 ||
      r.id !== id ||
      r.tenantId !== tenant ||
      r.operationKey !== row.operation_key ||
      r.importedAt !== row.imported_at ||
      hash(data) !== stored ||
      stored !== row.receipt_hash
    )
      fail("Historia importu jest niespójna.", "ASSET_IMPORT_RECEIPT_INVALID");
    return r;
  }
  private validate(r: AssetImportReceipt) {
    const { body, reference } = this.files.read(r.tenantId, r.source),
      {
        parserVersion: _,
        bytes: __,
        sha256: ___,
        ...source
      } = reference.source;
    const parsed = parseAssetCsv(body, source),
      selected = reference.selectedRows;
    if (
      reference.id !== r.id ||
      reference.uploadedBy !== r.actorId ||
      !r.approvedBy ||
      parsed.mappingErrors.length ||
      !r.created.length ||
      r.created.length !== selected.length ||
      new Set(r.created.map((c) => c.id)).size !== selected.length ||
      hash(r.created.map((c) => c.sourceRow)) !== hash(selected) ||
      hash(r.skippedRows) !==
        hash(
          parsed.rows
            .filter((p) => !selected.includes(p.sourceRow))
            .map((p) => p.sourceRow),
        )
    )
      return false;
    return r.created.every((c) => {
      const row = parsed.rows.find((p) => p.sourceRow === c.sourceRow);
      const v = this.db
        .prepare(
          "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
        )
        .get(r.tenantId, c.id, c.version);
      if (
        !v ||
        !row?.asset ||
        row.errors.length ||
        c.version !== 1 ||
        c.hash !== v.snapshot_hash
      )
        return false;
      const e = JSON.parse(String(v.snapshot_json)) as Entity,
        { title, ...values } = row.asset;
      return (
        e.module === "assets" &&
        e.id === c.id &&
        e.version === 1 &&
        hash(e) === c.hash &&
        e.title === title &&
        c.title === title &&
        c.serial === values.serial &&
        c.firstLine === row.firstLine &&
        c.lastLine === row.lastLine &&
        hash(e.data.importSource) === hash(provenance(reference, row)) &&
        Object.entries(values).every(([k, val]) => e.data[k] === val) &&
        e.status ===
          (values.condition === "good" ? "available" : "maintenance") &&
        hash(e.data.allocations) === hash([]) &&
        e.createdAt === r.importedAt
      );
    });
  }
  requireCommitted(
    ctx: ToolContext,
    raw: unknown,
    ledger: Record<string, unknown> | undefined,
  ) {
    if (!ledger) return;
    const input = assetImportCommandSchema.parse(raw),
      r = this.stored(ctx.tenantId, input.uploadId);
    const changes = JSON.parse(String(ledger.changes_json)),
      result = JSON.parse(String(ledger.receipt_json));
    const first = r.created[0],
      snapshot =
        first &&
        this.db
          .prepare(
            "SELECT snapshot_json FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
          )
          .get(ctx.tenantId, first.id, first.version);
    const entity =
      snapshot &&
      (JSON.parse(String(snapshot.snapshot_json)) as Entity | undefined);
    if (
      r.operationKey !== ctx.operationKey ||
      r.runId !== ctx.runId ||
      r.stepId !== ctx.stepId ||
      r.actorId !== ctx.actorId ||
      r.approvedBy !== ctx.approvedBy ||
      hash(commandFrom(r.source)) !== hash(input) ||
      !this.validate(r) ||
      hash(changes) !==
        hash(
          r.created.map((c) => ({
            id: c.id,
            module: "assets",
            version: c.version,
            hash: c.hash,
          })),
        ) ||
      !entity ||
      hash(result) !==
        hash({
          data: {
            entityId: entity.id,
            module: "assets",
            version: entity.version,
            status: entity.status,
            title: entity.title,
            importId: r.id,
            importHash: r.hash,
            importedCount: r.created.length,
            skippedCount: r.skippedRows.length,
          },
        })
    )
      fail(
        "Nie udało się potwierdzić zapisanego importu i oryginalnego pliku.",
        "ASSET_IMPORT_RECEIPT_INVALID",
      );
  }
  report(tenant: string, id: string) {
    const r = this.stored(tenant, id);
    let valid = false;
    try {
      valid = this.validate(r);
    } catch {
      /* Explicitly report unavailable or altered evidence. */
    }
    return { ...r, valid };
  }
  list(tenant: string, page: { limit: number; offset: number }) {
    const rows = this.db
      .prepare(
        "SELECT id FROM ops_asset_imports WHERE tenant_id=? ORDER BY imported_at DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(tenant, page.limit, page.offset);
    return {
      items: rows.map((row) => {
        const r = this.stored(tenant, String(row.id));
        return {
          id: r.id,
          sourceName: r.source.source.sourceName,
          filename: r.source.source.filename,
          observedOn: r.source.source.observedOn,
          importedAt: r.importedAt,
          actorId: r.actorId,
          created: r.created.length,
          skipped: r.skippedRows.length,
          runId: r.runId,
        };
      }),
      total: Number(
        this.db
          .prepare("SELECT count(*) n FROM ops_asset_imports WHERE tenant_id=?")
          .get(tenant)!.n,
      ),
      ...page,
    };
  }
  download(tenant: string, id: string) {
    const r = this.stored(tenant, id);
    if (!this.validate(r))
      fail(
        "Źródło importu jest niedostępne lub niezgodne z historią.",
        "ASSET_IMPORT_RECEIPT_INVALID",
      );
    return this.files.read(tenant, r.source);
  }
}
