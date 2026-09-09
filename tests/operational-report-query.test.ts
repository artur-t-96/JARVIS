import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { reportCandidateIds } from "../src/operational-report-query.js";
test("report membership refuses a truncated set and cannot hide missing or malformed dates behind a period filter", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE ops_entities(tenant_id TEXT,id TEXT,module TEXT,status TEXT,data_json TEXT)",
  );
  const insert = (tenant: string, id: string, module: string, data: unknown) =>
    db
      .prepare("INSERT INTO ops_entities VALUES(?,?,?,'available',?)")
      .run(tenant, id, module, JSON.stringify(data));
  try {
    for (let i = 0; i < 201; i++)
      insert("a", String(i), "assets", {
        location: i === 0 ? "Only one" : "Shared",
      });
    insert("b", "other", "assets", { location: "Only one" });
    assert.throws(
      () => reportCandidateIds(db, "a", { kind: "equipment" }, "assets"),
      { code: "REPORT_SCOPE_TOO_LARGE" },
    );
    assert.deepEqual(
      reportCandidateIds(
        db,
        "a",
        { kind: "equipment", location: "Only one" },
        "assets",
      ),
      ["0"],
    );
    for (const [id, date] of [
      ["good", "2026-09-10"],
      ["bad", "2026-09-31"],
      ["unknown", null],
      ["outside", "2027-01-01"],
    ])
      insert("a", String(id), "purchases", {
        kind: "order",
        expectedDelivery: date,
      });
    insert("b", "other-order", "purchases", {
      kind: "order",
      expectedDelivery: null,
    });
    assert.deepEqual(
      reportCandidateIds(
        db,
        "a",
        { kind: "deliveries", from: "2026-09-01", to: "2026-09-30" },
        "purchases",
      ),
      ["bad", "good", "unknown"],
    );
    insert("a", "pool", "licenses", { activeTermsId: "terms" });
    insert("b", "terms", "licenses", {
      kind: "license_terms",
      terms: { validFrom: "2027-01-01", expiresOn: "2027-12-31" },
    });
    assert.deepEqual(
      reportCandidateIds(
        db,
        "a",
        { kind: "commitments", from: "2026-09-01", to: "2026-09-30" },
        "licenses",
      ),
      ["pool"],
    );
  } finally {
    db.close();
  }
});
