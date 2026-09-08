import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  DomainError,
  type JsonObject,
  type Principal,
} from "../src/contracts.js";
import { WorkspaceStore } from "../src/workspace.js";

const manager: Principal = {
  id: "manager",
  tenantId: "synthetic",
  roles: ["operator", "approver"],
  scopes: ["*"],
};
const casesOnly: Principal = {
  ...manager,
  id: "cases-only",
  scopes: ["cases"],
};
const oldTaskSql = `CREATE TABLE ops_tasks(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,title TEXT NOT NULL,assignee_id TEXT,required INTEGER NOT NULL CHECK(required IN(0,1)),status TEXT NOT NULL CHECK(status IN('open','completed')),completed_by TEXT,completed_at TEXT,evidence_note TEXT,due_date TEXT,depends_on_json TEXT NOT NULL DEFAULT '[]',PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));`;

/** Reconstruct the v2 shape on an empty temporary database, then seed genuine
 * legacy columns. No migration function under test runs on the seeded records. */
function v2(path: string) {
  new WorkspaceStore(path).close();
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; DROP TABLE ops_task_events; DROP TABLE ops_tasks; ${oldTaskSql}
    DROP TABLE ops_case_exceptions; DROP TABLE ops_requirement_bindings; DROP TABLE ops_case_requirements;
    DELETE FROM schema_versions_operations WHERE version=3;`);
  for (const column of [
    "scope_hash",
    "bindings_hash",
    "bindings_json",
    "contract_version",
    "requested_by",
    "approved_by",
    "person_id",
    "employment_episode_id",
  ])
    db.exec(`ALTER TABLE ops_acceptances DROP COLUMN ${column}`);
  for (const table of ["ops_allocations", "ops_license_seats"])
    for (const column of ["employment_episode_id", "case_id"])
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  return db;
}

test("v2 migration preserves legacy attestations without inventing principal, episode or acceptance proof", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-legacy-readiness-")),
    path = join(dir, "workspace.db");
  const db = v2(path),
    personId = randomUUID(),
    caseId = randomUUID(),
    episodeId = randomUUID(),
    openTask = randomUUID(),
    doneTask = randomUUID(),
    assetId = randomUUID(),
    licenseId = randomUUID();
  const caseData = {
    caseType: "onboarding",
    scopeRevision: 1,
    brief: "Legacy HR scope",
    acceptanceCriteria: "Legacy acceptance",
    personId,
    employmentEpisodeId: episodeId,
    employmentKind: "internal",
    tasks: [
      {
        id: openTask,
        title: "Private legacy HR task",
        status: "open",
        assigneeId: personId,
      },
    ],
    currentAcceptance: { decision: "accepted", decidedBy: "legacy-approver" },
  };
  const original = JSON.stringify(caseData),
    now = "2026-09-01T10:00:00.000Z";
  const insert = db.prepare(
    "INSERT INTO ops_entities VALUES(?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    "synthetic",
    personId,
    "people",
    "Synthetic legacy person",
    "onboarding",
    3,
    JSON.stringify({
      personCategory: "internal",
      currentEmploymentEpisodeId: episodeId,
      onboardingCaseId: caseId,
    }),
    now,
    now,
  );
  insert.run(
    "synthetic",
    caseId,
    "cases",
    "Synthetic historical onboarding",
    "accepted",
    8,
    original,
    now,
    now,
  );
  insert.run(
    "synthetic",
    assetId,
    "assets",
    "Historical laptop",
    "issued",
    2,
    JSON.stringify({ assetType: "laptop" }),
    now,
    now,
  );
  insert.run(
    "synthetic",
    licenseId,
    "licenses",
    "Historical license",
    "active",
    2,
    JSON.stringify({ product: "Test", totalSeats: 1 }),
    now,
    now,
  );
  db.prepare("INSERT INTO ops_employment VALUES(?,?,?,?,?,?,?,?)").run(
    "synthetic",
    episodeId,
    personId,
    "internal",
    "2026-09-01",
    null,
    "onboarding",
    "Test",
  );
  const insertTask = db.prepare(
    "INSERT INTO ops_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insertTask.run(
    "synthetic",
    openTask,
    caseId,
    1,
    "Private legacy HR task",
    personId,
    1,
    "open",
    null,
    null,
    null,
    "2026-09-01",
    "[]",
  );
  insertTask.run(
    "synthetic",
    doneTask,
    caseId,
    1,
    "Legacy completed task",
    personId,
    1,
    "completed",
    "legacy-approver",
    now,
    "Legacy text only",
    "2026-09-01",
    "[]",
  );
  db.prepare("INSERT INTO ops_acceptances VALUES(?,?,?,?,?,?,?,?)").run(
    "synthetic",
    randomUUID(),
    caseId,
    1,
    "accepted",
    "Legacy note",
    "legacy-approver",
    now,
  );
  db.prepare("INSERT INTO ops_allocations VALUES(?,?,?,?,?,?,?,?)").run(
    "synthetic",
    randomUUID(),
    assetId,
    personId,
    "issued",
    "2026-09-02",
    "2026-09-01",
    null,
  );
  db.prepare("INSERT INTO ops_license_seats VALUES(?,?,?,?,?,?,?)").run(
    "synthetic",
    randomUUID(),
    licenseId,
    personId,
    "assigned",
    now,
    null,
  );
  db.close();
  let store = new WorkspaceStore(path);
  store.setPrincipalProvider(() => [manager, casesOnly]);
  try {
    const check = new DatabaseSync(path);
    try {
      const migratedOpen = check
        .prepare("SELECT * FROM ops_tasks WHERE id=?")
        .get(openTask)!;
      assert.equal(migratedOpen.status, "unassigned");
      assert.equal(migratedOpen.assignee_id, personId);
      assert.equal(migratedOpen.assignee_principal_id, null);
      assert.equal(migratedOpen.provenance, "legacy");
      assert.deepEqual(JSON.parse(String(migratedOpen.required_scopes_json)), [
        "cases",
        "people",
      ]);
      const migratedDone = check
        .prepare("SELECT * FROM ops_tasks WHERE id=?")
        .get(doneTask)!;
      assert.equal(migratedDone.status, "completed");
      assert.equal(migratedDone.completed_by, "legacy-approver");
      assert.equal(migratedDone.performed_by, null);
      assert.equal(
        check
          .prepare("SELECT data_json FROM ops_entities WHERE id=?")
          .get(caseId)!.data_json,
        original,
      );
      const accepted = check
        .prepare("SELECT * FROM ops_acceptances WHERE case_id=?")
        .get(caseId)!;
      assert.equal(accepted.contract_version, "legacy");
      assert.equal(accepted.scope_hash, null);
      assert.equal(accepted.bindings_json, "[]");
      assert.equal(
        check.prepare("SELECT count(*) AS n FROM ops_task_events").get()!.n,
        0,
      );
      for (const table of ["ops_allocations", "ops_license_seats"]) {
        const row = check
          .prepare(`SELECT employment_episode_id,case_id FROM ${table}`)
          .get()!;
        assert.equal(row.employment_episode_id, null);
        assert.equal(row.case_id, null);
      }
      // The UI receives the safe current task projection; immutable snapshots remain intact.
      const projected = store.get(manager, "cases", caseId).data
        .tasks as JsonObject[];
      assert.equal(
        projected.find((task) => task.id === openTask)!.status,
        "unassigned",
      );
      assert.equal(
        projected.find((task) => task.id === doneTask)!.performedBy,
        null,
      );
      assert.deepEqual(store.listTasks(casesOnly), []);
      assert.equal(
        store
          .taskAssignees(manager, openTask)
          .some((p) => p.id === casesOnly.id),
        false,
      );
      assert.equal(store.readiness(manager, caseId).acceptanceCurrent, false);
      const activate = store
        .tools()
        .find((tool) => tool.id === "ops.people.activate")!;
      await assert.rejects(
        activate.execute(
          {
            tenantId: manager.tenantId,
            actorId: manager.id,
            approvedBy: "reviewer",
            operationKey: randomUUID(),
            runId: randomUUID(),
            stepId: randomUUID(),
            signal: new AbortController().signal,
          },
          { id: personId, expectedVersion: 3, humanDecision: true },
        ),
        (error: unknown) =>
          error instanceof DomainError &&
          error.code === "ACTIVATION_READINESS_STALE",
      );
      assert.equal(
        check
          .prepare("SELECT status FROM ops_entities WHERE id=?")
          .get(personId)!.status,
        "onboarding",
      );
    } finally {
      check.close();
    }
    store.close();
    store = new WorkspaceStore(path);
    const reopened = new DatabaseSync(path);
    try {
      assert.equal(
        reopened
          .prepare(
            "SELECT count(*) AS n FROM schema_versions_operations WHERE version=3",
          )
          .get()!.n,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed readiness migration rolls back table replacement and refuses an unknown future schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-legacy-rollback-")),
    path = join(dir, "workspace.db");
  let db = v2(path);
  try {
    db.exec("CREATE TABLE ops_case_requirements(collision TEXT)");
    assert.throws(
      () => new WorkspaceStore(path),
      /ops_case_requirements already exists/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT max(version) AS version FROM schema_versions_operations",
        )
        .get()!.version,
      2,
    );
    assert.ok(
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name='ops_tasks'")
          .get()!.sql as string
      ).includes("'open','completed'"),
    );
    assert.equal(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='ops_tasks_legacy'")
        .get(),
      undefined,
    );
    db.exec("DROP TABLE ops_case_requirements");
    db.close();
    new WorkspaceStore(path).close();
    db = new DatabaseSync(path);
    db.prepare("INSERT INTO schema_versions_operations VALUES(?,?)").run(
      4,
      "2026-09-08T10:00:00Z",
    );
    assert.throws(() => new WorkspaceStore(path), /newer than supported v3/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
