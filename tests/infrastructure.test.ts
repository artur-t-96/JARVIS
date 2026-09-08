import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  acquireDataLock,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "../src/backup.js";
import { Diagnostics, redactLogFields } from "../src/diagnostics.js";
import { Engine } from "../src/engine.js";
import { migrateDatabase, type Migration } from "../src/migrations.js";
import {
  approver,
  createFixtureTools,
  operator,
  policies,
  principals,
  writePlan,
} from "./helpers/engine-fixture.js";

function temporary() {
  return mkdtempSync(join(tmpdir(), "jarvis-infrastructure-"));
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("upgrades the original v1 ledger and keeps operations migrations independent", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_versions VALUES (1, 'original'); CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES ('keep');",
    );
    const migrations: Migration[] = [
      {
        version: 1,
        name: "original",
        up: () => assert.fail("v1 must not run again"),
      },
      {
        version: 2,
        name: "add-details",
        up: (database) =>
          database.exec("ALTER TABLE existing_data ADD COLUMN details TEXT"),
      },
    ];
    assert.deepEqual(migrateDatabase(db, { namespace: "core", migrations }), {
      version: 2,
      applied: [2],
    });
    assert.deepEqual(migrateDatabase(db, { namespace: "core", migrations }), {
      version: 2,
      applied: [],
    });
    assert.equal(
      db.prepare("SELECT value FROM existing_data").get()?.value,
      "keep",
    );
    assert.deepEqual(
      migrateDatabase(db, {
        namespace: "operations",
        migrations: [
          {
            version: 1,
            name: "operations",
            up: (database) => database.exec("CREATE TABLE assets (id TEXT)"),
          },
        ],
      }),
      { version: 1, applied: [1] },
    );
    assert.equal(
      db.prepare("SELECT MAX(version) AS version FROM schema_versions").get()
        ?.version,
      2,
    );
    assert.equal(
      db
        .prepare(
          "SELECT MAX(version) AS version FROM schema_versions_operations",
        )
        .get()?.version,
      1,
    );
  } finally {
    db.close();
  }
});

test("migration errors roll back all upgrade writes and reject future or gapped ledgers", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const first: Migration = {
      version: 1,
      name: "base",
      up: (database) => database.exec("CREATE TABLE durable (id TEXT)"),
    };
    migrateDatabase(db, { namespace: "core", migrations: [first] });
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "core",
          migrations: [
            first,
            {
              version: 2,
              name: "bad",
              up(database) {
                database.exec("ALTER TABLE durable ADD COLUMN bad TEXT");
                throw new Error("intentional");
              },
            },
          ],
        }),
      /intentional/,
    );
    assert.equal(db.prepare("PRAGMA table_info(durable)").all().length, 1);
    assert.equal(
      db.prepare("SELECT MAX(version) AS version FROM schema_versions").get()
        ?.version,
      1,
    );
    db.exec("INSERT INTO schema_versions VALUES (2, 'future')");
    assert.throws(
      () => migrateDatabase(db, { namespace: "core", migrations: [first] }),
      /newer/,
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM schema_versions").get()?.count,
      2,
    );
    db.exec("DELETE FROM schema_versions WHERE version = 1");
    assert.throws(
      () =>
        migrateDatabase(db, {
          namespace: "core",
          migrations: [first, { version: 2, name: "two", up() {} }],
        }),
      /nonconsecutive/,
    );
  } finally {
    db.close();
  }
});

test("HTTP traffic cannot hide a stale worker; local OTel metrics record actual work", async () => {
  const dir = temporary();
  let now = 1_700_000_000_000;
  const diagnostics = new Diagnostics({
    dataDir: dir,
    version: "test",
    clock: () => now,
    staleAfterMs: 100,
    minimumFreeBytes: 0,
    writeLog() {},
  });
  try {
    assert.equal(
      diagnostics.snapshot({ databaseHealthy: true }).worker.state,
      "starting",
    );
    diagnostics.workerTickStarted();
    now += 5;
    diagnostics.workerTickCompleted({
      queue: { queued: 2, waitingApproval: 1 },
    });
    let state = diagnostics.snapshot({ databaseHealthy: true });
    assert.equal(state.ready, true);
    assert.equal(state.queue.waitingApproval, 1);
    assert.equal(state.telemetry.counters.workerTicks, 1);
    assert.equal(state.telemetry.outboundExportEnabled, false);
    now += 101;
    diagnostics.recordRequest({
      method: "GET",
      route: "/health/live",
      statusCode: 200,
      durationMs: 1,
    });
    state = diagnostics.snapshot({ databaseHealthy: true });
    assert.equal(state.live, true);
    assert.equal(state.ready, false);
    assert.equal(state.worker.state, "stale");
    diagnostics.workerTickStarted();
    now += 200;
    assert.equal(
      diagnostics.snapshot({ databaseHealthy: true }).worker.state,
      "stale",
    );
    diagnostics.workerTickCompleted({ errorCode: "worker_failed" });
    assert.equal(
      diagnostics.snapshot({ databaseHealthy: true }).worker.state,
      "error",
    );
    diagnostics.workerTickStarted();
    diagnostics.workerTickCompleted();
    assert.equal(diagnostics.snapshot({ databaseHealthy: true }).ready, true);
    diagnostics.setMaintenance(true);
    assert.ok(
      diagnostics
        .snapshot({ databaseHealthy: true })
        .reasons.includes("maintenance"),
    );
    const collected = await diagnostics.localMetrics();
    assert.ok(
      collected.resourceMetrics.scopeMetrics.some((scope) =>
        scope.metrics.some(
          (metric) => metric.descriptor.name === "jarvis.worker.ticks",
        ),
      ),
    );
    await diagnostics.close();
    assert.equal(diagnostics.snapshot({ databaseHealthy: true }).live, false);
  } finally {
    await diagnostics.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs drop request content, credentials and errors while retaining safe correlation", async () => {
  const dir = temporary();
  const lines: string[] = [];
  const diagnostics = new Diagnostics({
    dataDir: dir,
    version: "test",
    writeLog: (line) => lines.push(line),
  });
  try {
    await diagnostics.withWorkerTick(() =>
      diagnostics.log("error", "tool.failed", {
        tenantId: "tenant-a",
        runId: "run-123",
        operationKey: "operation-1",
        toolId: "local.read",
        requestId: "Bearer confidential-token",
        durationMs: 12,
        token: "never-print",
        body: { password: "never-print" },
        error: new Error("never-print"),
        request: "private business request",
        apiKey: "never-print",
        input: { email: "private@example.com" },
      }),
    );
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]!);
    assert.equal(record.runId, "run-123");
    assert.equal(record.requestId, "[redacted]");
    assert.match(record.traceId, /^[a-f0-9]{32}$/);
    assert.equal(record.durationMs, 12);
    assert.ok(!lines[0]!.includes("never-print"));
    assert.ok(!lines[0]!.includes("private"));
    assert.deepEqual(
      redactLogFields({ code: "bad\nnew-line", arbitrary: "hidden" }),
      { code: "[redacted]" },
    );
  } finally {
    await diagnostics.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker, nested and parallel spans keep their own context across awaits", async () => {
  const dir = temporary();
  const records: Record<string, string>[] = [];
  const diagnostics = new Diagnostics({
    dataDir: dir,
    version: "test",
    minimumFreeBytes: 0,
    writeLog: (line) => records.push(JSON.parse(line)),
  });
  const nestedGate = barrier();
  const workerResumed = barrier();
  const workerGate = barrier();
  const parallelGate = barrier();
  const record = (event: string) => {
    const result = records.find((entry) => entry.event === event);
    assert.ok(result, `Missing ${event}`);
    return result;
  };
  try {
    const worker = diagnostics.withWorkerTick(
      async () => {
        diagnostics.log("info", "worker.before");
        const nested = diagnostics.withSpan("tool.execute", async () => {
          diagnostics.log("info", "nested.before");
          await nestedGate.promise;
          diagnostics.log("info", "nested.after");
        });
        diagnostics.log("info", "worker.nested_pending");
        await nested;
        diagnostics.log("info", "worker.resumed");
        workerResumed.release();
        await workerGate.promise;
        diagnostics.log("info", "worker.after");
        return "done";
      },
      () => ({ waitingApproval: 1 }),
    );
    const parallel = diagnostics.withSpan("model.request", async () => {
      diagnostics.log("info", "parallel.before");
      await parallelGate.promise;
      diagnostics.log("info", "parallel.after");
    });
    assert.equal(
      diagnostics.snapshot({ databaseHealthy: true }).worker.inProgress,
      true,
    );
    diagnostics.recordRequest({
      method: "GET",
      route: "/api/runs",
      statusCode: 200,
      durationMs: 1,
      requestId: "http-unrelated",
    });
    diagnostics.log("info", "outside.pending");
    nestedGate.release();
    await workerResumed.promise;
    parallelGate.release();
    await parallel;
    diagnostics.log("info", "outside.parallel_finished");
    workerGate.release();
    assert.equal(await worker, "done");
    diagnostics.log("info", "outside.finished");

    const root = record("worker.before");
    assert.match(root.traceId!, /^[a-f0-9]{32}$/);
    assert.match(root.spanId!, /^[a-f0-9]{16}$/);
    for (const event of [
      "worker.nested_pending",
      "worker.resumed",
      "worker.after",
    ]) {
      assert.equal(record(event).traceId, root.traceId);
      assert.equal(record(event).spanId, root.spanId);
    }
    assert.equal(record("nested.before").traceId, root.traceId);
    assert.notEqual(record("nested.before").spanId, root.spanId);
    assert.equal(record("nested.before").spanId, record("nested.after").spanId);
    assert.equal(record("nested.after").traceId, root.traceId);
    assert.notEqual(record("parallel.before").traceId, root.traceId);
    assert.equal(
      record("parallel.after").traceId,
      record("parallel.before").traceId,
    );
    assert.equal(
      record("parallel.after").spanId,
      record("parallel.before").spanId,
    );
    for (const event of [
      "http.request",
      "outside.pending",
      "outside.parallel_finished",
      "outside.finished",
    ]) {
      assert.equal(record(event).traceId, undefined, event);
      assert.equal(record(event).spanId, undefined, event);
    }
    const state = diagnostics.snapshot({ databaseHealthy: true });
    assert.equal(state.worker.inProgress, false);
    assert.equal(state.worker.state, "healthy");
    assert.equal(state.queue.waitingApproval, 1);
    assert.equal(state.telemetry.counters.workerTicks, 1);
    assert.equal(state.telemetry.retainedTraces, 3);
  } finally {
    nestedGate.release();
    workerGate.release();
    parallelGate.release();
    await diagnostics.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed scopes restore their parent, correlate worker failure and redact secrets", async () => {
  const dir = temporary();
  const lines: string[] = [];
  const diagnostics = new Diagnostics({
    dataDir: dir,
    version: "test",
    writeLog: (line) => lines.push(line),
  });
  const privateError = new Error("Bearer confidential-token");
  try {
    await diagnostics.withSpan("parent.operation", async () => {
      diagnostics.log("info", "parent.before");
      await assert.rejects(
        diagnostics.withSpan("nested.operation", async () => {
          await Promise.resolve();
          diagnostics.log("warn", "nested.failed", {
            error: privateError,
            code: "Bearer confidential-token",
          });
          throw privateError;
        }),
        (error) => error === privateError,
      );
      diagnostics.log("info", "parent.after");
      await assert.rejects(
        diagnostics.withWorkerTick(async () => {
          await Promise.resolve();
          diagnostics.log("info", "worker.before_failure");
          throw privateError;
        }),
        (error) => error === privateError,
      );
      diagnostics.log("info", "parent.after_worker");
    });
    diagnostics.log("info", "outside.after_failure");
    const records = lines.map((line) => JSON.parse(line));
    const parent = records[0];
    assert.equal(records[1].traceId, parent.traceId);
    assert.notEqual(records[1].spanId, parent.spanId);
    for (const index of [2, 5]) {
      assert.equal(records[index].traceId, parent.traceId);
      assert.equal(records[index].spanId, parent.spanId);
    }
    const worker = records[3];
    const failure = records[4];
    assert.equal(failure.event, "worker.tick.failed");
    assert.equal(failure.traceId, worker.traceId);
    assert.equal(failure.spanId, worker.spanId);
    assert.notEqual(failure.spanId, parent.spanId);
    assert.equal(failure.code, "worker_tick_failed");
    assert.equal(records[6].traceId, undefined);
    assert.equal(records[6].spanId, undefined);
    assert.ok(!lines.join("\n").includes("confidential-token"));
    const state = diagnostics.snapshot({ databaseHealthy: true });
    assert.equal(state.worker.state, "error");
    assert.equal(state.worker.inProgress, false);
    assert.equal(state.telemetry.counters.workerErrors, 1);
    assert.equal(state.telemetry.retainedTraces, 3);
    await diagnostics.withWorkerTick(() => {});
    assert.equal(
      diagnostics.snapshot({ databaseHealthy: true }).worker.state,
      "healthy",
    );
  } finally {
    await diagnostics.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ended or closed scopes cannot correlate detached work and trace retention stays bounded", async () => {
  const dir = temporary();
  const records: Record<string, string>[] = [];
  const diagnostics = new Diagnostics({
    dataDir: dir,
    version: "test",
    writeLog: (line) => records.push(JSON.parse(line)),
  });
  const detachedGate = barrier();
  const closeGate = barrier();
  const finishTogether = barrier();
  try {
    let detached!: Promise<void>;
    await diagnostics.withSpan("short.operation", () => {
      detached = (async () => {
        await detachedGate.promise;
        diagnostics.log("info", "detached.after_end");
      })();
    });
    detachedGate.release();
    await detached;
    assert.equal(records[0]?.traceId, undefined);
    assert.equal(records[0]?.spanId, undefined);

    const concurrent = Array.from({ length: 129 }, () =>
      diagnostics.withSpan("parallel.operation", () => finishTogether.promise),
    );
    finishTogether.release();
    await Promise.all(concurrent);
    const retained = diagnostics.snapshot({ databaseHealthy: true }).telemetry
      .retainedTraces;
    assert.ok(retained > 0 && retained <= 128);

    const closing = diagnostics.withWorkerTick(async () => {
      diagnostics.log("info", "worker.before_close");
      await closeGate.promise;
      diagnostics.log("info", "worker.after_close");
    });
    await diagnostics.close();
    closeGate.release();
    await closing;
    diagnostics.log("info", "outside.after_close");
    assert.match(records[1]?.traceId ?? "", /^[a-f0-9]{32}$/);
    for (const record of records.slice(2)) {
      assert.equal(record.traceId, undefined);
      assert.equal(record.spanId, undefined);
    }
    const state = diagnostics.snapshot({ databaseHealthy: true });
    assert.equal(state.live, false);
    assert.equal(state.worker.inProgress, false);
    await assert.rejects(
      diagnostics.withSpan("closed.operation", () => assert.fail("closed")),
      /Diagnostics is closed/,
    );
  } finally {
    detachedGate.release();
    closeGate.release();
    finishTogether.release();
    await diagnostics.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime lock excludes snapshots, permits dead local PID recovery, and blocks interrupted restore", async () => {
  const root = temporary();
  const data = join(root, "data");
  const lock = acquireDataLock(data, "runtime");
  try {
    assert.throws(() => acquireDataLock(data, "maintenance"), /locked/);
    await assert.rejects(
      createBackup({
        dataDir: data,
        destination: join(root, "backup"),
        buildVersion: "test",
      }),
      /locked/,
    );
    lock.release();
    writeFileSync(
      join(data, ".jarvis-data.lock"),
      JSON.stringify({
        pid: 2_147_483_647,
        host: hostname(),
        token: "dead",
        kind: "runtime",
      }),
    );
    const recovered = acquireDataLock(data, "maintenance");
    recovered.release();
    writeFileSync(join(data, ".restore-in-progress"), "interrupted");
    assert.throws(
      () => acquireDataLock(data, "runtime"),
      /interrupted restore/,
    );
  } finally {
    lock.release();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForApproval(engine: Engine, id: string) {
  engine.start(operator, id);
  for (let index = 0; index < 12; index++) {
    const run = engine.getRun(operator, id);
    const approval = run.steps.find(
      (step) => step.approval?.status === "pending",
    )?.approval;
    if (approval) return approval;
    await engine.tick();
  }
  assert.fail("Expected a durable waiting approval");
}

async function finish(engine: Engine) {
  for (let index = 0; index < 12; index++) if (!(await engine.tick())) return;
  assert.fail("Worker did not drain");
}

test("restore retains waiting approvals, completed independent effects, evidence, and excludes accounts/sessions", async () => {
  const root = temporary();
  const data = join(root, "data");
  mkdirSync(data);
  let fixture = createFixtureTools(join(data, "effects.sqlite"));
  let engine = new Engine({
    dbPath: join(data, "jarvis.sqlite"),
    tools: fixture.tools,
    policies: policies(),
    principals,
  });
  let open = true;
  try {
    const complete = engine.createRun(
      operator,
      "Pierwszy pakiet",
      writePlan("Pierwszy pakiet"),
      "complete-1",
    );
    const firstApproval = await waitForApproval(engine, complete.id);
    engine.approve(approver, complete.id, {
      approvalId: firstApproval.id,
      bindingHash: firstApproval.bindingHash,
      decision: "approved",
    });
    await finish(engine);
    assert.equal(fixture.effectCount(), 1);
    const pending = engine.createRun(
      operator,
      "Drugi pakiet",
      writePlan("Drugi pakiet"),
      "pending-1",
    );
    const approval = await waitForApproval(engine, pending.id);
    const priorRun = engine.getRun(operator, pending.id);
    engine.close();
    fixture.close();
    open = false;
    mkdirSync(join(data, "evidence"));
    mkdirSync(join(data, "attachments"));
    writeFileSync(join(data, "evidence", "receipt.json"), '{"verified":true}');
    writeFileSync(
      join(data, "attachments", "instructions.txt"),
      "Zwróć uwagę na niezależny odczyt.",
    );
    for (const name of [
      "accounts.sqlite",
      "sessions.sqlite",
      "session-cache.sqlite",
    ]) {
      const credentials = new DatabaseSync(join(data, name));
      credentials.exec(
        "CREATE TABLE sessions (hash TEXT); INSERT INTO sessions VALUES ('private-hash');",
      );
      credentials.close();
    }
    writeFileSync(join(data, ".env"), "API_KEY=must-not-copy");
    mkdirSync(join(data, "voice"));
    // Local Python build tools contain symlinks; runtime assets are outside the backup scope.
    symlinkSync(process.execPath, join(data, "voice", "runtime-link"));
    const sourceDatabase = new DatabaseSync(join(data, "jarvis.sqlite"), {
      readOnly: true,
    });
    const sourceSchema = sourceDatabase
      .prepare("SELECT MAX(version) AS version FROM schema_versions")
      .get()?.version;
    sourceDatabase.close();
    const snapshot = await createBackup({
      dataDir: data,
      destination: join(root, "backup"),
      buildVersion: "fixture-sha",
    });
    assert.equal(snapshot.manifest.files.length, 4);
    assert.ok(
      snapshot.manifest.files.every(
        (entry) => !/(account|session)/.test(entry.path),
      ),
    );
    assert.equal(
      statSync(join(root, "backup", "manifest.json")).mode & 0o777,
      0o600,
    );
    assert.equal(
      statSync(join(root, "backup", "payload", "jarvis.sqlite")).mode & 0o777,
      0o600,
    );
    assert.equal(
      snapshot.manifest.files.find((entry) => entry.path === "jarvis.sqlite")
        ?.schemaVersions?.schema_versions,
      sourceSchema,
    );
    assert.ok(existsSync(join(data, "backup-status.json")));
    const restored = join(root, "restored");
    await restoreBackup({ source: snapshot.destination, targetDir: restored });
    assert.equal(existsSync(join(restored, "accounts.sqlite")), false);
    assert.equal(existsSync(join(restored, ".env")), false);
    assert.equal(
      readFileSync(join(restored, "evidence", "receipt.json"), "utf8"),
      '{"verified":true}',
    );
    fixture = createFixtureTools(join(restored, "effects.sqlite"));
    engine = new Engine({
      dbPath: join(restored, "jarvis.sqlite"),
      tools: fixture.tools,
      policies: policies(),
      principals,
    });
    open = true;
    const restoredRun = engine.getRun(operator, pending.id);
    assert.equal(restoredRun.status, "waiting_approval");
    assert.equal(restoredRun.planHash, priorRun.planHash);
    assert.equal(
      restoredRun.steps[0]?.approval?.bindingHash,
      approval.bindingHash,
    );
    assert.equal(engine.getRun(operator, complete.id).status, "completed");
    assert.equal(fixture.effectCount(), 1);
    assert.equal(fixture.executeCount(), 1);
    engine.approve(approver, pending.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await finish(engine);
    const completed = engine.getRun(operator, pending.id);
    assert.equal(completed.status, "completed");
    assert.equal(
      completed.steps[0]?.verification?.evidence[0]?.source,
      "fixture-effects-db",
    );
    assert.equal(fixture.effectCount(), 2);
    assert.equal(fixture.executeCount(), 2);
    await assert.rejects(
      restoreBackup({ source: snapshot.destination, targetDir: restored }),
      /empty target/,
    );
  } finally {
    if (open) {
      engine.close();
      fixture.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function basicSnapshot(root: string) {
  const data = join(root, "data");
  mkdirSync(data);
  const database = new DatabaseSync(join(data, "jarvis.sqlite"));
  database.exec(
    "CREATE TABLE effects (value TEXT); INSERT INTO effects VALUES ('durable');",
  );
  database.close();
  return createBackup({
    dataDir: data,
    destination: join(root, "backup"),
    buildVersion: "test",
  });
}

test("restore rejects changed bytes, forged SQLite hashes, traversal and undeclared members before touching target", async () => {
  const root = temporary();
  try {
    const snapshot = await basicSnapshot(root);
    const source = join(snapshot.destination, "payload", "jarvis.sqlite");
    const original = readFileSync(source);
    writeFileSync(source, "corruption");
    await assert.rejects(
      restoreBackup({
        source: snapshot.destination,
        targetDir: join(root, "restore"),
      }),
      /checksum/,
    );
    assert.equal(existsSync(join(root, "restore")), false);
    const manifestPath = join(snapshot.destination, "manifest.json");
    const initialManifest = readFileSync(manifestPath, "utf8");
    const forged = JSON.parse(initialManifest);
    forged.files[0].size = 10;
    forged.files[0].sha256 = createHash("sha256")
      .update("corruption")
      .digest("hex");
    writeFileSync(manifestPath, JSON.stringify(forged));
    assert.throws(() => verifyBackup(snapshot.destination));
    writeFileSync(source, original);
    forged.files[0].path = "../escape.sqlite";
    writeFileSync(manifestPath, JSON.stringify(forged));
    assert.throws(
      () => verifyBackup(snapshot.destination),
      /Unsafe backup path/,
    );
    writeFileSync(manifestPath, initialManifest);
    writeFileSync(join(snapshot.destination, "unexpected.txt"), "unexpected");
    assert.throws(() => verifyBackup(snapshot.destination), /undeclared/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backups fail closed on secret-bearing evidence and symlinks without publishing partial artifacts", async () => {
  const root = temporary();
  try {
    const snapshot = await basicSnapshot(root);
    const data = join(root, "data");
    mkdirSync(join(data, "evidence"));
    writeFileSync(
      join(data, "evidence", "unsafe.json"),
      '{"api_key":"sensitive-test-value"}',
    );
    await assert.rejects(
      createBackup({
        dataDir: data,
        destination: join(root, "refused"),
        buildVersion: "test",
      }),
      /plaintext credential/,
    );
    assert.equal(existsSync(join(root, "refused")), false);
    assert.ok(readdirSync(root).every((name) => !name.includes("partial")));
    rmSync(join(data, "evidence", "unsafe.json"));
    symlinkSync(
      join(snapshot.destination, "manifest.json"),
      join(data, "evidence", "link.json"),
    );
    await assert.rejects(
      createBackup({
        dataDir: data,
        destination: join(root, "refused"),
        buildVersion: "test",
      }),
      /symlink/,
    );
    assert.equal(existsSync(join(data, ".jarvis-data.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a parent-directory snapshot refuses an active nested lab or operational runtime", async () => {
  const root = temporary();
  const data = join(root, "data");
  const operational = join(data, "operational");
  mkdirSync(operational, { recursive: true });
  const db = new DatabaseSync(join(operational, "operations.sqlite"));
  db.exec("CREATE TABLE effects(id TEXT)");
  db.close();
  const runtime = acquireDataLock(operational, "runtime");
  try {
    await assert.rejects(
      createBackup({
        dataDir: data,
        destination: join(root, "blocked"),
        buildVersion: "test",
      }),
      /locked/,
    );
    runtime.release();
    const result = await createBackup({
      dataDir: data,
      destination: join(root, "allowed"),
      buildVersion: "test",
    });
    assert.equal(
      result.manifest.files[0]?.path,
      "operational/operations.sqlite",
    );
  } finally {
    runtime.release();
    rmSync(root, { recursive: true, force: true });
  }
});
