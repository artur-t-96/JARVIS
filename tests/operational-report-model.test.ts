import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportSnapshot,
  reportContent,
  reportPeriodIncludes,
  reportDefinitionSchema,
  type OperationalReportRow,
  type ReportContext,
} from "../src/operational-reports.js";
import { hash } from "../src/engine.js";
const context: ReportContext = {
  tenantId: "synthetic-a",
  companyName: "Firma A",
  timezone: "Europe/Warsaw",
  profileVersion: 1,
  now: "2026-09-09T22:30:00.000Z",
};
const row = (key = "one"): OperationalReportRow => ({
  key,
  title: "Sprzęt",
  fields: [
    { label: "Numer seryjny", value: "00000012" },
    { label: "Poświadczenie", value: null },
  ],
  warnings: ["Brak poświadczenia"],
  references: [
    {
      module: "assets",
      id: key,
      version: 2,
      hash: hash({ key }),
      updatedAt: "2026-09-09T08:00:00.000Z",
    },
  ],
  accessScopes: ["assets"],
  basisHash: hash({ key, version: 2 }),
});
test("a report fingerprint binds the whole set, tenant, evidence, profile and local day without drifting on every second", () => {
  const initial = buildReportSnapshot(context, { kind: "equipment" }, [
    row("one"),
    row("two"),
  ]);
  assert.equal(initial.reportDay, "2026-09-10");
  assert.equal(
    buildReportSnapshot(
      { ...context, now: "2026-09-09T22:31:00.000Z" },
      { kind: "equipment" },
      [row("two"), row("one")],
    ).previewHash,
    initial.previewHash,
  );
  for (const altered of [
    buildReportSnapshot(
      { ...context, tenantId: "synthetic-b" },
      { kind: "equipment" },
      [row("one"), row("two")],
    ),
    buildReportSnapshot(
      { ...context, profileVersion: 2 },
      { kind: "equipment" },
      [row("one"), row("two")],
    ),
    buildReportSnapshot(
      { ...context, now: "2026-09-10T23:30:00.000Z" },
      { kind: "equipment" },
      [row("one"), row("two")],
    ),
    buildReportSnapshot(context, { kind: "equipment" }, [
      row("one"),
      row("two"),
      row("new"),
    ]),
    buildReportSnapshot(context, { kind: "equipment" }, [
      { ...row("one"), basisHash: hash("new physical evidence") },
      row("two"),
    ]),
  ])
    assert.notEqual(altered.previewHash, initial.previewHash);
  assert.deepEqual(initial.requiredScopes, [
    "assets",
    "documents",
    "inventory",
  ]);
  assert.deepEqual(
    buildReportSnapshot(context, { kind: "equipment" }, [
      { ...row(), accessScopes: ["assets", "people"] },
    ]).requiredScopes,
    ["assets", "documents", "inventory", "people"],
  );
});
test("cost groups keep currencies, net/gross and full contract categories distinct; an unknown cost is never zero", () => {
  const rows = [
    {
      ...row("one"),
      money: {
        minor: 12345,
        currency: "PLN" as const,
        basis: "net" as const,
        category: "purchase_order" as const,
      },
    },
    {
      ...row("two"),
      money: {
        minor: 10,
        currency: "PLN" as const,
        basis: "net" as const,
        category: "purchase_order" as const,
      },
    },
    {
      ...row("three"),
      money: {
        minor: 12345,
        currency: "PLN" as const,
        basis: "gross" as const,
        category: "purchase_order" as const,
      },
    },
    {
      ...row("four"),
      money: {
        minor: 12345,
        currency: "EUR" as const,
        basis: "net" as const,
        category: "purchase_order" as const,
      },
    },
    {
      ...row("five"),
      money: {
        minor: 12345,
        currency: "PLN" as const,
        basis: "net" as const,
        category: "license_contract" as const,
      },
    },
    row("unknown"),
  ];
  const report = buildReportSnapshot(
    context,
    { kind: "commitments", from: "2026-09-01", to: "2026-09-30" },
    rows,
  );
  assert.equal(report.summary.money.length, 4);
  assert.equal(
    report.summary.money.find(
      (m) =>
        m.category === "purchase_order" &&
        m.currency === "PLN" &&
        m.basis === "net",
    )!.minor,
    12355,
  );
  assert.equal(report.rows.find((r) => r.key === "unknown")!.money, undefined);
  assert.match(reportContent(report), /Brak potwierdzonych danych/);
  assert.match(reportContent(report), /123,55 PLN netto/);
  assert.throws(() =>
    buildReportSnapshot(context, { kind: "equipment" }, [
      {
        ...row(),
        money: {
          minor: NaN,
          currency: "PLN",
          basis: "net",
          category: "purchase_order",
        },
      },
    ]),
  );
  assert.throws(() =>
    buildReportSnapshot(
      context,
      { kind: "equipment" },
      [1, 2].map((n) => ({
        ...row(String(n)),
        money: {
          minor: Number.MAX_SAFE_INTEGER,
          currency: "PLN",
          basis: "net",
          category: "purchase_order",
        },
      })),
    ),
  );
});
test("periods include missing dates explicitly, reject impossible dates and cover overlapping licence terms", () => {
  const def = reportDefinitionSchema.parse({
    kind: "commitments",
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.equal(reportPeriodIncludes(def, null), true);
  assert.equal(reportPeriodIncludes(def, "2026-01-01", "2026-12-31"), true);
  assert.equal(reportPeriodIncludes(def, "2026-08-31"), false);
  assert.equal(reportPeriodIncludes(def, "2026-09-30"), true);
  assert.throws(() => reportPeriodIncludes(def, "2026-02-30"));
  for (const invalid of [
    { kind: "starts", from: "2026-09-30", to: "2026-09-01" },
    { kind: "equipment", from: "2026-09-01", to: "2026-09-30" },
    { kind: "equipment", tenantId: "another" },
    { kind: "deliveries", from: "2026-02-30", to: "2026-09-01" },
  ])
    assert.equal(reportDefinitionSchema.safeParse(invalid).success, false);
});
test("limits and duplicate rows fail visibly; empty sets, identifiers and unsafe source text remain explicit", () => {
  assert.throws(
    () => buildReportSnapshot(context, { kind: "equipment" }, [row(), row()]),
    /powtórzone/,
  );
  assert.throws(
    () =>
      buildReportSnapshot(
        context,
        { kind: "equipment" },
        Array.from({ length: 201 }, (_, i) => row(String(i))),
      ),
    /Zawęź/,
  );
  const empty = buildReportSnapshot(context, { kind: "equipment" }, []);
  assert.equal(empty.summary.rows, 0);
  assert.match(reportContent(empty), /Brak lokalnych rekordów/);
  const source = row();
  source.title = "<script>\nInjected";
  source.fields.push({ label: "Stan", value: false });
  const body = reportContent(
    buildReportSnapshot(context, { kind: "equipment" }, [source]),
  );
  assert.match(body, /00000012/);
  assert.match(body, /Stan: Nie/);
  assert.doesNotMatch(body, /<script>|\nInjected/);
});
