import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
const { ImportRows, ImportReport } = await tsImport(
  "../web/src/AssetImports.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
test("CSV approval view escapes source text and separates selected records, existing records and incomplete rows", () => {
  const row = {
    sourceRow: 1,
    firstLine: 2,
    lastLine: 3,
    values: { nazwa: "<script>alert('source')</script>", serial: "0000123" },
    asset: {
      title: "<b>literal title</b>",
      serial: "0000123",
      location: "Stock",
      assetType: "laptop",
      condition: "good",
    },
    errors: [],
    existing: [],
    eligible: true,
  };
  const html = renderToStaticMarkup(
    createElement(ImportRows, {
      rows: [
        row,
        {
          ...row,
          sourceRow: 2,
          eligible: false,
          existing: [{ id: "existing", title: "Existing asset", version: 9 }],
        },
        {
          ...row,
          sourceRow: 3,
          asset: null,
          eligible: false,
          errors: ["Missing location"],
        },
      ],
      selected: [1],
      onSelect: () => {},
    }),
  );
  assert.match(html, /0000123/);
  assert.match(html, /Wiersze 2–3/);
  assert.match(html, /checked=""/);
  assert.match(html, /Już istnieje/);
  assert.match(html, /Zostanie pominięty/);
  assert.match(html, /Missing location/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|<b>literal/);
  assert.match(html, /aria-label="Importuj pozycję 2" disabled=""/);
});
test("an invalid source never renders a successful receipt or permits the original download", () => {
  const html = renderToStaticMarkup(
    createElement(ImportReport, {
      report: {
        id: "i",
        valid: false,
        actorId: "operator",
        approvedBy: "reviewer",
        importedAt: "2026-09-08T10:00:00Z",
        runId: "r",
        source: {
          note: "EXPLICIT_SKIPS",
          source: {
            sourceName: "Synthetic",
            filename: "source.csv",
            observedOn: "2026-09-08",
            sha256: "hash",
          },
        },
        created: [
          {
            id: "asset",
            title: "New",
            serial: "0000123",
            sourceRow: 1,
            firstLine: 2,
            lastLine: 2,
          },
        ],
        skippedRows: [2, 3],
      },
    }),
  );
  assert.match(html, /Nie udało się potwierdzić/);
  assert.match(html, /disabled=""[^>]*>Pobierz oryginalny CSV/);
  assert.match(html, /EXPLICIT_SKIPS/);
  assert.match(html, /2, 3/);
  assert.match(html, /Nie zastępuje protokołu fizycznego wydania/);
  assert.doesNotMatch(html, /są zgodne/);
});
