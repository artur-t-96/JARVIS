import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { authenticate, loadConfig } from "../src/config.js";
import { Engine, type RunDetail } from "../src/engine.js";
import { type Planner } from "../src/contracts.js";
import {
  approver,
  createFixtureTools,
  operator,
  otherOperator,
  policies,
  principals,
  viewer,
  writePlan,
} from "./helpers/engine-fixture.js";

// Deliberately synthetic credentials confined to temporary test files.
const tokens = Object.fromEntries(
  principals.map((principal) => [
    principal.id,
    `test-only-${principal.id}-${"x".repeat(40)}`,
  ]),
);
const bearer = (id = operator.id) => ({
  authorization: `Bearer ${tokens[id]}`,
});
const payload = {
  request: "Przygotuj pakiet przekazania.",
  idempotencyKey: "api-request-1",
};

function setup(mode: "local" | "authenticated" = "authenticated") {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-http-test-"));
  const authPath = join(directory, "auth.json");
  writeFileSync(
    authPath,
    JSON.stringify({
      principals: principals.map((principal) => ({
        ...principal,
        token: tokens[principal.id],
      })),
      policies: policies(),
    }),
    { mode: 0o600 },
  );
  const config = loadConfig({
    JARVIS_MODE: mode,
    JARVIS_AUTH_FILE: authPath,
    JARVIS_DATA_DIR: directory,
  });
  if (mode === "local") {
    config.policies = config.policies.map((policy) => ({
      ...policy,
      allowedTools: ["test.read", "test.write"],
    }));
  }
  const fixture = createFixtureTools(join(directory, "effects.sqlite"));
  let plannerCalls = 0;
  const planner: Planner = {
    kind: "test-planner",
    async plan() {
      plannerCalls++;
      return writePlan();
    },
  };
  const version = "a".repeat(40);
  const openEngine = () =>
    new Engine({
      dbPath: join(directory, "engine.sqlite"),
      tools: fixture.tools,
      policies: config.policies,
      principals: config.principals,
    });
  let engine = openEngine();
  let app = createApp({
    engine,
    config,
    planner,
    tools: fixture.tools,
    version,
  });
  return {
    config,
    fixture,
    version,
    get app() {
      return app;
    },
    get engine() {
      return engine;
    },
    plannerCalls: () => plannerCalls,
    async restart() {
      await app.close();
      engine.close();
      engine = openEngine();
      app = createApp({
        engine,
        config,
        planner,
        tools: fixture.tools,
        version,
      });
    },
    async close() {
      await app.close();
      engine.close();
      fixture.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("every business API requires authentication, including missing-resource paths", async () => {
  const ctx = setup();
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const routes = [
      { method: "GET" as const, url: "/api/context" },
      { method: "GET" as const, url: "/api/runs" },
      { method: "GET" as const, url: `/api/runs/${id}` },
      { method: "GET" as const, url: "/api/does-not-exist" },
      { method: "POST" as const, url: "/api/runs" },
      ...["start", "approve", "cancel", "retry"].map((operation) => ({
        method: "POST" as const,
        url: `/api/runs/${id}/${operation}`,
      })),
    ];
    for (const route of routes) {
      const response = await ctx.app.inject({
        ...route,
        ...(route.method === "POST" ? { payload: {} } : {}),
      });
      assert.equal(response.statusCode, 401, `${route.method} ${route.url}`);
      assert.equal(response.json().error.code, "UNAUTHORIZED");
    }
    for (const authorization of [
      "Basic arbitrary",
      "Bearer short",
      `Bearer ${"z".repeat(80)}`,
    ]) {
      assert.equal(
        (
          await ctx.app.inject({
            method: "GET",
            url: "/api/runs",
            headers: { authorization },
          })
        ).statusCode,
        401,
      );
    }
    assert.equal(ctx.plannerCalls(), 0);
    assert.equal(ctx.fixture.effectCount(), 0);
  } finally {
    await ctx.close();
  }
});

test("HTTP tenant and actor are derived from credentials, never caller-supplied fields", async () => {
  const ctx = setup();
  try {
    const own = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: bearer(),
      payload,
    });
    const run = own.json().run as RunDetail;
    assert.equal(own.statusCode, 201);
    for (const forged of [
      { tenantId: otherOperator.tenantId },
      { actor: approver.id },
      { principal: { ...operator, tenantId: otherOperator.tenantId } },
      { plan: writePlan("Plan podsunięty przez wywołującego") },
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/runs",
        headers: bearer(),
        payload: { ...payload, idempotencyKey: "forged-request", ...forged },
      });
      assert.equal(response.statusCode, 400);
    }
    const forgedHeaders = {
      ...bearer(otherOperator.id),
      "x-tenant-id": operator.tenantId,
      "x-user-id": operator.id,
      "x-roles": "operator,approver",
    };
    assert.equal(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/runs/${run.id}`,
          headers: forgedHeaders,
        })
      ).statusCode,
      404,
    );
    for (const operation of ["start", "cancel", "retry"]) {
      assert.equal(
        (
          await ctx.app.inject({
            method: "POST",
            url: `/api/runs/${run.id}/${operation}`,
            headers: forgedHeaders,
            payload: {},
          })
        ).statusCode,
        404,
      );
    }
    assert.deepEqual(
      (
        await ctx.app.inject({
          method: "GET",
          url: "/api/runs",
          headers: forgedHeaders,
        })
      ).json().runs,
      [],
    );
    const asViewer = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { ...bearer(viewer.id), "x-roles": "operator" },
      payload: { ...payload, idempotencyKey: "viewer-request" },
    });
    assert.equal(asViewer.statusCode, 403);
    assert.equal(ctx.engine.getRun(operator, run.id).status, "planned");
    assert.equal(ctx.plannerCalls(), 1);
    assert.equal(ctx.fixture.effectCount(), 0);
  } finally {
    await ctx.close();
  }
});

test("HTTP replay is durable and skips repeated planner calls, including conflicts", async () => {
  const ctx = setup();
  try {
    const first = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: bearer(),
      payload,
    });
    assert.equal(first.statusCode, 201);
    const id = first.json().run.id;
    const replay = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: bearer(),
      payload,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().run.id, id);
    assert.equal(ctx.plannerCalls(), 1);
    await ctx.restart();
    const afterRestart = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: bearer(),
      payload,
    });
    assert.equal(afterRestart.statusCode, 200);
    assert.equal(afterRestart.json().run.id, id);
    assert.equal(ctx.plannerCalls(), 1);
    const conflict = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: bearer(),
      payload: { ...payload, request: "Inne zadanie." },
    });
    assert.equal(conflict.statusCode, 409);
    assert.equal(ctx.plannerCalls(), 1);
    assert.equal(ctx.engine.listRuns(operator).length, 1);
  } finally {
    await ctx.close();
  }
});

test("HTTP rejects stale approval and accepts only the bound operation without duplicate effects", async () => {
  const ctx = setup();
  try {
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      headers: bearer(),
      payload,
    });
    const id = created.json().run.id as string;
    assert.equal(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/api/runs/${id}/start`,
          headers: bearer(),
          payload: {},
        })
      ).statusCode,
      200,
    );
    await ctx.engine.tick();
    const waiting = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/runs/${id}`,
        headers: bearer(),
      })
    ).json().run as RunDetail;
    assert.equal(waiting.status, "waiting_approval");
    const approval = waiting.steps[0]!.approval!;
    const decision = {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    };
    const deniedTenant = await ctx.app.inject({
      method: "POST",
      url: `/api/runs/${id}/approve`,
      headers: bearer(otherOperator.id),
      payload: decision,
    });
    assert.equal(deniedTenant.statusCode, 404);
    const stale = await ctx.app.inject({
      method: "POST",
      url: `/api/runs/${id}/approve`,
      headers: bearer(approver.id),
      payload: { ...decision, bindingHash: "0".repeat(64) },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "STALE_APPROVAL");
    assert.equal(ctx.fixture.executeCount(), 0);
    assert.equal(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/api/runs/${id}/approve`,
          headers: bearer(approver.id),
          payload: decision,
        })
      ).statusCode,
      200,
    );
    await ctx.engine.tick();
    const done = (
      await ctx.app.inject({
        method: "GET",
        url: `/api/runs/${id}`,
        headers: bearer(viewer.id),
      })
    ).json().run as RunDetail;
    assert.equal(done.status, "completed");
    assert.equal(done.steps[0]!.verification?.ok, true);
    assert.equal(
      (
        await ctx.app.inject({
          method: "POST",
          url: `/api/runs/${id}/approve`,
          headers: bearer(approver.id),
          payload: decision,
        })
      ).statusCode,
      200,
    );
    await ctx.engine.tick();
    assert.equal(ctx.fixture.effectCount(), 1);
    assert.equal(ctx.fixture.executeCount(), 1);
  } finally {
    await ctx.close();
  }
});

test("local mode requires both a loopback peer and a loopback Host", async () => {
  const ctx = setup("local");
  try {
    const allowed = await ctx.app.inject({
      method: "GET",
      url: "/api/context",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:4310" },
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.json().principal.tenantId, "jarvis-lab");
    // light-my-request replaces an empty Host with localhost, so use malformed non-empty input.
    for (const host of [
      "evil.example:4310",
      "127.0.0.1.evil.example:4310",
      "localhost.evil.example",
      "not valid host",
    ]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: "/api/context",
        remoteAddress: "127.0.0.1",
        headers: { host },
      });
      assert.ok(
        [400, 403].includes(response.statusCode),
        `Host ${host} must be refused`,
      );
    }
    const remote = await ctx.app.inject({
      method: "GET",
      url: "/api/context",
      remoteAddress: "198.51.100.20",
      headers: { host: "localhost:4310", "x-forwarded-for": "127.0.0.1" },
    });
    assert.equal(
      remote.statusCode,
      403,
      "forwarded headers cannot turn a remote peer into a local one",
    );
  } finally {
    await ctx.close();
  }
});

test("mutating HTTP requests reject cross-site origins and non-JSON bodies before planning", async () => {
  const ctx = setup("local");
  try {
    const base = {
      method: "POST" as const,
      url: "/api/runs",
      remoteAddress: "127.0.0.1",
      payload,
    };
    for (const origin of [
      "https://evil.example",
      "http://localhost:9999",
      "null",
      "not a url",
    ]) {
      const response = await ctx.app.inject({
        ...base,
        headers: { host: "localhost:4310", origin },
      });
      assert.equal(
        response.statusCode,
        403,
        `Origin ${origin} must be refused`,
      );
    }
    const crossSite = await ctx.app.inject({
      ...base,
      headers: {
        host: "localhost:4310",
        origin: "http://localhost:4310",
        "sec-fetch-site": "cross-site",
      },
    });
    assert.equal(crossSite.statusCode, 403);
    const form = await ctx.app.inject({
      method: "POST",
      url: "/api/runs",
      remoteAddress: "127.0.0.1",
      headers: { host: "localhost:4310", "content-type": "text/plain" },
      payload: JSON.stringify(payload),
    });
    assert.equal(form.statusCode, 415);
    assert.equal(ctx.plannerCalls(), 0);
    const legitimate = await ctx.app.inject({
      ...base,
      headers: {
        host: "localhost:4310",
        origin: "http://localhost:4310",
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(legitimate.statusCode, 201);
    assert.equal(ctx.plannerCalls(), 1);
  } finally {
    await ctx.close();
  }
});

test("public health reports the supplied source revision and excludes credentials or tenant data", async () => {
  const ctx = setup();
  try {
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/health",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "healthy",
      version: ctx.version,
      checks: { database: "healthy", worker: "ready" },
    });
    assert.equal(response.headers["cache-control"], "no-store");
    for (const token of Object.values(tokens))
      assert.equal(response.body.includes(token), false);
    assert.equal(response.body.includes(operator.tenantId), false);
    const context = await ctx.app.inject({
      method: "GET",
      url: "/api/context",
      headers: bearer(),
    });
    assert.equal(context.statusCode, 200);
    for (const token of Object.values(tokens))
      assert.equal(context.body.includes(token), false);
    assert.match(
      String(context.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
  } finally {
    await ctx.close();
  }
});

test("configuration refuses unsafe local binding and invalid or ambiguous credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "jarvis-config-test-"));
  const path = join(directory, "auth.json");
  try {
    assert.throws(
      () => loadConfig({ JARVIS_MODE: "local", HOST: "0.0.0.0" }),
      /loopback/,
    );
    assert.throws(
      () => loadConfig({ JARVIS_MODE: "authenticated" }),
      /JARVIS_AUTH_FILE/,
    );
    assert.throws(() => loadConfig({ PORT: "0" }), /PORT/);
    writeFileSync(path, "{invalid", { mode: 0o600 });
    assert.throws(
      () =>
        loadConfig({ JARVIS_MODE: "authenticated", JARVIS_AUTH_FILE: path }),
      /Invalid JARVIS_AUTH_FILE/,
    );
    writeFileSync(
      path,
      JSON.stringify({
        principals: [
          { ...operator, token: tokens[operator.id] },
          { ...viewer, token: tokens[operator.id] },
        ],
        policies: policies(),
      }),
    );
    assert.throws(
      () =>
        loadConfig({ JARVIS_MODE: "authenticated", JARVIS_AUTH_FILE: path }),
      /Duplicate token/,
    );
    writeFileSync(
      path,
      JSON.stringify({
        principals: [{ ...operator, token: tokens[operator.id] }],
        policies: [],
      }),
    );
    assert.throws(() =>
      loadConfig({ JARVIS_MODE: "authenticated", JARVIS_AUTH_FILE: path }),
    );
    writeFileSync(
      path,
      JSON.stringify({
        principals: [{ ...operator, token: tokens[operator.id] }],
        policies: policies(),
      }),
    );
    const config = loadConfig({
      JARVIS_MODE: "authenticated",
      JARVIS_AUTH_FILE: path,
      JARVIS_DATA_DIR: directory,
      HOST: "0.0.0.0",
    });
    assert.deepEqual(
      authenticate(config, `Bearer ${tokens[operator.id]}`),
      operator,
    );
    assert.throws(() =>
      authenticate(config, `Bearer ${"not-a-fixture-token".repeat(4)}`),
    );
    assert.equal("token" in config.principals[0]!, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
