import assert from "node:assert/strict";
import { get, type ClientRequest } from "node:http";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Diagnostics } from "../src/diagnostics.js";
import { Engine } from "../src/engine.js";
import { writePlan } from "./helpers/engine-fixture.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test(
  "an aborted real HTTP response closes correlation once while its handler can finish",
  { timeout: 5000 },
  async () => {
    const lines: Record<string, unknown>[] = [];
    const entered = barrier();
    const continueHandler = barrier();
    const handlerFinished = barrier();
    const abortLogged = barrier();
    const diagnostics = new Diagnostics({
      dataDir: tmpdir(),
      version: "test",
      writeLog: (line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        lines.push(parsed);
        if (parsed.event === "http.request" && parsed.statusCode === 499)
          abortLogged.release();
      },
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
    let requestObject: object | undefined;
    let handlerTrace: string | undefined;
    let client: ClientRequest | undefined;
    app.get("/lifetime-test", async (req) => {
      requestObject = req;
      handlerTrace = diagnostics.currentContext()?.traceId;
      entered.release();
      await continueHandler.promise;
      assert.equal(diagnostics.currentContext(), undefined);
      diagnostics.log("info", "test.late_continuation", {
        password: "PRIVATE-HANDLER-SECRET",
      });
      handlerFinished.release();
      return { ok: true };
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      client = get(`${address}/lifetime-test?private=PRIVATE-QUERY`);
      client.on("error", () => {});
      await entered.promise;
      assert.match(handlerTrace!, /^[a-f0-9]{32}$/);
      assert.equal(
        diagnostics.snapshot({ databaseHealthy: true }).telemetry.activeTraces,
        1,
      );
      client.destroy();
      await abortLogged.promise;
      await setImmediate();
      assert.equal(
        diagnostics.snapshot({ databaseHealthy: true }).telemetry.activeTraces,
        0,
      );
      // A late response/error notification must neither reopen nor double-count the request.
      diagnostics.finishRequest(requestObject!, {
        method: "GET",
        route: "/lifetime-test",
        statusCode: 200,
        durationMs: 1,
      });
      continueHandler.release();
      await handlerFinished.promise;
      await setImmediate();
      const requests = lines.filter((line) => line.event === "http.request");
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.statusCode, 499);
      assert.equal(requests[0]!.traceId, handlerTrace);
      assert.equal(
        diagnostics.snapshot({ databaseHealthy: true }).telemetry.counters
          .requests,
        1,
      );
      assert.equal(
        lines.find((line) => line.event === "test.late_continuation")!.traceId,
        undefined,
      );
      assert.doesNotMatch(
        JSON.stringify(lines),
        /PRIVATE-QUERY|PRIVATE-HANDLER-SECRET/,
      );
      assert.equal(diagnostics.currentContext(), undefined);
    } finally {
      continueHandler.release();
      client?.destroy();
      await app.close();
      engine.close();
      await diagnostics.close();
    }
  },
);

test(
  "active span eviction bounds hung operations without repeating or cancelling their effects",
  { timeout: 5000 },
  async () => {
    const lines: Record<string, unknown>[] = [];
    const diagnostics = new Diagnostics({
      dataDir: tmpdir(),
      version: "test",
      writeLog: (line) => lines.push(JSON.parse(line)),
    });
    const releaseOperations = barrier();
    const before: (string | undefined)[] = [];
    const after: (string | undefined)[] = [];
    let effects = 0;
    const operations = Array.from({ length: 300 }, (_, index) =>
      diagnostics.withSpan("test.pending", async () => {
        effects++;
        before[index] = diagnostics.currentContext()?.traceId;
        await releaseOperations.promise;
        after[index] = diagnostics.currentContext()?.traceId;
        diagnostics.log("info", "test.operation_finished", {
          count: index,
          password: "PRIVATE-SECRET",
        });
        return index;
      }),
    );
    try {
      const pending = diagnostics.snapshot({ databaseHealthy: true }).telemetry;
      assert.equal(effects, 300);
      assert.equal(pending.activeTraces, 256);
      assert.equal(pending.evictedActiveTraces, 44);
      assert.ok(pending.retainedTraces <= 128);
      assert.equal(new Set(before).size, 300);
      assert.equal(diagnostics.currentContext(), undefined);
      releaseOperations.release();
      assert.deepEqual(
        await Promise.all(operations),
        Array.from({ length: 300 }, (_, index) => index),
      );
      assert.equal(effects, 300);
      assert.ok(after.slice(0, 44).every((traceId) => traceId === undefined));
      assert.deepEqual(after.slice(44), before.slice(44));
      const finished = diagnostics.snapshot({
        databaseHealthy: true,
      }).telemetry;
      assert.equal(finished.activeTraces, 0);
      assert.ok(finished.retainedTraces <= 128);
      assert.equal(finished.evictedActiveTraces, 44);
      assert.equal(lines.length, 300);
      assert.ok(lines.slice(0, 44).every((line) => line.traceId === undefined));
      assert.doesNotMatch(JSON.stringify(lines), /PRIVATE-SECRET/);
      assert.equal(diagnostics.currentContext(), undefined);
    } finally {
      releaseOperations.release();
      await Promise.allSettled(operations);
      await diagnostics.close();
    }
  },
);
