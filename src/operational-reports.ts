import { z } from "zod";
import { DomainError, type JsonObject } from "./contracts.js";
import { hash } from "./engine.js";
import { companyDay } from "./company-calendar.js";

export const REPORT_GENERATOR = "p09b1-1" as const;
export const MAX_REPORT_ROWS = 200;
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(v + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Niepoprawna data kalendarzowa");
const short = z.string().trim().min(1).max(200);
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const reportDefinitionSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("equipment"),
        location: short.optional(),
        status: z
          .enum(["available", "reserved", "issued", "maintenance", "retired"])
          .optional(),
      })
      .strict(),
    ...(["starts", "deliveries", "commitments"] as const).map((kind) =>
      z.object({ kind: z.literal(kind), from: day, to: day }).strict(),
    ),
  ])
  .refine(
    (v) => !("from" in v) || v.from <= v.to,
    "Koniec okresu poprzedza początek",
  );
export type ReportDefinition = z.infer<typeof reportDefinitionSchema>;
export type ReportKind = ReportDefinition["kind"];
export const reportKinds: Record<
  ReportKind,
  { title: string; scopes: string[]; period: string | null }
> = {
  equipment: {
    title: "Wyposażenie i rozbieżności",
    scopes: ["assets", "inventory"],
    period: null,
  },
  starts: {
    title: "Gotowość rozpoczęcia współpracy",
    scopes: ["cases", "people", "assets", "inventory", "licenses", "it"],
    period: "Data rozpoczęcia współpracy",
  },
  deliveries: {
    title: "Dostawy i rozbieżności",
    scopes: ["purchases"],
    period: "Planowany termin dostawy",
  },
  commitments: {
    title: "Zobowiązania zakupowe i licencyjne",
    scopes: ["purchases", "licenses"],
    period:
      "Planowany termin dostawy zamówienia lub okres bieżącej umowy licencji",
  },
};
export const createReportSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    previewId: z.string().uuid(),
    definition: reportDefinitionSchema,
    previewHash: fingerprint,
    profileVersion: z.number().int().nonnegative(),
  })
  .strict();
export const refreshReportSchema = createReportSchema
  .extend({
    id: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    changeNote: z.string().trim().min(1).max(2000),
  })
  .strict();
export const prepareReportSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    definition: reportDefinitionSchema,
    previewHash: fingerprint,
    profileVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().uuid(),
    id: z.string().uuid().optional(),
    expectedVersion: z.number().int().positive().optional(),
    changeNote: z.string().trim().min(1).max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.id
        ? v.expectedVersion !== undefined && v.changeNote !== undefined
        : v.expectedVersion === undefined && v.changeNote === undefined,
    "Odświeżenie wymaga dokumentu, wersji i przyczyny.",
  );
export interface ReportReference {
  module: string;
  id: string;
  version: number;
  hash: string;
  updatedAt: string;
}
export interface ReportMoney {
  minor: number;
  currency: "PLN" | "EUR" | "USD";
  basis: "net" | "gross";
  category: "purchase_order" | "license_contract";
}
export interface OperationalReportRow {
  key: string;
  title: string;
  fields: { label: string; value: string | number | boolean | null }[];
  warnings: string[];
  references: ReportReference[];
  accessScopes: string[];
  /** Includes independently checked relationship evidence; never shown as a health status. */
  basisHash: string;
  money?: ReportMoney;
}
export interface OperationalReportSnapshot {
  generator: typeof REPORT_GENERATOR;
  definition: ReportDefinition;
  companyName: string;
  timezone: string;
  profileVersion: number;
  capturedAt: string;
  reportDay: string;
  rows: OperationalReportRow[];
  requiredScopes: string[];
  summary: { rows: number; withWarnings: number; money: ReportMoney[] };
  previewHash: string;
}
export interface ReportContext {
  tenantId: string;
  companyName: string;
  timezone: string;
  profileVersion: number;
  now: string;
}
const area = z.enum([
  "people",
  "cases",
  "assets",
  "inventory",
  "purchases",
  "licenses",
  "sales",
  "recruitment",
  "documents",
  "it",
]);
const moneySchema = z
  .object({
    minor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.enum(["PLN", "EUR", "USD"]),
    basis: z.enum(["net", "gross"]),
    category: z.enum(["purchase_order", "license_contract"]),
  })
  .strict();
const snapshotSchema = z
  .object({
    generator: z.literal(REPORT_GENERATOR),
    definition: reportDefinitionSchema,
    companyName: z.string().min(1).max(200),
    timezone: z.string().min(1).max(100),
    profileVersion: z.number().int().nonnegative(),
    capturedAt: z.string().datetime({ offset: true }),
    reportDay: day,
    rows: z
      .array(
        z
          .object({
            key: z.string().min(1).max(200),
            title: z.string().min(1).max(200),
            fields: z
              .array(
                z
                  .object({
                    label: short,
                    value: z.union([
                      z.string().max(10000),
                      z.number().finite(),
                      z.boolean(),
                      z.null(),
                    ]),
                  })
                  .strict(),
              )
              .max(100),
            warnings: z.array(z.string().max(10000)).max(500),
            references: z
              .array(
                z
                  .object({
                    module: area,
                    id: z.string().uuid(),
                    version: z.number().int().positive(),
                    hash: fingerprint,
                    updatedAt: z.string().datetime({ offset: true }),
                  })
                  .strict(),
              )
              .min(1)
              .max(1000),
            accessScopes: z.array(area).max(10),
            basisHash: fingerprint,
            money: moneySchema.optional(),
          })
          .strict(),
      )
      .max(MAX_REPORT_ROWS),
    requiredScopes: z.array(area).max(10),
    summary: z
      .object({
        rows: z.number().int().nonnegative(),
        withWarnings: z.number().int().nonnegative(),
        money: z.array(moneySchema).max(12),
      })
      .strict(),
    previewHash: fingerprint,
  })
  .strict();
/** Verifies an immutable generated revision without consulting mutable live sources. */
export function readReportSnapshot(
  tenantId: string,
  raw: unknown,
  content?: string,
): OperationalReportSnapshot {
  const snapshot = snapshotSchema.parse(raw);
  const rebuilt = buildReportSnapshot(
    {
      tenantId,
      companyName: snapshot.companyName,
      timezone: snapshot.timezone,
      profileVersion: snapshot.profileVersion,
      now: snapshot.capturedAt,
    },
    snapshot.definition,
    snapshot.rows,
  );
  if (
    hash(snapshot) !== hash(rebuilt) ||
    (content !== undefined && reportContent(rebuilt) !== content)
  )
    fail(
      "Zapis raportu nie odpowiada generatorowi, zakresowi lub sumom źródeł.",
      "REPORT_SNAPSHOT_INCONSISTENT",
    );
  return snapshot;
}
const text = (value: unknown) =>
  String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[<>]/g, "");
const valueLabel = (value: string | number | boolean | null) =>
  value === null
    ? "Brak potwierdzonych danych"
    : typeof value === "boolean"
      ? value
        ? "Tak"
        : "Nie"
      : text(value);
function fail(message: string, code = "REPORT_SOURCE_INCONSISTENT"): never {
  throw new DomainError(code, message, 409);
}
export function reportRequiredScopes(definition: unknown): string[] {
  return [
    "documents",
    ...reportKinds[reportDefinitionSchema.parse(definition).kind].scopes,
  ];
}
/** Dates with no source stay explicitly included; a filter cannot turn missing dates into absence. */
export function reportPeriodIncludes(
  definition: ReportDefinition,
  start: string | null,
  end = start,
): boolean {
  if (!("from" in definition)) return true;
  if (
    (start !== null && !day.safeParse(start).success) ||
    (end !== null && !day.safeParse(end).success) ||
    (start !== null && end !== null && start > end)
  )
    fail("Źródło zawiera nieprawidłowy okres.");
  if (start === null || end === null) return true;
  return start <= definition.to && end >= definition.from;
}
export function buildReportSnapshot(
  context: ReportContext,
  rawDefinition: unknown,
  inputRows: OperationalReportRow[],
): OperationalReportSnapshot {
  const definition = reportDefinitionSchema.parse(rawDefinition);
  if (inputRows.length > MAX_REPORT_ROWS)
    fail(
      `Zakres zawiera więcej niż ${MAX_REPORT_ROWS} pozycji. Zawęź filtr, aby zapisać kompletny raport.`,
      "REPORT_SCOPE_TOO_LARGE",
    );
  if (new Set(inputRows.map((r) => r.key)).size !== inputRows.length)
    fail("Źródło raportu zawiera powtórzone pozycje.");
  const rows = structuredClone(inputRows).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  const sums = new Map<string, ReportMoney>();
  for (const row of rows) {
    fingerprint.parse(row.basisHash);
    if (!row.references.length) fail("Pozycja raportu nie ma źródła.");
    for (const ref of row.references) {
      fingerprint.parse(ref.hash);
      if (!Number.isInteger(ref.version) || ref.version < 1)
        fail("Źródło nie ma potwierdzonej wersji.");
    }
    for (const field of row.fields)
      if (typeof field.value === "number" && !Number.isFinite(field.value))
        fail("Źródło raportu zawiera niepoprawną liczbę.");
    if (row.money) {
      const m = row.money;
      if (
        !Number.isSafeInteger(m.minor) ||
        m.minor < 0 ||
        !["PLN", "EUR", "USD"].includes(m.currency) ||
        !["net", "gross"].includes(m.basis) ||
        !["purchase_order", "license_contract"].includes(m.category)
      )
        fail("Nie można potwierdzić kwoty, waluty i podstawy kosztu.");
      const key = `${m.category}:${m.currency}:${m.basis}`,
        sum = (sums.get(key)?.minor ?? 0) + m.minor;
      if (!Number.isSafeInteger(sum))
        fail("Suma przekracza dokładny zakres liczb.", "REPORT_TOTAL_LIMIT");
      sums.set(key, { ...m, minor: sum });
    }
  }
  const body = {
    generator: REPORT_GENERATOR,
    definition,
    companyName: context.companyName,
    timezone: context.timezone,
    profileVersion: context.profileVersion,
    reportDay: companyDay(context.now, context.timezone),
    rows,
    requiredScopes: [
      ...new Set([
        ...reportRequiredScopes(definition),
        ...rows.flatMap((row) => row.accessScopes),
      ]),
    ].sort(),
    summary: {
      rows: rows.length,
      withWarnings: rows.filter((r) => r.warnings.length > 0).length,
      money: [...sums.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, m]) => m),
    },
  };
  return {
    ...body,
    capturedAt: context.now,
    previewHash: hash({ tenantId: context.tenantId, ...body }),
  };
}
export function reportMoneyLabel(m: ReportMoney): string {
  return `${new Intl.NumberFormat("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(m.minor / 100)} ${m.currency} ${m.basis === "net" ? "netto" : "brutto"}`;
}
/** Deterministic plain text sections, compatible with the existing DOCX/PDF renderer. */
export function reportContent(snapshot: OperationalReportSnapshot): string {
  const lines = [
    `# ${reportKinds[snapshot.definition.kind].title}`,
    `Firma: ${text(snapshot.companyName)}`,
    `Stan zapisanych danych: ${text(snapshot.capturedAt)} · strefa ${text(snapshot.timezone)}.`,
    "",
    "Zakres obejmuje wyłącznie lokalną ewidencję JARVIS. Brak wpisu nie dowodzi braku zdarzenia poza systemem.",
    "",
  ];
  if ("from" in snapshot.definition)
    lines.push(
      `${reportKinds[snapshot.definition.kind].period}: ${snapshot.definition.from}–${snapshot.definition.to}. Pozycje bez daty pozostają jawnie oznaczone.`,
      "",
    );
  if (snapshot.definition.kind === "equipment")
    lines.push(
      `Filtr lokalizacji: ${text(snapshot.definition.location ?? "wszystkie")}. Filtr stanu: ${text(snapshot.definition.status ?? "wszystkie")}.`,
      "",
    );
  lines.push(
    "## Podsumowanie",
    `Liczba pozycji: ${snapshot.rows.length}. Pozycje z brakami lub uwagami: ${snapshot.summary.withWarnings}.`,
    "",
  );
  if (!snapshot.rows.length)
    lines.push("Brak lokalnych rekordów w wybranym zakresie.", "");
  for (const money of snapshot.summary.money)
    lines.push(
      `- ${money.category === "purchase_order" ? "Pełna kwota zamówień" : "Pełna kwota poświadczonych umów licencji"}: ${reportMoneyLabel(money)}.`,
    );
  if (snapshot.definition.kind === "commitments")
    lines.push(
      "",
      "Kwoty obejmują pełne zamówienia lub umowy pasujące do zakresu, bez proporcjonalnego naliczania okresu. Waluty, netto/brutto i kategorie są rozdzielone. Raport nie potwierdza zaksięgowania ani płatności.",
      "",
    );
  for (const [index, row] of snapshot.rows.entries()) {
    lines.push(`## ${index + 1}. ${text(row.title)}`);
    for (const field of row.fields)
      lines.push(`- ${text(field.label)}: ${valueLabel(field.value)}`);
    for (const warning of row.warnings)
      lines.push(`- Wymaga uwagi: ${text(warning)}`);
    for (const ref of row.references)
      lines.push(
        `- Źródło: ${text(ref.module)} / ${text(ref.id)}, wersja ${ref.version}, zapis ${text(ref.updatedAt)}. SHA-256: ${ref.hash}`,
      );
    lines.push("");
  }
  const result = lines.join("\n");
  if (result.length > 50_000)
    fail(
      "Raport przekracza limit treści dokumentu. Zawęź zakres.",
      "REPORT_CONTENT_LIMIT",
    );
  return result;
}
export const reportAsJson = (snapshot: OperationalReportSnapshot): JsonObject =>
  JSON.parse(JSON.stringify(snapshot)) as JsonObject;
