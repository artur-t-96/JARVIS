import { createHash } from "node:crypto";
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
import { dirname, extname, join, resolve } from "node:path";
import { fromBufferPromise } from "yauzl";
import { z } from "zod";
import { DomainError, type Principal, type ToolContext } from "./contracts.js";

export const MAX_DOCUMENT_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENT_FILES = 20;
const maxStagedBytes = 200 * 1024 * 1024;
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileNameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (v) =>
      !/[\\/\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(v) &&
      v.trim() === v &&
      v !== "." &&
      v !== "..",
  );
export const fileMediaSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
]);
export const documentFileManifestSchema = z
  .object({
    format: z.literal("jarvis-document-file"),
    formatVersion: z.literal(1),
    id: z.string().uuid(),
    tenantId: z.string().min(1).max(200),
    documentId: z.string().uuid(),
    filename: fileNameSchema,
    mediaType: fileMediaSchema,
    bytes: z.number().int().positive().max(MAX_DOCUMENT_FILE_BYTES),
    sha256: hashSchema,
    uploadedBy: z.string().min(1).max(200),
    uploadedAt: z.string().datetime(),
  })
  .strict();
export type DocumentFileManifest = z.infer<typeof documentFileManifestSchema>;
export const documentFileReferenceSchema = documentFileManifestSchema.extend({
  manifestHash: hashSchema,
});
export type DocumentFileReference = z.infer<typeof documentFileReferenceSchema>;
const stageSchema = z
  .object({
    manifest: documentFileManifestSchema,
    manifestHash: hashSchema,
    expectedVersion: z.number().int().positive(),
    expiresAt: z.string().datetime(),
  })
  .strict();
const canonical = (value: unknown): string =>
  value !== null && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`
    : JSON.stringify(value);
export const fileHash = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
export const fileManifestHash = (manifest: DocumentFileManifest) =>
  fileHash(canonical(manifest));
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}

/** Inspect bounded format metadata only. No document is executed or fetched. */
export async function validateDocumentFile(
  filename: string,
  mediaType: string,
  body: Buffer,
) {
  if (!body.length || body.length > MAX_DOCUMENT_FILE_BYTES)
    fail("FILE_SIZE_INVALID", "Plik musi mieć od 1 bajtu do 10 MiB.", 413);
  fileNameSchema.parse(filename);
  fileMediaSchema.parse(mediaType);
  const extension = extname(filename).toLowerCase();
  let valid = false;
  if (mediaType === "application/pdf")
    valid =
      extension === ".pdf" &&
      /^%PDF-[12]\.[0-9]/.test(body.subarray(0, 8).toString("ascii")) &&
      /%%EOF\s*$/.test(body.subarray(-1024).toString("latin1"));
  if (mediaType === "image/png")
    valid =
      extension === ".png" &&
      body
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mediaType === "image/jpeg")
    valid =
      [".jpg", ".jpeg"].includes(extension) &&
      body[0] === 0xff &&
      body[1] === 0xd8 &&
      body[body.length - 2] === 0xff &&
      body[body.length - 1] === 0xd9;
  if (["text/plain", "text/markdown"].includes(mediaType)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      valid =
        extension === (mediaType === "text/plain" ? ".txt" : ".md") &&
        !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
    } catch {
      valid = false;
    }
  }
  if (
    mediaType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
    extension === ".docx"
  ) {
    try {
      const zip = await fromBufferPromise(body, {
        lazyEntries: true,
        validateEntrySizes: true,
        strictFileNames: true,
      });
      const names = new Set<string>();
      let size = 0;
      try {
        for await (const entry of zip.eachEntry()) {
          size += entry.uncompressedSize;
          if (
            names.size >= 2000 ||
            size > 40 * 1024 * 1024 ||
            names.has(entry.fileName) ||
            entry.isEncrypted() ||
            /(?:vbaProject|activeX|embeddings)/i.test(entry.fileName)
          )
            throw new Error("Unsupported archive");
          names.add(entry.fileName);
        }
        valid = [
          "[Content_Types].xml",
          "_rels/.rels",
          "word/document.xml",
        ].every((n) => names.has(n));
      } finally {
        zip.close();
      }
    } catch {
      valid = false;
    }
  }
  if (!valid)
    fail(
      "FILE_FORMAT_INVALID",
      "Nazwa, typ i zawartość pliku są niezgodne lub format nie jest obsługiwany.",
      400,
    );
}

/** Files are addressed only by owned UUIDs; user filenames are metadata. */
export class DocumentFiles {
  constructor(
    private readonly dataDir?: string,
    private readonly clock: () => number = Date.now,
  ) {}
  private directory(parts: string[], create = false) {
    if (!this.dataDir)
      fail("FILES_UNAVAILABLE", "Magazyn plików nie jest skonfigurowany.", 503);
    let current = resolve(this.dataDir);
    const inspect = () => {
      if (!existsSync(current))
        fail(
          "FILE_UNAVAILABLE",
          "Materiał plikowy jest niedostępny. Przygotuj go ponownie.",
        );
      const s = lstatSync(current);
      if (!s.isDirectory() || s.isSymbolicLink())
        fail("FILE_STORAGE_UNSAFE", "Nieprawidłowy katalog magazynu plików.");
    };
    inspect();
    for (const part of ["attachments", "document-files", ...parts]) {
      current = join(current, part);
      if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
      inspect();
    }
    return current;
  }
  private bytes(path: string, limit: number) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit)
        fail("FILE_STORAGE_UNSAFE", "Nieprawidłowy plik w magazynie.");
      return readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  private persist(path: string, body: Buffer | string) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!this.bytes(path, MAX_DOCUMENT_FILE_BYTES).equals(Buffer.from(body)))
        fail(
          "FILE_STORAGE_CONFLICT",
          "Zapisany plik nie odpowiada przygotowanemu materiałowi.",
        );
      return;
    }
    try {
      writeFileSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private stageParts(tenant: string, actor: string, id: string) {
    return [
      "staged",
      fileHash(tenant),
      fileHash(actor),
      z.string().uuid().parse(id),
    ];
  }
  private savedParts(tenant: string, id: string) {
    return ["saved", fileHash(tenant), z.string().uuid().parse(id)];
  }
  async stage(
    p: Principal,
    documentId: string,
    expectedVersion: number,
    uploadId: string,
    filename: string,
    mediaType: string,
    body: Buffer,
  ) {
    await validateDocumentFile(filename, mediaType, body);
    const parts = this.stageParts(p.tenantId, p.id, uploadId),
      dir = this.directory(parts.slice(0, -1), true),
      path = join(dir, uploadId),
      now = this.clock();
    let manifest = documentFileManifestSchema.parse({
      format: "jarvis-document-file",
      formatVersion: 1,
      id: uploadId,
      tenantId: p.tenantId,
      documentId,
      filename,
      mediaType,
      bytes: body.length,
      sha256: fileHash(body),
      uploadedBy: p.id,
      uploadedAt: new Date(now).toISOString(),
    });
    if (existsSync(path)) {
      const old = stageSchema.parse(
        JSON.parse(
          this.bytes(
            join(this.directory(parts), "stage.json"),
            10_000,
          ).toString("utf8"),
        ),
      );
      if (
        old.expectedVersion !== expectedVersion ||
        canonical({ ...manifest, uploadedAt: old.manifest.uploadedAt }) !==
          canonical(old.manifest)
      )
        fail(
          "FILE_UPLOAD_CONFLICT",
          "Ten identyfikator wskazuje inny przygotowany plik.",
        );
      if (Date.parse(old.expiresAt) <= now)
        fail(
          "FILE_UPLOAD_EXPIRED",
          "Przygotowany plik wygasł. Wybierz go ponownie.",
        );
      manifest = old.manifest;
    } else {
      const entries = readdirSync(dir);
      if (entries.length >= 50)
        fail(
          "FILE_STAGING_LIMIT",
          "Osiągnięto limit 50 przygotowanych plików dla tego konta.",
        );
      let total = 0;
      for (const id of entries) {
        const stageDir = this.directory(parts.slice(0, -1).concat(id));
        for (const name of readdirSync(stageDir))
          total += lstatSync(join(stageDir, name)).size;
      }
      if (total + body.length > maxStagedBytes)
        fail(
          "FILE_STAGING_LIMIT",
          "Osiągnięto limit 200 MiB przygotowanych plików.",
        );
    }
    const manifestHash = fileManifestHash(manifest),
      stage = {
        manifest,
        manifestHash,
        expectedVersion,
        expiresAt: new Date(
          Date.parse(manifest.uploadedAt) + 7 * 86400_000,
        ).toISOString(),
      };
    const destination = this.directory(parts, true);
    // Manifest first lets a lost response resume the exact upload without a new identity.
    this.persist(join(destination, "stage.json"), canonical(stage));
    this.persist(join(destination, "content.bin"), body);
    return { ...manifest, manifestHash, expiresAt: stage.expiresAt };
  }
  publish(
    ctx: ToolContext,
    documentId: string,
    expectedVersion: number,
    uploadId: string,
    manifestHash: string,
  ): DocumentFileReference {
    const dir = this.directory(
      this.stageParts(ctx.tenantId, ctx.actorId!, uploadId),
    );
    const stage = stageSchema.parse(
      JSON.parse(this.bytes(join(dir, "stage.json"), 10_000).toString("utf8")),
    );
    const m = stage.manifest;
    if (
      m.tenantId !== ctx.tenantId ||
      m.uploadedBy !== ctx.actorId ||
      m.documentId !== documentId ||
      stage.expectedVersion !== expectedVersion ||
      stage.manifestHash !== manifestHash ||
      fileManifestHash(m) !== manifestHash
    )
      fail(
        "FILE_APPROVAL_MISMATCH",
        "Plik nie odpowiada zatwierdzonemu zakresowi i autorowi.",
      );
    if (Date.parse(stage.expiresAt) <= this.clock())
      fail(
        "FILE_UPLOAD_EXPIRED",
        "Przygotowany plik wygasł. Wybierz go ponownie i zatwierdź nowy plan.",
      );
    const body = this.bytes(join(dir, "content.bin"), MAX_DOCUMENT_FILE_BYTES);
    if (body.length !== m.bytes || fileHash(body) !== m.sha256)
      fail("FILE_INTEGRITY_FAILED", "Przygotowany plik ma niezgodny odcisk.");
    const parts = this.savedParts(ctx.tenantId, m.id),
      parent = this.directory(parts.slice(0, -1), true);
    if (!existsSync(join(parent, m.id))) {
      const existing = readdirSync(parent);
      let total = 0;
      for (const id of existing) {
        const dir = this.directory(parts.slice(0, -1).concat(id));
        if (existsSync(join(dir, "content.bin")))
          total += lstatSync(join(dir, "content.bin")).size;
      }
      if (existing.length >= 1000 || total + body.length > 1024 * 1024 * 1024)
        fail(
          "FILE_STORAGE_LIMIT",
          "Osiągnięto limit 1000 plików lub 1 GiB załączników organizacji.",
        );
    }
    const target = this.directory(parts, true);
    this.persist(join(target, "manifest.json"), canonical(m));
    this.persist(join(target, "content.bin"), body);
    return { ...m, manifestHash };
  }
  releaseStage(ctx: ToolContext, uploadId: string) {
    // Only after a durable domain receipt. Failure keeps a recoverable private input.
    try {
      const path = this.directory(
        this.stageParts(ctx.tenantId, ctx.actorId!, uploadId),
      );
      const s = stageSchema.parse(
        JSON.parse(
          this.bytes(join(path, "stage.json"), 10_000).toString("utf8"),
        ),
      );
      if (
        s.manifest.tenantId === ctx.tenantId &&
        s.manifest.uploadedBy === ctx.actorId &&
        s.manifest.id === uploadId
      )
        rmSync(path, { recursive: true });
    } catch {
      /* Cleanup cannot turn a committed operation into an unknown effect. */
    }
  }
  read(tenant: string, documentId: string, reference: unknown) {
    const f = documentFileReferenceSchema.parse(reference),
      { manifestHash, ...manifest } = f;
    if (
      f.tenantId !== tenant ||
      f.documentId !== documentId ||
      fileManifestHash(manifest) !== manifestHash
    )
      fail("FILE_INTEGRITY_FAILED", "Manifest nie odpowiada dokumentowi.");
    const dir = this.directory(this.savedParts(tenant, f.id));
    if (
      this.bytes(join(dir, "manifest.json"), 10_000).toString("utf8") !==
      canonical(manifest)
    )
      fail("FILE_INTEGRITY_FAILED", "Zapisany manifest został zmieniony.");
    const body = this.bytes(join(dir, "content.bin"), MAX_DOCUMENT_FILE_BYTES);
    if (body.length !== f.bytes || fileHash(body) !== f.sha256)
      fail("FILE_INTEGRITY_FAILED", "Plik ma inny rozmiar lub odcisk.");
    return { manifest: f, body };
  }
  assessment(tenant: string, documentId: string, references: unknown) {
    if (!Array.isArray(references)) return [];
    return references.map((reference) => {
      const parsed = documentFileReferenceSchema.safeParse(reference);
      let valid = false;
      if (parsed.success) {
        try {
          this.read(tenant, documentId, parsed.data);
          valid = true;
        } catch {
          /* Availability is distinct from an intact revision hash. */
        }
      }
      return {
        id: parsed.success ? parsed.data.id : "invalid",
        filename: parsed.success
          ? parsed.data.filename
          : "Nieprawidłowy manifest",
        bytes: parsed.success ? parsed.data.bytes : 0,
        sha256: parsed.success ? parsed.data.sha256 : null,
        valid,
      };
    });
  }
}
