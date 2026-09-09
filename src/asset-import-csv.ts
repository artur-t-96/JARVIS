import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { DomainError } from "./contracts.js";
import {
  equipmentSerialKey,
  equipmentType,
} from "./purchase-delivery-models.js";
import { fileNameSchema } from "./document-files.js";

export const ASSET_CSV_PARSER = "csv-parse@7.0.2" as const;
export const MAX_ASSET_CSV_BYTES = 512 * 1024;
export const assetImportFields = [
  "title",
  "assetType",
  "serial",
  "location",
  "condition",
  "manufacturer",
  "model",
] as const;
export type AssetImportField = (typeof assetImportFields)[number];
const short = z.string().trim().min(1).max(200);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Niepoprawna data źródła");
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const assetImportMappingSchema = z.record(
  z.string().min(1).max(160),
  z.enum(assetImportFields),
);
export const assetImportSourceSchema = z
  .object({
    filename: fileNameSchema.refine(
      (v) => v.toLowerCase().endsWith(".csv"),
      "Wybierz plik CSV",
    ),
    sourceName: short,
    observedOn: day,
    delimiter: z.enum([";", ",", "\t"]),
    mapping: assetImportMappingSchema.optional(),
  })
  .strict();
export const assetImportPreviewSchema = assetImportSourceSchema
  .extend({
    contentBase64: z
      .string()
      .min(4)
      .max(Math.ceil(MAX_ASSET_CSV_BYTES / 3) * 4),
  })
  .strict();
const selectedRows = z
  .array(z.number().int().min(1).max(500))
  .min(1)
  .max(200)
  .refine(
    (rows) => new Set(rows).size === rows.length,
    "Powtórzona pozycja źródła",
  );
export const assetImportPrepareSchema = assetImportPreviewSchema
  .extend({
    uploadId: z.string().uuid(),
    previewHash: fingerprint,
    selectedRows,
    profileVersion: z.number().int().nonnegative(),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export const assetImportCommandSchema = z
  .object({
    uploadId: z.string().uuid(),
    manifestHash: fingerprint,
    previewHash: fingerprint,
    sha256: fingerprint,
    filename: assetImportSourceSchema.shape.filename,
    sourceName: short,
    observedOn: day,
    parserVersion: z.literal(ASSET_CSV_PARSER),
    bytes: z.number().int().positive().max(MAX_ASSET_CSV_BYTES),
    selectedRows,
    profileVersion: z.number().int().nonnegative(),
    expiresAt: z.string().datetime(),
    note: z.string().trim().min(1).max(2000),
  })
  .strict();
export type AssetImportCommand = z.infer<typeof assetImportCommandSchema>;
export type AssetImportSource = z.infer<typeof assetImportSourceSchema>;
const valuesSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    assetType: equipmentType,
    serial: short,
    location: short,
    condition: z.enum(["good", "repair"]),
    manufacturer: short.optional(),
    model: short.optional(),
  })
  .strict();
export type ImportedAssetValues = z.infer<typeof valuesSchema>;
export interface AssetCsvRow {
  sourceRow: number;
  firstLine: number;
  lastLine: number;
  values: Record<string, string>;
  asset: ImportedAssetValues | null;
  serialKey: string | null;
  errors: string[];
}
const key = (v: string) =>
  v
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("pl")
    .replace(/[\s-]+/g, "_");
const aliases: Record<string, AssetImportField> = {
  nazwa: "title",
  title: "title",
  name: "title",
  typ: "assetType",
  rodzaj: "assetType",
  assettype: "assetType",
  asset_type: "assetType",
  type: "assetType",
  numer_seryjny: "serial",
  serial: "serial",
  serial_number: "serial",
  lokalizacja: "location",
  location: "location",
  stan: "condition",
  condition: "condition",
  producent: "manufacturer",
  manufacturer: "manufacturer",
  model: "model",
};
const requiredFields: AssetImportField[] = [
  "title",
  "assetType",
  "serial",
  "location",
  "condition",
];
export const assetImportFieldLabels: Record<AssetImportField, string> = {
  title: "Nazwa",
  assetType: "Rodzaj sprzętu",
  serial: "Numer seryjny",
  location: "Lokalizacja",
  condition: "Stan techniczny",
  manufacturer: "Producent",
  model: "Model",
};
const types: Record<string, string> = {
  laptop: "laptop",
  desktop: "desktop",
  komputer: "desktop",
  komputer_stacjonarny: "desktop",
  phone: "phone",
  telefon: "phone",
  monitor: "monitor",
  accessory: "accessory",
  akcesoria: "accessory",
  other: "other",
  inne: "other",
};
const conditions: Record<string, string> = {
  good: "good",
  sprawny: "good",
  repair: "repair",
  do_naprawy: "repair",
  wymaga_naprawy: "repair",
  uszkodzony: "repair",
};
function fail(
  message: string,
  code = "ASSET_CSV_INVALID",
  status = 400,
): never {
  throw new DomainError(code, message, status);
}
export function decodeAssetCsv(encoded: string): Buffer {
  if (encoded.length > Math.ceil(MAX_ASSET_CSV_BYTES / 3) * 4)
    fail("Nieprawidłowa zawartość przesłanego pliku.");
  const body = Buffer.from(encoded, "base64");
  if (body.toString("base64") !== encoded)
    fail("Nieprawidłowa zawartość przesłanego pliku.");
  if (!body.length || body.length > MAX_ASSET_CSV_BYTES)
    fail("Plik musi mieć od 1 bajtu do 512 KiB.", "ASSET_CSV_SIZE", 413);
  return body;
}
/** Bounded OSS parsing; every identifier remains text and no source is executed. */
export function parseAssetCsv(body: Buffer, rawSource: unknown) {
  const source = assetImportSourceSchema.parse(rawSource);
  if (!body.length || body.length > MAX_ASSET_CSV_BYTES)
    fail("Plik musi mieć od 1 bajtu do 512 KiB.", "ASSET_CSV_SIZE", 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    fail("Plik musi być zapisany jako poprawny UTF-8.");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    fail("Plik zawiera niedozwolone znaki sterujące.");
  let records: {
    record: string[];
    info: { lines: number; empty_lines: number };
  }[];
  try {
    // The sync overload omits the info:true result shape in csv-parse 7.0.2.
    records = parse(text, {
      bom: true,
      delimiter: source.delimiter,
      cast: false,
      columns: false,
      info: true,
      skip_empty_lines: true,
      max_record_size: 16 * 1024,
    }) as unknown as typeof records;
  } catch {
    fail(
      "CSV ma niepoprawne cudzysłowy, liczbę kolumn lub zbyt długi rekord. Sprawdź separator i format pliku.",
    );
  }
  if (records.length < 2 || records.length > 501)
    fail("CSV musi zawierać nagłówek i od 1 do 500 rekordów.");
  const header = records[0]!,
    headers = header.record.map((v) => v.trim());
  if (
    !headers.length ||
    headers.length > 7 ||
    headers.some((v) => !v || v.length > 160 || /[\r\n]/.test(v))
  )
    fail(
      "Nagłówek musi zawierać od 1 do 7 niepustych nazw kolumn, do 160 znaków.",
    );
  if (new Set(headers.map(key)).size !== headers.length)
    fail("Nazwy kolumn nie mogą się powtarzać.");
  const mapping: Record<string, AssetImportField> = Object.fromEntries(
    headers.flatMap((h) => {
      const field = Object.hasOwn(source.mapping ?? {}, h)
        ? source.mapping![h]
        : Object.hasOwn(aliases, key(h))
          ? aliases[key(h)]
          : undefined;
      return field ? [[h, field]] : [];
    }),
  );
  const mappingErrors: string[] = [];
  for (const h of Object.keys(source.mapping ?? {}))
    if (!headers.includes(h))
      mappingErrors.push(`Mapowanie wskazuje nieistniejącą kolumnę: ${h}.`);
  for (const h of headers)
    if (!Object.hasOwn(mapping, h))
      mappingErrors.push(`Przypisz pole kolumnie „${h}” albo usuń ją z pliku.`);
  for (const field of assetImportFields) {
    const count = Object.values(mapping).filter((f) => f === field).length;
    if (count > 1)
      mappingErrors.push(
        `Pole „${assetImportFieldLabels[field]}” jest przypisane więcej niż raz.`,
      );
    if (requiredFields.includes(field) && count === 0)
      mappingErrors.push(`Brak kolumny „${assetImportFieldLabels[field]}”.`);
  }
  let previousLine = header.info.lines,
    previousEmptyLines = header.info.empty_lines;
  const rows: AssetCsvRow[] = records.slice(1).map((r, i) => {
    const raw = Object.fromEntries(
        headers.map((h, index) => [h, r.record[index]!.trim()]),
      ),
      mapped: Record<string, string> = {};
    for (const h of headers) {
      const field = Object.hasOwn(mapping, h) ? mapping[h] : undefined;
      if (field && (raw[h] || requiredFields.includes(field)))
        mapped[field] = raw[h]!;
    }
    if (mapped.assetType)
      mapped.assetType = Object.hasOwn(types, key(mapped.assetType))
        ? types[key(mapped.assetType)]!
        : mapped.assetType;
    if (mapped.condition)
      mapped.condition = Object.hasOwn(conditions, key(mapped.condition))
        ? conditions[key(mapped.condition)]!
        : mapped.condition;
    const parsed = valuesSchema.safeParse(mapped),
      errors = parsed.success
        ? []
        : [
            ...new Set(
              parsed.error.issues.map(
                (e) =>
                  `Pole „${assetImportFieldLabels[e.path[0] as AssetImportField] ?? String(e.path[0])}” jest puste lub niepoprawne.`,
              ),
            ),
          ];
    const row: AssetCsvRow = {
      sourceRow: i + 1,
      firstLine: previousLine + 1 + r.info.empty_lines - previousEmptyLines,
      lastLine: r.info.lines,
      values: raw,
      asset: parsed.success ? parsed.data : null,
      serialKey: mapped.serial ? equipmentSerialKey(mapped.serial) : null,
      errors,
    };
    previousLine = r.info.lines;
    previousEmptyLines = r.info.empty_lines;
    return row;
  });
  const seen = new Map<string, number[]>();
  for (const row of rows)
    if (row.serialKey)
      seen.set(row.serialKey, [
        ...(seen.get(row.serialKey) ?? []),
        row.sourceRow,
      ]);
  for (const row of rows)
    if (row.serialKey && seen.get(row.serialKey)!.length > 1)
      row.errors.push(
        `Numer seryjny powtarza się w pozycjach ${seen.get(row.serialKey)!.join(", ")}.`,
      );
  return {
    source: {
      ...source,
      mapping,
      parserVersion: ASSET_CSV_PARSER,
      bytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
    headers,
    mapping,
    mappingErrors,
    rows,
  };
}
