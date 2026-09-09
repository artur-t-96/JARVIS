import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Footer,
  PageNumber,
  AlignmentType,
} from "docx";
import JSZip from "jszip";
import { DomainError, type JsonObject, type Principal } from "./contracts.js";
import type { Entity, WorkspaceStore } from "./workspace.js";
import { exportArtifact, type Artifact } from "./artifacts.js";

export const DOCUMENT_RENDERER = "p09a2-3";
type Block = {
  kind: "title" | "heading" | "paragraph" | "bullet" | "small";
  text: string;
};
const objects = (value: unknown) =>
  Array.isArray(value) ? (value as JsonObject[]) : [];
const clean = (value: unknown) =>
  String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const labels: Record<string, string> = {
  draft: "Szkic — bez odbioru",
  review: "Przekazany do odbioru",
  approved: "Zatwierdzony",
  rejected: "Odrzucony",
  archived: "Archiwalny",
  cases: "Sprawa",
  people: "Osoba",
  assets: "Wyposażenie",
  sales: "Sprzedaż",
  purchases: "Zakupy",
  documents: "Dokument",
  it: "Usługa IT",
  licenses: "Licencja",
  recruitment: "Rekrutacja",
};
const date = (v: unknown) => {
  const s = String(v ?? "");
  return Number.isFinite(Date.parse(s))
    ? new Date(s)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, " UTC")
    : "Brak daty";
};

/** Plain text only. Markdown headings and list markers are layout hints, never commands or active content. */
function contentBlocks(content: string): Block[] {
  const result: Block[] = [];
  let paragraph: string[] = [],
    fenced = false;
  const flush = () => {
    if (paragraph.length)
      result.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of clean(content).replace(/\r\n?/g, "\n").split("\n")) {
    if (/^```/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    const heading = !fenced && /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = !fenced && /^\s*[-*+]\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      result.push({ kind: "heading", text: heading[2]! });
    } else if (bullet) {
      flush();
      result.push({ kind: "bullet", text: bullet[1]! });
    } else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  flush();
  return result;
}

function blocksFor(entity: Entity): Block[] {
  const versions = objects(entity.data.versions),
    current = versions.find((v) => v.revision === entity.data.revision);
  const blocks: Block[] = [
    { kind: "small", text: "JARVIS · Dokument" },
    { kind: "title", text: clean(entity.title) },
    {
      kind: "paragraph",
      text: `${labels[entity.status] ?? entity.status} · rewizja ${entity.data.revision ?? 1}\nZapis wersji: ${date(entity.updatedAt)}`,
    },
  ];
  if (entity.status === "approved" && current?.decidedBy)
    blocks.push({
      kind: "small",
      text: `Odbiór: ${clean(current.decidedBy)} · ${date(current.decidedAt)}`,
    });
  blocks.push(...contentBlocks(String(entity.data.content)));
  blocks.push({ kind: "heading", text: "Źródła i pliki tej rewizji" });
  const sources = objects(entity.data.sources),
    files = objects(entity.data.files);
  if (!sources.length)
    blocks.push({
      kind: "paragraph",
      text: entity.data.operationalReport
        ? "Zakres i źródła raportu są opisane w jego treści."
        : "Nie wskazano rekordów źródłowych.",
    });
  for (const source of sources) {
    const snapshot = source.snapshot as JsonObject | undefined;
    blocks.push({
      kind: "paragraph",
      text: `${source.kind === "case_scope" ? "Uzgodniony zakres sprawy" : (labels[String(source.module)] ?? clean(source.module))}${snapshot?.title ? `: ${clean(snapshot.title)}` : ""}\n${source.kind === "case_scope" ? "Rewizja zakresu" : "Wersja"}: ${source.version}. Odczyt: ${date(source.observedAt)}.`,
    });
    blocks.push({
      kind: "small",
      text: `Identyfikator: ${clean(source.id)}${source.snapshotHash ? `\nSHA-256 źródła: ${source.snapshotHash}` : ""}`,
    });
  }
  if (!files.length)
    blocks.push({
      kind: "paragraph",
      text: "Nie przypisano plików do tej rewizji.",
    });
  for (const file of files) {
    blocks.push({
      kind: "paragraph",
      text: `${clean(file.filename)} · ${Number(file.bytes).toLocaleString("pl-PL")} bajtów\nDodano: ${date(file.uploadedAt)}. Autor: ${clean(file.uploadedBy)}.`,
    });
    blocks.push({ kind: "small", text: `SHA-256 pliku: ${file.sha256}` });
  }
  if (files.length)
    blocks.push({
      kind: "small",
      text: "Rejestr wskazuje oryginalne załączniki. Ich treść jest dostępna w plikach przypisanych do dokumentu.",
    });
  blocks.push({
    kind: "small",
    text: `Dokument: ${entity.id}\nWersja rekordu: ${entity.version} · renderer ${DOCUMENT_RENDERER}${current?.contentHash ? `\nSHA-256 treści: ${current.contentHash}` : ""}${current?.contextHash ? `\nSHA-256 kontekstu: ${current.contextHash}` : ""}`,
  });
  return blocks;
}

const regularFont = fileURLToPath(
  new URL("../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
);
const boldFont = fileURLToPath(
  new URL("../assets/fonts/NotoSans-Bold.ttf", import.meta.url),
);
function pdf(entity: Entity, blocks: Block[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fixedDate = new Date(entity.updatedAt),
      chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: "LETTER",
      margins: { top: 54, bottom: 54, left: 54, right: 54 },
      bufferPages: true,
      info: {
        Title: clean(entity.title),
        Author: "JARVIS",
        Creator: `JARVIS ${DOCUMENT_RENDERER}`,
        Producer: "PDFKit 0.20.2",
        CreationDate: fixedDate,
        ModDate: fixedDate,
      },
    });
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont("regular", regularFont).registerFont("bold", boldFont);
      for (const b of blocks) {
        const heading = b.kind === "heading" || b.kind === "title",
          size =
            b.kind === "title"
              ? 23
              : b.kind === "heading"
                ? 14
                : b.kind === "small"
                  ? 8.5
                  : 11;
        doc
          .font(heading ? "bold" : "regular")
          .fontSize(size)
          .fillColor(b.kind === "small" ? "#475569" : "#111827");
        // Keep a heading with at least two lines of the following paragraph.
        const remaining = doc.page.height - doc.page.margins.bottom - doc.y;
        const height = doc.heightOfString(b.text, { width: 504, lineGap: 3 });
        if (
          heading &&
          remaining <
            (b.text === "Źródła i pliki tej rewizji"
              ? 230
              : Math.min(height, 180) + 40)
        )
          doc.addPage();
        doc.text(b.kind === "bullet" ? `• ${b.text}` : b.text, {
          width: 504,
          lineGap: 3,
          paragraphGap: 0,
        });
        doc.moveDown(b.kind === "small" ? 0.65 : 0.8);
      }
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc.font("regular").fontSize(8).fillColor("#64748b");
        doc.text(`JARVIS · rewizja ${entity.data.revision ?? 1}`, 54, 762, {
          lineBreak: false,
        });
        doc.text(`${i + 1} / ${range.count}`, 500, 762, { lineBreak: false });
      }
      doc.end();
    } catch (error) {
      doc.destroy();
      reject(error);
    }
  });
}

async function docx(entity: Entity, blocks: Block[]): Promise<Buffer> {
  const children = blocks.map(
    (b) =>
      new Paragraph({
        ...(b.kind === "title"
          ? { heading: HeadingLevel.TITLE }
          : b.kind === "heading"
            ? { heading: HeadingLevel.HEADING_1 }
            : {}),
        keepNext: b.kind === "title" || b.kind === "heading",
        widowControl: true,
        spacing: { after: b.kind === "small" ? 100 : 160, line: 280 },
        children: clean(b.kind === "bullet" ? `• ${b.text}` : b.text)
          .split("\n")
          .map(
            (line, i) =>
              new TextRun({
                text: line,
                ...(i ? { break: 1 } : {}),
                font: "Arial",
                size:
                  b.kind === "title"
                    ? 46
                    : b.kind === "heading"
                      ? 28
                      : b.kind === "small"
                        ? 17
                        : 22,
                bold: b.kind === "title" || b.kind === "heading",
                color: b.kind === "small" ? "475569" : "111827",
              }),
          ),
      }),
  );
  const document = new Document({
    title: clean(entity.title),
    creator: "JARVIS",
    lastModifiedBy: "JARVIS",
    revision: entity.version,
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22, language: { value: "pl-PL" } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: `JARVIS · rewizja ${entity.data.revision ?? 1} · `,
                    size: 16,
                    font: "Arial",
                  }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    font: "Arial",
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
  // Normalize only this renderer's own ZIP output. No uploaded archive is extracted or rewritten.
  const original = await JSZip.loadAsync(await Packer.toBuffer(document)),
    normalized = new JSZip();
  for (const name of Object.keys(original.files).sort()) {
    const entry = original.files[name]!;
    if (entry.dir) continue;
    let body = await entry.async("nodebuffer");
    if (name === "docProps/core.xml")
      body = Buffer.from(
        body
          .toString("utf8")
          .replace(
            /(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:(?:created|modified)>)/g,
            `$1${new Date(entity.updatedAt).toISOString()}$2`,
          ),
      );
    normalized.file(name, body, {
      date: new Date("2000-01-01T00:00:00.000Z"),
      createFolders: false,
      unixPermissions: 0o100600,
    });
  }
  return normalized.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
    platform: "UNIX",
  });
}

/** Re-authenticate after asynchronous rendering and recheck the exact pinned domain snapshot. */
export async function exportDocument(
  workspace: WorkspaceStore,
  p: Principal,
  id: string,
  format: "pdf" | "docx",
  reauthenticate: () => Principal,
): Promise<Artifact<Buffer>> {
  const pinned = exportArtifact(workspace, p, "documents", id),
    entity = workspace.get(p, "documents", id);
  const blocks = blocksFor(entity),
    body = await (format === "pdf"
      ? pdf(entity, blocks)
      : docx(entity, blocks));
  const actor = reauthenticate();
  if (actor.id !== p.id || actor.tenantId !== p.tenantId)
    throw new DomainError(
      "FORBIDDEN",
      "Zmieniła się tożsamość pobierającego.",
      403,
    );
  const fresh = exportArtifact(workspace, actor, "documents", id);
  if (
    fresh.sha256 !== pinned.sha256 ||
    fresh.manifest.entityVersion !== entity.version
  )
    throw new DomainError(
      "DOCUMENT_EXPORT_CHANGED",
      "Dokument zmienił się podczas eksportu. Pobierz bieżącą wersję.",
      409,
    );
  const current = objects(entity.data.versions).find(
      (v) => v.revision === entity.data.revision,
    ),
    sha256 = createHash("sha256").update(body).digest("hex");
  return {
    filename: `document-${id}-v${entity.version}-${DOCUMENT_RENDERER}.${format}`,
    body,
    sha256,
    contentType:
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    manifest: {
      ...pinned.manifest,
      sha256,
      bytes: body.length,
      renderer: DOCUMENT_RENDERER,
      documentRevision: Number(entity.data.revision ?? 1),
      ...(current?.contentHash
        ? { contentHash: String(current.contentHash) }
        : {}),
      ...(current?.contextHash
        ? { contextHash: String(current.contextHash) }
        : {}),
    },
  };
}
