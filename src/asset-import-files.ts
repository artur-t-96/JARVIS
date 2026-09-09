import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DomainError, type Principal, type ToolContext } from "./contracts.js";
import { hash } from "./engine.js";
import {
  assetImportCommandSchema,
  assetImportMappingSchema,
  assetImportSourceSchema,
  ASSET_CSV_PARSER,
  MAX_ASSET_CSV_BYTES,
} from "./asset-import-csv.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const assetImportManifestSchema = z
  .object({
    format: z.literal("jarvis-asset-import-file"),
    formatVersion: z.literal(1),
    id: z.string().uuid(),
    tenantId: z.string().min(1).max(200),
    uploadedBy: z.string().min(1).max(200),
    uploadedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    source: assetImportSourceSchema
      .extend({
        mapping: assetImportMappingSchema,
        parserVersion: z.literal(ASSET_CSV_PARSER),
        bytes: z.number().int().positive().max(MAX_ASSET_CSV_BYTES),
        sha256: fingerprint,
      })
      .strict(),
    previewHash: fingerprint,
    selectedRows: assetImportCommandSchema.shape.selectedRows,
    profileVersion: z.number().int().nonnegative(),
    timezone: z.string().min(1).max(100),
    note: assetImportCommandSchema.shape.note,
  })
  .strict();
export type AssetImportManifest = z.infer<typeof assetImportManifestSchema>;
export type AssetImportFileReference = AssetImportManifest & {
  manifestHash: string;
};
const referenceSchema = assetImportManifestSchema
  .extend({ manifestHash: fingerprint })
  .strict();
const bytesHash = (v: Buffer | string) =>
  createHash("sha256").update(v).digest("hex");
const canonical = (v: unknown): string =>
  v !== null && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`
    : JSON.stringify(v);
function fail(
  message: string,
  code = "ASSET_IMPORT_FILE_INVALID",
  status = 409,
): never {
  throw new DomainError(code, message, status);
}

/** Local copy of the document-file storage safeguards from JARVIS 188ccdc; a separate namespace and manifest own CSV inputs. */
export class AssetImportFiles {
  constructor(
    private readonly dataDir?: string,
    private readonly clock: () => number = Date.now,
  ) {}
  private directory(parts: string[], create = false) {
    if (!this.dataDir)
      fail(
        "Magazyn źródeł importu nie jest skonfigurowany.",
        "ASSET_IMPORT_FILES_UNAVAILABLE",
        503,
      );
    let current = resolve(this.dataDir);
    const inspect = () => {
      if (!existsSync(current))
        fail(
          "Źródło importu jest niedostępne. Przygotuj plik ponownie.",
          "ASSET_IMPORT_FILE_UNAVAILABLE",
        );
      const s = lstatSync(current);
      if (!s.isDirectory() || s.isSymbolicLink())
        fail("Nieprawidłowy katalog źródeł importu.");
    };
    inspect();
    for (const part of ["attachments", "asset-imports", ...parts]) {
      current = join(current, part);
      if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
      inspect();
    }
    return current;
  }
  private bytes(path: string, limit: number) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = fstatSync(fd);
      if (!s.isFile() || s.nlink !== 1 || s.size > limit)
        fail("Nieprawidłowy plik źródłowy importu.");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private persist(path: string, body: Buffer | string) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!this.bytes(path, MAX_ASSET_CSV_BYTES).equals(Buffer.from(body)))
        fail("Ten identyfikator wskazuje inny zapisany plik.");
      return;
    }
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const parent = openSync(dirname(path), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
  }
  private stageParts(tenant: string, actor: string, id: string) {
    return [
      "staged",
      bytesHash(tenant),
      bytesHash(actor),
      z.string().uuid().parse(id),
    ];
  }
  private savedParts(tenant: string, id: string) {
    return ["saved", bytesHash(tenant), z.string().uuid().parse(id)];
  }
  stage(
    p: Principal,
    id: string,
    body: Buffer,
    details: Pick<
      AssetImportManifest,
      | "source"
      | "previewHash"
      | "selectedRows"
      | "profileVersion"
      | "timezone"
      | "note"
    >,
  ): AssetImportFileReference {
    const parts = this.stageParts(p.tenantId, p.id, id),
      parent = this.directory(parts.slice(0, -1), true),
      now = this.clock();
    let manifest = assetImportManifestSchema.parse({
      ...details,
      format: "jarvis-asset-import-file",
      formatVersion: 1,
      id,
      tenantId: p.tenantId,
      uploadedBy: p.id,
      uploadedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 86400000).toISOString(),
    });
    if (
      body.length !== manifest.source.bytes ||
      bytesHash(body) !== manifest.source.sha256
    )
      fail("Plik nie odpowiada odciskowi podglądu.");
    if (existsSync(join(parent, id))) {
      const old = assetImportManifestSchema.parse(
        JSON.parse(
          this.bytes(
            join(this.directory(parts), "manifest.json"),
            32 * 1024,
          ).toString("utf8"),
        ),
      );
      manifest = {
        ...manifest,
        uploadedAt: old.uploadedAt,
        expiresAt: old.expiresAt,
      };
      if (hash(manifest) !== hash(old))
        fail(
          "Ten identyfikator przygotowania wskazuje inny plik lub zakres.",
          "ASSET_IMPORT_STAGE_CONFLICT",
        );
      if (Date.parse(old.expiresAt) <= now)
        fail(
          "Przygotowane źródło wygasło. Przygotuj nowy plan.",
          "ASSET_IMPORT_EXPIRED",
        );
    } else {
      // Expired, uncommitted preparations are disposable; saved sources are never removed here.
      for (const candidate of readdirSync(parent)) {
        if (!z.string().uuid().safeParse(candidate).success) continue;
        const candidateDir = this.directory(
          this.stageParts(p.tenantId, p.id, candidate),
        );
        try {
          const old = assetImportManifestSchema.parse(
            JSON.parse(
              this.bytes(
                join(candidateDir, "manifest.json"),
                32 * 1024,
              ).toString("utf8"),
            ),
          );
          if (
            old.tenantId === p.tenantId &&
            old.uploadedBy === p.id &&
            old.id === candidate &&
            Date.parse(old.expiresAt) <= now
          )
            rmSync(candidateDir, { recursive: true });
        } catch {
          /* Unknown temporary contents remain for explicit diagnostics. */
        }
      }
      if (readdirSync(parent).length >= 50)
        fail(
          "Osiągnięto limit 50 przygotowanych plików dla tego konta.",
          "ASSET_IMPORT_STAGING_LIMIT",
        );
    }
    const dir = this.directory(parts, true);
    this.persist(join(dir, "manifest.json"), canonical(manifest));
    this.persist(join(dir, "content.csv"), body);
    return { ...manifest, manifestHash: hash(manifest) };
  }
  staged(tenant: string, actor: string, id: string) {
    const dir = this.directory(this.stageParts(tenant, actor, id)),
      manifest = assetImportManifestSchema.parse(
        JSON.parse(
          this.bytes(join(dir, "manifest.json"), 32 * 1024).toString("utf8"),
        ),
      );
    if (
      manifest.id !== id ||
      manifest.tenantId !== tenant ||
      manifest.uploadedBy !== actor
    )
      fail("Źródło importu nie należy do tego autora i firmy.");
    const body = this.bytes(join(dir, "content.csv"), MAX_ASSET_CSV_BYTES);
    if (
      body.length !== manifest.source.bytes ||
      bytesHash(body) !== manifest.source.sha256
    )
      fail("Zawartość źródła importu nie odpowiada manifestowi.");
    return { reference: { ...manifest, manifestHash: hash(manifest) }, body };
  }
  publish(
    ctx: ToolContext,
    id: string,
    manifestHash: string,
  ): AssetImportFileReference {
    const { reference, body } = this.staged(ctx.tenantId, ctx.actorId!, id),
      { manifestHash: actual, ...manifest } = reference;
    if (actual !== manifestHash)
      fail("Źródło nie odpowiada zatwierdzonemu manifestowi.");
    if (Date.parse(manifest.expiresAt) <= this.clock())
      fail(
        "Przygotowane źródło wygasło. Wybierz plik ponownie.",
        "ASSET_IMPORT_EXPIRED",
      );
    const parts = this.savedParts(ctx.tenantId, id),
      parent = this.directory(parts.slice(0, -1), true);
    if (!existsSync(join(parent, id)) && readdirSync(parent).length >= 1000)
      fail(
        "Osiągnięto limit 1000 źródeł importu tej organizacji.",
        "ASSET_IMPORT_STORAGE_LIMIT",
      );
    const dir = this.directory(parts, true);
    this.persist(join(dir, "manifest.json"), canonical(manifest));
    this.persist(join(dir, "content.csv"), body);
    return reference;
  }
  read(tenant: string, raw: unknown) {
    const reference = referenceSchema.parse(raw),
      { manifestHash, ...manifest } = reference;
    if (manifest.tenantId !== tenant || hash(manifest) !== manifestHash)
      fail("Manifest źródła nie odpowiada firmie lub zapisanej wersji.");
    const dir = this.directory(this.savedParts(tenant, manifest.id));
    if (
      this.bytes(join(dir, "manifest.json"), 32 * 1024).toString("utf8") !==
      canonical(manifest)
    )
      fail("Zapisany manifest importu został zmieniony.");
    const body = this.bytes(join(dir, "content.csv"), MAX_ASSET_CSV_BYTES);
    if (
      body.length !== manifest.source.bytes ||
      bytesHash(body) !== manifest.source.sha256
    )
      fail("Źródło importu ma inny odcisk lub rozmiar.");
    return { reference, body };
  }
  releaseStage(ctx: ToolContext, id: string) {
    try {
      const { reference } = this.staged(ctx.tenantId, ctx.actorId!, id);
      this.read(ctx.tenantId, reference);
      rmSync(this.directory(this.stageParts(ctx.tenantId, ctx.actorId!, id)), {
        recursive: true,
      });
    } catch {
      /* A committed import remains valid when only temporary cleanup fails. */
    }
  }
}
