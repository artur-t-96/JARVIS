import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Diagnostics } from "../src/diagnostics.js";
import {
  LocalTraceExporter,
  telemetryPorts,
} from "../src/observability/telemetry.js";
import { Engine } from "../src/engine.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import {
  approver,
  createFixtureTools,
  operator,
  policies,
  principals,
  writePlan,
} from "./helpers/engine-fixture.js";

test("official exporters send redacted OTLP and Prometheus; durable approvals link across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-otel-"));
  const requests: { url: string; headers: object; body: string }[] = [];
  const collector = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, headers: req.headers, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((done, reject) => {
    collector.once("error", reject);
    collector.listen(telemetryPorts("lab").collector, "127.0.0.1", done);
  });
  const lines: string[] = [];
  const diagnostics = new Diagnostics({
    dataDir: directory,
    version: "test",
    telemetryMode: "lab",
    writeLog: (line) => lines.push(line),
  });
  const fixture = createFixtureTools(join(directory, "effects.sqlite"));
  const open = () =>
    new Engine({
      dbPath: join(directory, "core.sqlite"),
      tools: fixture.tools,
      policies: policies(),
      principals,
      diagnostics,
      onEvent: (event, fields) => diagnostics.recordExecution(event, fields),
    });
  let engine = open();
  try {
    await diagnostics.start();
    const run = engine.createRun(
      operator,
      "PRIVATE-CONTENT",
      writePlan("PRIVATE-CONTENT"),
      "observability-test",
    );
    engine.start(operator, run.id);
    await diagnostics.withWorkerTick(() => engine.tick());
    const approval = engine.getRun(operator, run.id).steps[0]!.approval!;
    let approvalTrace = "",
      approvalSpan = "";
    await diagnostics.withSpan(
      "http.request",
      () => {
        const context = diagnostics.currentContext()!;
        approvalTrace = context.traceId;
        approvalSpan = context.spanId;
        engine.approve(approver, run.id, {
          approvalId: approval.id,
          bindingHash: approval.bindingHash,
          decision: "approved",
        });
      },
      { password: "PRIVATE-SECRET", requestId: "approve-1" },
    );
    engine.close();
    engine = open();
    await diagnostics.withWorkerTick(
      () => engine.tick(),
      () => ({ waitingApproval: 2, needsReconciliation: 1 }),
    );
    assert.equal(engine.getRun(operator, run.id).status, "completed");
    await diagnostics.flush();
    const spans = requests.flatMap((r) =>
      JSON.parse(r.body).resourceSpans.flatMap((resource: any) =>
        resource.scopeSpans.flatMap((scope: any) => scope.spans),
      ),
    );
    const attempt = spans.find((span) => span.name === "execution.attempt");
    assert.ok(attempt, "real OTLP contains the execution attempt");
    assert.ok(
      attempt.links.some(
        (link: any) =>
          link.traceId === approvalTrace && link.spanId === approvalSpan,
      ),
      "persisted approval link survives Engine restart and claim events",
    );
    for (const name of ["tool.execute", "tool.verify"]) {
      const span = spans.find((s) => s.name === name);
      assert.equal(span.parentSpanId, attempt.spanId);
      assert.equal(span.traceId, attempt.traceId);
    }
    assert.ok(
      requests.every(
        (r) => r.url === "/v1/traces" && !("authorization" in r.headers),
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(requests) + lines.join(""),
      /PRIVATE-CONTENT|PRIVATE-SECRET/,
    );
    assert.equal(
      diagnostics.snapshot({
        databaseHealthy: true,
        queue: { waitingApproval: 99 },
      }).queue.waitingApproval,
      99,
    );
    const metrics = await fetch(
      `http://127.0.0.1:${telemetryPorts("lab").metrics}/metrics`,
    ).then((r) => r.text());
    assert.match(metrics, /jarvis_worker_ticks_total\{[^\n]*\} 2/);
    assert.match(metrics, /jarvis_worker_duration_bucket/);
    assert.match(
      metrics,
      /jarvis_queue_jobs\{[^\n]*state="waitingApproval"[^\n]*\} 2/,
    );
    assert.doesNotMatch(metrics, new RegExp(run.id));
    assert.equal(
      diagnostics.snapshot({ databaseHealthy: true }).telemetry
        .externalExportEnabled,
      false,
    );
  } finally {
    engine.close();
    fixture.close();
    await diagnostics.close();
    await new Promise<void>((done) => collector.close(() => done()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("collector outage never retries a business operation or grows local history without bound", async () => {
  const diagnostics = new Diagnostics({
    dataDir: tmpdir(),
    version: "test",
    telemetryMode: "lab",
    writeLog: () => {},
  });
  try {
    let effects = 0;
    for (let index = 0; index < 300; index++)
      await diagnostics.withSpan("test.operation", () => effects++);
    await diagnostics.flush();
    assert.equal(effects, 300);
    const state = diagnostics.snapshot({ databaseHealthy: true }).telemetry;
    assert.ok(state.retainedTraces <= 128);
    assert.ok(state.exporter!.failedBatches > 0);
    assert.equal(
      await diagnostics.withSpan("test.after_outage", () => "available"),
      "available",
    );
  } finally {
    await diagnostics.close();
  }
});

test("Fastify concurrent requests retain independent trace context without raw URLs or payload", async () => {
  const lines: string[] = [];
  const diagnostics = new Diagnostics({
    dataDir: tmpdir(),
    version: "test",
    writeLog: (line) => lines.push(line),
  });
  const config = loadConfig({
    JARVIS_MODE: "local",
    JARVIS_DATA_DIR: tmpdir(),
  });
  const engine = new Engine({
    dbPath: ":memory:",
    tools: [],
    policies: config.policies,
    principals: config.principals,
  });
  const app = createApp({
    engine,
    config,
    diagnostics,
    tools: [],
    planner: {
      kind: "test",
      async plan() {
        return writePlan();
      },
    },
  });
  let release!: () => void;
  const barrier = new Promise<void>((done) => {
    release = done;
  });
  let entered = 0;
  const contexts: string[] = [];
  app.get("/correlation-test", async () => {
    const before = diagnostics.currentContext()!.traceId;
    contexts.push(before);
    if (++entered === 2) release();
    await barrier;
    assert.equal(diagnostics.currentContext()!.traceId, before);
    diagnostics.log("info", "test.continuation");
    return { ok: true };
  });
  try {
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          url: "/correlation-test?private=PRIVATE-TEXT",
          headers: { host: "127.0.0.1" },
        }),
      ),
    );
    assert.deepEqual(
      responses.map((r) => r.statusCode),
      [200, 200],
    );
    assert.equal(new Set(contexts).size, 2);
    const logged = lines.map((line) => JSON.parse(line));
    for (const traceId of contexts)
      assert.equal(logged.filter((line) => line.traceId === traceId).length, 2);
    assert.doesNotMatch(lines.join(""), /PRIVATE-TEXT/);
    assert.equal(diagnostics.currentContext(), undefined);
  } finally {
    await app.close();
    engine.close();
    await diagnostics.close();
  }
});

test("manual opt-in refuses inherited OTel credentials; disabled telemetry ignores ambient settings", async () => {
  const previous = process.env.OTEL_EXPORTER_OTLP_HEADERS;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=synthetic-never-send";
  try {
    assert.throws(
      () => new LocalTraceExporter("lab"),
      /clean OTel environment/,
    );
    const local = new Diagnostics({
      dataDir: tmpdir(),
      version: "test",
      writeLog: () => {},
    });
    assert.equal(
      local.snapshot({ databaseHealthy: true }).telemetry.outboundExportEnabled,
      false,
    );
    await local.close();
  } finally {
    if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    else process.env.OTEL_EXPORTER_OTLP_HEADERS = previous;
  }
});
