import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  decodeAssetCsv,
  parseAssetCsv,
  MAX_ASSET_CSV_BYTES,
} from "../src/asset-import-csv.js";
const source = {
  filename: "urzadzenia.csv",
  sourceName: "Syntetyczna ewidencja",
  observedOn: "2026-09-09",
  delimiter: ";",
};
test("CSV imports preserve original BOM hash, quoted delimiters/newlines, serial zeros and explicit equipment state", () => {
  const body = Buffer.from(
    '\uFEFFnazwa;typ;numer_seryjny;lokalizacja;stan;producent;model\r\n"Laptop; ""A""";laptop;0000123;"Pokój 1\nPiętro 2";sprawny;Firma;"Model ""A"""\r\nTelefon;telefon;0000124;Magazyn;do naprawy;;\r\n',
  );
  const p = parseAssetCsv(body, source);
  assert.deepEqual(p.mappingErrors, []);
  assert.equal(
    p.source.sha256,
    createHash("sha256").update(body).digest("hex"),
  );
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows[0]!.asset, {
    title: 'Laptop; "A"',
    assetType: "laptop",
    serial: "0000123",
    location: "Pokój 1\nPiętro 2",
    condition: "good",
    manufacturer: "Firma",
    model: 'Model "A"',
  });
  assert.deepEqual([p.rows[0]!.firstLine, p.rows[0]!.lastLine], [2, 3]);
  assert.deepEqual(p.rows[1]!.asset, {
    title: "Telefon",
    assetType: "phone",
    serial: "0000124",
    location: "Magazyn",
    condition: "repair",
  });
});
test("CSV custom mappings are explicit, complete and unique; unknown source columns are never silently dropped", () => {
  const body = Buffer.from(
      "Label\tKind\tTag\tSite\tHealth\nLaptop\tlaptop\tS-1\tStock\tgood\n",
    ),
    s = { ...source, delimiter: "\t" };
  assert.ok(parseAssetCsv(body, s).mappingErrors.length);
  const mapping = {
    Label: "title",
    Kind: "assetType",
    Tag: "serial",
    Site: "location",
    Health: "condition",
  };
  const p = parseAssetCsv(body, { ...s, mapping });
  assert.deepEqual(p.mappingErrors, []);
  assert.equal(p.rows[0]!.asset!.serial, "S-1");
  assert.ok(
    parseAssetCsv(body, {
      ...s,
      mapping: { ...mapping, Site: "serial" },
    }).mappingErrors.some((e) => e.includes("więcej niż raz")),
  );
  assert.ok(
    parseAssetCsv(body, {
      ...s,
      mapping: { ...mapping, Absent: "model" },
    }).mappingErrors.some((e) => e.includes("nieistniejącą")),
  );
  assert.throws(() => parseAssetCsv(Buffer.from("nazwa;NAZWA\nA;B"), source));
  const pollution = parseAssetCsv(
    Buffer.from(
      "__proto__;typ;numer_seryjny;lokalizacja;stan\nLaptop;laptop;S-2;Stock;good",
    ),
    source,
  );
  assert.ok(pollution.mappingErrors.some((e) => e.includes("__proto__")));
  assert.equal(
    Object.getPrototypeOf(pollution.rows[0]!.values),
    Object.prototype,
  );
});
test("CSV detects every duplicate position and invalid record while treating source expressions as inert text", () => {
  const p = parseAssetCsv(
    Buffer.from(
      "title,asset_type,serial,location,condition\n=SUM(A1),laptop,001,Stock,good\n<script>,phone, 001 ,Stock,repair\nThird,invalid,003,,unknown",
    ),
    { ...source, delimiter: "," },
  );
  assert.ok(p.rows[0]!.errors.some((e) => e.includes("1, 2")));
  assert.ok(p.rows[1]!.errors.some((e) => e.includes("1, 2")));
  assert.equal(p.rows[0]!.asset!.title, "=SUM(A1)");
  assert.equal(p.rows[1]!.asset!.title, "<script>");
  assert.equal(p.rows[2]!.asset, null);
  assert.equal(p.rows[2]!.errors.length, 3);
  const gaps = parseAssetCsv(
    Buffer.from(
      "nazwa;typ;numer_seryjny;lokalizacja;stan\n\nA;laptop;S;Stock;good\n\n\nB;laptop;B;Stock;good",
    ),
    source,
  );
  assert.deepEqual(
    gaps.rows.map((r) => [r.firstLine, r.lastLine]),
    [
      [3, 3],
      [6, 6],
    ],
  );
});
test("CSV rejects malformed UTF-8, controls, quotes, columns, dates and bounded file/record counts", () => {
  const header = "nazwa;typ;numer_seryjny;lokalizacja;stan\n",
    row = "A;laptop;S-1;Stock;good\n";
  for (const b of [
    Buffer.from([0xff]),
    Buffer.from(header + row + "\0"),
    Buffer.from(header + '"never closed'),
    Buffer.from(header + "A;B"),
    Buffer.from(header + '"' + "x".repeat(17000) + '";laptop;S;Stock;good'),
    Buffer.from(header + row.repeat(501)),
    Buffer.alloc(MAX_ASSET_CSV_BYTES + 1),
  ])
    assert.throws(() => parseAssetCsv(b, source));
  assert.throws(() =>
    parseAssetCsv(Buffer.from(header + row), {
      ...source,
      observedOn: "2026-02-30",
    }),
  );
  assert.throws(() =>
    parseAssetCsv(Buffer.from(header + row), {
      ...source,
      filename: "../source.csv",
    }),
  );
  assert.throws(() => decodeAssetCsv("%%%="));
  assert.throws(() => decodeAssetCsv("ZE=="));
  assert.deepEqual(
    decodeAssetCsv(Buffer.alloc(MAX_ASSET_CSV_BYTES, 97).toString("base64")),
    Buffer.alloc(MAX_ASSET_CSV_BYTES, 97),
  );
  assert.deepEqual(
    decodeAssetCsv(Buffer.from(header + row).toString("base64")),
    Buffer.from(header + row),
  );
});
