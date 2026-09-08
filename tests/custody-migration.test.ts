import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { WorkspaceStore } from "../src/workspace.js";
import type { Principal } from "../src/contracts.js";

const now = "2026-09-08T10:00:00.000Z";
test("v4 custody migration rolls back completely and preserves unresolved authors, periods and physical facts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-custody-v4-")),
    path = join(directory, "operations.sqlite");
  let store: WorkspaceStore | undefined, db: DatabaseSync | undefined;
  try {
    new WorkspaceStore(path).close();
    db = new DatabaseSync(path);
    db.exec(
      "DROP TABLE ops_asset_register_events; DROP TABLE ops_asset_events; ALTER TABLE ops_tasks DROP COLUMN template_key; DELETE FROM schema_versions_operations WHERE version>=5",
    );
    for (const column of [
      "version",
      "expires_at",
      "timezone",
      "profile_version",
      "created_at",
      "updated_at",
      "provenance",
      "issue_event_id",
      "return_event_id",
      "last_event_id",
    ])
      db.exec(`ALTER TABLE ops_allocations DROP COLUMN ${column}`);
    const person = randomUUID(),
      reserved = randomUUID(),
      issued = randomUUID(),
      reservedAllocation = randomUUID(),
      issuedAllocation = randomUUID();
    const insert = db.prepare(
      "INSERT INTO ops_entities(tenant_id,id,module,title,status,version,data_json,created_at,updated_at) VALUES('legacy',?,?,?,?,1,?,?,?)",
    );
    insert.run(
      person,
      "people",
      "Synthetic historical person",
      "registered",
      JSON.stringify({ personCategory: "internal" }),
      now,
      now,
    );
    for (const [id, status, allocationId] of [
      [reserved, "reserved", reservedAllocation],
      [issued, "issued", issuedAllocation],
    ]) {
      insert.run(
        id!,
        "assets",
        "Synthetic historical asset",
        status!,
        JSON.stringify({
          assetType: "laptop",
          serial: id,
          location: "Historical location",
          condition: "good",
          allocations: [{ id: allocationId, personId: person, status }],
        }),
        now,
        now,
      );
      db.prepare(
        "INSERT INTO ops_allocations(tenant_id,id,asset_id,person_id,status,reserved_until,issued_on,returned_on,employment_episode_id,case_id) VALUES('legacy',?,?,?,?,?,?,NULL,NULL,NULL)",
      ).run(
        allocationId!,
        id!,
        person,
        status!,
        "2026-09-07",
        status === "issued" ? "2026-09-07" : null,
      );
    }
    const oldJson = db
      .prepare("SELECT data_json FROM ops_entities WHERE id=?")
      .get(issued)!.data_json;
    db.exec("CREATE TABLE ops_asset_events(synthetic_collision TEXT)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_asset_events already exists/,
    );
    assert.equal(
      db.prepare("SELECT max(version) n FROM schema_versions_operations").get()!
        .n,
      4,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('ops_allocations') WHERE name='version'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('ops_tasks') WHERE name='template_key'",
        )
        .get(),
      undefined,
    );
    db.exec("DROP TABLE ops_asset_events");
    db.close();
    db = undefined;
    store = new WorkspaceStore(path, { clock: () => Date.parse(now) });
    const actor: Principal = {
      id: "custodian",
      tenantId: "legacy",
      roles: ["operator"],
      scopes: ["*"],
    };
    store.setPrincipalProvider(() => [actor]);
    const a = store.assetCustody(actor, issued);
    assert.equal(a.totalEvents, 0);
    assert.equal(a.allocations[0]!.provenance, "legacy");
    for (const field of [
      "expiresAt",
      "timezone",
      "profileVersion",
      "employmentEpisodeId",
      "caseId",
      "issueEventId",
      "returnEventId",
      "lastEventId",
    ] as const)
      assert.equal(a.allocations[0]![field], null, field);
    db = new DatabaseSync(path);
    assert.equal(
      db.prepare("SELECT data_json FROM ops_entities WHERE id=?").get(issued)!
        .data_json,
      oldJson,
    );
    for (const [toolId, assetId, allocationId, extra] of [
      [
        "ops.assets.release",
        reserved,
        reservedAllocation,
        {
          reason: "Synthetic explicit release of an unresolved old reservation",
        },
      ],
      [
        "ops.assets.return",
        issued,
        issuedAllocation,
        {
          returnedOn: "2026-09-08",
          location: "Synthetic returns room",
          condition: "good",
          receiptNote:
            "Current witness receives historical asset; no invented earlier signature",
          humanConfirmed: true,
        },
      ],
    ] as const) {
      const tool = store.tools().find((t) => t.id === toolId)!,
        input = {
          id: assetId,
          expectedVersion: 1,
          allocationId,
          expectedAllocationVersion: 1,
          ...extra,
        };
      const ctx = {
        tenantId: actor.tenantId,
        actorId: actor.id,
        approvedBy: "independent-reviewer",
        runId: randomUUID(),
        stepId: "migration-proof",
        operationKey: randomUUID(),
        signal: new AbortController().signal,
      };
      const result = await tool.execute(ctx, input);
      assert.equal((await tool.verify(ctx, input, result)).ok, true);
    }
    assert.equal(store.assetCustody(actor, issued).events[0]!.kind, "return");
    assert.equal(
      store.assetCustody(actor, issued).events[0]!.performedBy,
      actor.id,
    );
    assert.equal(
      store.assetCustody(actor, issued).allocations[0]!.issueEventId,
      null,
    );
    assert.equal(
      db
        .prepare("SELECT COUNT(*) n FROM ops_asset_events WHERE kind='issue'")
        .get()!.n,
      0,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
