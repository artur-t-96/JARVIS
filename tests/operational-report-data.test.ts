import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stocktakeFixture } from "./helpers/stocktake-fixture.js";
import { licenseFixture } from "./helpers/license-fixture.js";
const temporary = () => mkdtempSync(join(tmpdir(), "jarvis-report-data-"));
const field = (
  row: { fields: { label: string; value: unknown }[] },
  label: string,
) => row.fields.find((x) => x.label === label)?.value;
test("equipment reads current stocktake evidence, preserves the source record and binds new members of the filtered set", async () => {
  const dir = temporary(),
    f = stocktakeFixture(dir);
  try {
    const a = await f.newAsset(),
      b = await f.newAsset("synthetic-b");
    const initial = f.workspace.operationalReportPreview(f.actor(), {
      kind: "equipment",
    });
    assert.equal(initial.rows.length, 1);
    assert.equal(field(initial.rows[0]!, "Otwarte rozbieżności"), 0);
    const stock = await f.open([a.id]);
    const missing = f.observeInput(stock.id, a.id, { present: false });
    delete missing.location;
    delete missing.condition;
    await f.act(stock.id, "recordObservation", missing, undefined, "it-two");
    const changed = f.workspace.operationalReportPreview(f.actor(), {
      kind: "equipment",
    });
    assert.notEqual(changed.previewHash, initial.previewHash);
    assert.equal(field(changed.rows[0]!, "Otwarte rozbieżności"), 1);
    assert.equal(
      changed.rows[0]!.references.some((r) => r.id === stock.id),
      true,
    );
    assert.deepEqual(f.get("assets", a.id), a);
    const other = f.workspace.operationalReportPreview(
      f.actor("manager", "synthetic-b"),
      { kind: "equipment" },
    );
    assert.equal(other.rows.length, 1);
    assert.equal(other.rows[0]!.key, "assets:" + b.id);
    const second = await f.newAsset();
    const expanded = f.workspace.operationalReportPreview(f.actor(), {
      kind: "equipment",
    });
    assert.equal(expanded.rows.length, 2);
    assert.notEqual(expanded.previewHash, changed.previewHash);
    assert.throws(() =>
      f.workspace.operationalReportPreview(f.actor("it-one"), {
        kind: "equipment",
      }),
    );
    const db = new DatabaseSync(join(dir, "operations.sqlite"));
    db.prepare(
      "UPDATE ops_entities SET data_json=json_set(data_json,'$.location','Corrupted') WHERE id=?",
    ).run(second.id);
    db.close();
    assert.throws(
      () =>
        f.workspace.operationalReportPreview(f.actor(), { kind: "equipment" }),
      /historii/,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("readiness report describes the concrete episode and never turns a reservation into readiness", async () => {
  const dir = temporary(),
    f = stocktakeFixture(dir);
  try {
    const s = await f.seed();
    const report = f.workspace.operationalReportPreview(f.actor(), {
      kind: "starts",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    assert.equal(report.rows.length, 1);
    const row = report.rows[0]!;
    assert.equal(field(row, "Okres współpracy"), s.episodeId);
    assert.equal(field(row, "Gotowość potwierdzona"), false);
    assert.equal(field(row, "Aktualny odbiór"), false);
    assert.ok(row.warnings.length > 0);
    assert.ok(row.references.some((r) => r.id === s.personId));
    assert.equal(
      f.workspace.operationalReportPreview(f.actor("manager", "synthetic-b"), {
        kind: "starts",
        from: "2026-09-01",
        to: "2026-09-30",
      }).rows.length,
      0,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("purchase and licence reports distinguish unconfirmed costs, full order totals and confirmed contractual amounts", async () => {
  const dir = temporary(),
    f = licenseFixture(dir),
    definition = {
      kind: "commitments" as const,
      from: "2026-09-01",
      to: "2026-09-30",
    };
  try {
    const { pool, terms } = await f.seedLicense();
    const unknown = f.workspace.operationalReportPreview(f.actor(), definition);
    assert.equal(unknown.rows.length, 1);
    assert.equal(unknown.summary.money.length, 0);
    assert.equal(field(unknown.rows[0]!, "Pełna kwota"), null);
    const pending = await f.licenseAction(pool.id, "proposeTerms", { terms });
    await f.decision(pending.id);
    const decided = f.workspace.operationalReportPreview(f.actor(), definition);
    assert.equal(decided.summary.money.length, 0);
    await f.licenseAction(
      pending.id,
      "confirmTerms",
      f.confirmInput(pending.id),
    );
    const p = await f.seedPurchase();
    await f.select(p.request.id, p.quote.id);
    await f.approveCost(p.request.id, p.quote.id);
    await f.action(p.request.id, "placeOrder", f.orderInput(p.request.id));
    const report = f.workspace.operationalReportPreview(f.actor(), definition);
    assert.equal(report.rows.length, 2);
    assert.deepEqual(
      report.summary.money.map((m) => [
        m.category,
        m.minor,
        m.currency,
        m.basis,
      ]),
      [
        ["license_contract", 12345, "PLN", "gross"],
        ["purchase_order", 810000, "PLN", "gross"],
      ],
    );
    const delivery = f.workspace.operationalReportPreview(f.actor(), {
      kind: "deliveries",
      from: "2026-09-01",
      to: "2026-09-30",
    });
    assert.equal(delivery.rows.length, 1);
    assert.equal(field(delivery.rows[0]!, "Zamówiono"), 2);
    assert.equal(field(delivery.rows[0]!, "Brakujące ilości"), 2);
    assert.equal(
      field(delivery.rows[0]!, "Dostawa kompletna i potwierdzona"),
      false,
    );
    assert.equal(
      f.workspace.operationalReportPreview(
        f.actor("manager", "synthetic-b"),
        definition,
      ).rows.length,
      0,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
