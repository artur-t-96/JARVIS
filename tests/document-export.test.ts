import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { exportDocument } from "../src/document-export.js";
import { materializeArtifact } from "../src/artifacts.js";
import { DomainError } from "../src/contracts.js";
import { fileHash, validateDocumentFile } from "../src/document-files.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import {
  seedFileDocument,
  stageFile,
} from "./helpers/document-file-fixture.js";
import {
  approveDocument,
  reviseDocumentCase,
} from "./helpers/document-fixture.js";
const code = (value: string) => (e: unknown) =>
  e instanceof DomainError && e.code === value;
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-document-export-")),
    f = custodyFixture(dir);
  t.after(() => {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, f };
}
test("DOCX and PDF pin Polish content, provenance and file hashes, produce deterministic bytes, and materialize idempotently", async (t) => {
  const { dir, f } = fixture(t),
    { documentId } = await seedFileDocument(f),
    input = await stageFile(f, documentId);
  await f.complete("ops.documents.attachFile", input);
  await f.complete("ops.documents.revise", {
    id: documentId,
    expectedVersion: 2,
    content:
      "# Odbiór współpracy\n\nZażółć gęślą jaźń.\n\n- Potwierdzenie wyposażenia\n- Wymagane dokumenty\n\n<script>Nie wykonuj</script>\n![obraz](https://never-fetch.invalid/secret)",
    changeNote: "Synthetic Unicode and inactive content",
  });
  await approveDocument(f, documentId);
  for (const format of ["docx", "pdf"] as const) {
    const a = await exportDocument(
      f.workspace,
      f.actor(),
      documentId,
      format,
      () => f.actor(),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await exportDocument(
      f.workspace,
      f.actor(),
      documentId,
      format,
      () => f.actor(),
    );
    assert.equal(a.sha256, b.sha256);
    assert.deepEqual(a.body, b.body);
    assert.equal(a.manifest.sha256, fileHash(a.body));
    assert.equal(a.manifest.documentRevision, 3);
    assert.ok(a.manifest.contextHash);
    await validateDocumentFile(a.filename, a.contentType, a.body);
    materializeArtifact(dir, a);
    materializeArtifact(dir, b);
    const path = join(
      dir,
      "evidence",
      "exports",
      fileHash("synthetic-a"),
      a.filename,
    );
    assert.deepEqual(readFileSync(path), a.body);
    writeFileSync(path, Buffer.from("synthetic corruption"));
    assert.throws(() => materializeArtifact(dir, a), code("ARTIFACT_CONFLICT"));
    if (format === "docx") {
      const zip = await JSZip.loadAsync(a.body),
        xml = await zip.file("word/document.xml")!.async("string");
      assert.match(xml, /Zażółć gęślą jaźń/);
      assert.match(xml, /Zatwierdzony/);
      assert.match(xml, /Odbiór współpracy.txt/);
      assert.ok(xml.includes(String(input.sha256)));
      assert.match(xml, /&lt;script&gt;Nie wykonuj&lt;\/script&gt;/);
      assert.ok(!xml.includes("<script>"));
      for (const name of Object.keys(zip.files)) {
        assert.ok(!/vbaProject|embeddings|activeX/.test(name));
        if (name.endsWith(".rels"))
          assert.ok(
            !(await zip.file(name)!.async("string")).includes(
              'TargetMode="External"',
            ),
          );
      }
      const props = await zip.file("docProps/core.xml")!.async("string");
      assert.match(props, /2026-09-08T10:00:00.000Z/);
    } else {
      assert.match(a.body.subarray(0, 10).toString(), /^%PDF-/);
      assert.match(a.body.toString("latin1"), /\/ToUnicode/);
      assert.match(a.body.toString("latin1"), /NotoSans/);
      assert.ok(!a.body.toString("latin1").includes("/JavaScript"));
    }
  }
});
test("binary export re-authenticates after rendering and rejects changed data, stale acceptance and foreign scopes", async (t) => {
  const { f } = fixture(t),
    { documentId, caseId } = await seedFileDocument(f);
  for (const format of ["pdf", "docx"] as const) {
    await assert.rejects(
      exportDocument(f.workspace, f.actor(), documentId, format, () => ({
        ...f.actor(),
        scopes: [],
      })),
      (e) => e instanceof DomainError && e.statusCode === 403,
    );
    await assert.rejects(
      exportDocument(
        f.workspace,
        f.actor("manager", "synthetic-b"),
        documentId,
        format,
        () => f.actor(),
      ),
      (e) => e instanceof DomainError && e.statusCode === 404,
    );
  }
  const render = exportDocument(
    f.workspace,
    f.actor(),
    documentId,
    "docx",
    () => f.actor(),
  );
  await f.complete("ops.documents.revise", {
    id: documentId,
    expectedVersion: 1,
    content: "Changed during async render",
    changeNote: "Synthetic concurrency",
  });
  await assert.rejects(render, code("DOCUMENT_EXPORT_CHANGED"));
  await approveDocument(f, documentId);
  await reviseDocumentCase(f, caseId);
  await assert.rejects(
    exportDocument(f.workspace, f.actor(), documentId, "pdf", () => f.actor()),
    code("DOCUMENT_APPROVAL_STALE"),
  );
});
