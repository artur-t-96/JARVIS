import Fastify, { type FastifyRequest } from "fastify";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { authenticate, type AppConfig } from "./config.js";
import {
  DomainError,
  hasToolAccess,
  type Planner,
  type Principal,
  type ToolDefinition,
} from "./contracts.js";
import { Engine } from "./engine.js";
import { Accounts } from "./accounts.js";
import { WorkspaceStore } from "./workspace.js";
import { Conversations } from "./assistant.js";
import { Diagnostics } from "./diagnostics.js";
import { InitiativeStore } from "./initiative.js";
import { VoiceService } from "./voice.js";
import { registerWorkspaceApi } from "./workspace-api.js";

export interface AppOptions {
  engine: Engine;
  config: AppConfig;
  planner: Planner;
  tools: ToolDefinition[];
  version?: string;
  publicDir?: string;
  accounts?: Accounts;
  workspace?: WorkspaceStore;
  conversations?: Conversations;
  diagnostics?: Diagnostics;
  voice?: VoiceService;
  initiatives?: InitiativeStore;
}
const createSchema = z
  .object({
    request: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().regex(/^[a-zA-Z0-9_:.-]{8,128}$/),
  })
  .strict();
const decisionSchema = z
  .object({
    approvalId: z.string().uuid(),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();
const emptySchema = z.object({}).strict();
export function createApp({
  engine,
  config,
  planner,
  tools,
  version = "development",
  publicDir = resolve(
    existsSync("dist/web/index.html") ? "dist/web" : "public",
  ),
  accounts,
  workspace,
  conversations,
  diagnostics,
  voice,
  initiatives,
}: AppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 20_000,
    requestTimeout: 30_000,
    trustProxy: false,
  });
  const principal = (req: FastifyRequest): Principal => {
    if (config.mode === "accounts" && accounts) {
      engine.setPrincipals(accounts.principals());
      return accounts.authenticate(req.headers.cookie);
    }
    return authenticate(config, req.headers.authorization);
  };
  const runId = (req: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(req.params).id;
  const counts = new Map<string, { started: number; count: number }>();
  const inFlight = new Set<string>();
  app.addHook("onRequest", (req, reply, done) => {
    if (diagnostics)
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished)
          diagnostics.finishRequest(req, {
            method: req.method,
            route: req.routeOptions.url ?? "unknown",
            statusCode: 499,
            durationMs: reply.elapsedTime,
            requestId: req.id,
          });
      });
    if (diagnostics) diagnostics.startRequest(req, done);
    else done();
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("Cache-Control", "no-store");
    const host = req.headers.host ?? "";
    if (config.mode !== "authenticated") {
      const remote = req.ip;
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote))
        throw new DomainError(
          "FORBIDDEN",
          "Tryb lokalny jest dostępny tylko na tym komputerze.",
          403,
        );
      let hostname: string;
      try {
        hostname = new URL(`http://${host}`).hostname;
      } catch {
        throw new DomainError(
          "INVALID_HOST",
          "Niepoprawny adres serwera.",
          400,
        );
      }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname))
        throw new DomainError(
          "INVALID_HOST",
          "Niepoprawny adres serwera lokalnego.",
          403,
        );
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new DomainError(
          "CONTENT_TYPE",
          "Wymagany Content-Type application/json.",
          415,
        );
      if (req.headers["sec-fetch-site"] === "cross-site")
        throw new DomainError(
          "CROSS_ORIGIN",
          "Żądanie pochodzi z innej witryny.",
          403,
        );
      if (req.headers.origin) {
        let origin: URL;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          throw new DomainError(
            "CROSS_ORIGIN",
            "Niepoprawne źródło żądania.",
            403,
          );
        }
        if (
          origin.host !== host ||
          !["http:", "https:"].includes(origin.protocol)
        )
          throw new DomainError(
            "CROSS_ORIGIN",
            "Żądanie pochodzi z innej witryny.",
            403,
          );
      }
    }
    if (
      req.url.startsWith("/api/") &&
      ![
        "/api/health",
        "/api/live",
        "/api/ready",
        "/api/auth/status",
        "/api/auth/login",
      ].includes(req.url.split("?")[0]!)
    )
      principal(req);
  });
  app.addHook("onResponse", async (req, reply) => {
    diagnostics?.finishRequest(req, {
      method: req.method,
      route: req.routeOptions.url ?? "unknown",
      statusCode: reply.statusCode,
      durationMs: reply.elapsedTime,
      requestId: req.id,
    });
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message } });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Niepoprawne dane żądania.",
        },
      });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({
        error: { code: "BAD_REQUEST", message: "Niepoprawne żądanie." },
      });
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Nie udało się wykonać operacji.",
      },
    });
  });
  app.get("/api/health", async (_req, reply) => {
    try {
      return { status: "healthy", version, checks: engine.health() };
    } catch {
      return reply.code(503).send({
        status: "unhealthy",
        version,
        checks: { database: "unhealthy" },
      });
    }
  });
  app.get("/api/live", async () => ({ status: "alive", version }));
  app.get("/api/ready", async (_req, reply) => {
    let healthy = true;
    try {
      engine.health();
      workspace?.health();
      initiatives?.health();
    } catch {
      healthy = false;
    }
    const state = diagnostics?.snapshot({
      databaseHealthy: healthy,
      queue: engine.queue(),
    });
    return reply
      .code((state?.ready ?? healthy) ? 200 : 503)
      .send({ ready: state?.ready ?? healthy, version });
  });
  app.get("/api/auth/status", async (req) => {
    let authenticated = false;
    try {
      principal(req);
      authenticated = true;
    } catch {}
    return {
      mode: config.mode,
      authenticated,
      setupRequired: config.mode === "accounts" && !accounts?.count(),
    };
  });
  app.post("/api/auth/login", async (req, reply) => {
    if (config.mode !== "accounts" || !accounts)
      throw new DomainError(
        "AUTH_MODE",
        "Logowanie kontem nie jest włączone.",
        400,
      );
    const input = z
      .object({
        username: z.string().trim().min(1).max(100),
        password: z.string().min(1).max(256),
      })
      .strict()
      .parse(req.body);
    const result = accounts.login(input.username, input.password);
    reply.header(
      "Set-Cookie",
      `jarvis_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${req.protocol === "https" ? "; Secure" : ""}`,
    );
    return { principal: result.principal };
  });
  app.post("/api/auth/logout", async (req, reply) => {
    emptySchema.parse(req.body);
    accounts?.logout(req.headers.cookie);
    reply.header(
      "Set-Cookie",
      "jarvis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return { ok: true };
  });
  app.get("/api/context", async (req) => {
    const actor = principal(req);
    const policy = config.policies.find((p) => p.tenantId === actor.tenantId)!;
    return {
      principal: actor,
      policy: { name: policy.name, version: policy.version },
      planner: { kind: planner.kind },
      mode: config.mode,
      tools: tools
        .filter(
          (t) => policy.allowedTools.includes(t.id) && hasToolAccess(actor, t),
        )
        .map((t) => ({
          id: t.id,
          description: t.description,
          effect: t.effect,
        })),
    };
  });
  app.get("/api/runs", async (req) => ({
    runs: engine.listRuns(
      principal(req),
      z
        .object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          offset: z.coerce.number().int().min(0).max(100000).optional(),
        })
        .parse(req.query),
    ),
  }));
  app.get("/api/runs/:id", async (req) => ({
    run: engine.getRun(principal(req), runId(req)),
  }));
  app.post("/api/runs", async (req, reply) => {
    const actor = principal(req);
    if (!actor.roles.includes("operator"))
      throw new DomainError(
        "FORBIDDEN",
        "Brak uprawnienia do planowania.",
        403,
      );
    const { request, idempotencyKey } = createSchema.parse(req.body);
    // API replay skips provider work. Engine independently protects the persistent command.
    const previous = engine.replayRun(actor, request, idempotencyKey);
    if (previous) return { run: previous };
    const key = `${actor.tenantId}:${actor.id}`;
    let count = counts.get(key);
    if (!count || Date.now() - count.started > 60_000) {
      count = { started: Date.now(), count: 0 };
      counts.set(key, count);
    }
    if (++count.count > 12 || inFlight.has(key))
      throw new DomainError(
        "RATE_LIMIT",
        "Zaczekaj chwilę przed kolejnym planowaniem.",
        429,
      );
    inFlight.add(key);
    try {
      const policy = config.policies.find(
        (p) => p.tenantId === actor.tenantId,
      )!;
      const plan = await planner.plan(
        request,
        tools.filter(
          (t) => policy.allowedTools.includes(t.id) && hasToolAccess(actor, t),
        ),
      );
      return reply.code(201).send({
        run:
          engine.replayRun(actor, request, idempotencyKey) ??
          engine.createRun(actor, request, plan, idempotencyKey),
      });
    } finally {
      inFlight.delete(key);
    }
  });
  app.post("/api/runs/:id/start", async (req) => {
    emptySchema.parse(req.body);
    return { run: engine.start(principal(req), runId(req)) };
  });
  app.post("/api/runs/:id/approve", async (req) => ({
    run: engine.approve(
      principal(req),
      runId(req),
      decisionSchema.parse(req.body),
    ),
  }));
  app.post("/api/runs/:id/cancel", async (req) => {
    emptySchema.parse(req.body);
    return { run: engine.cancel(principal(req), runId(req)) };
  });
  app.post("/api/runs/:id/retry", async (req) => {
    emptySchema.parse(req.body);
    return { run: engine.retry(principal(req), runId(req)) };
  });
  if (workspace)
    registerWorkspaceApi(app, {
      workspace,
      engine,
      tools,
      principal,
      conversations,
      diagnostics,
      initiatives,
      dataDir: config.dataDir === "/unused" ? undefined : config.dataDir,
    });
  app.get(
    "/api/voice/status",
    async () =>
      voice?.status() ?? {
        available: false,
        reason: "Moduł głosowy nie jest skonfigurowany.",
      },
  );
  app.post(
    "/api/voice/transcribe",
    { bodyLimit: 3 * 1024 * 1024 },
    async (req) => {
      const actor = principal(req);
      if (!actor.roles.includes("operator"))
        throw new DomainError("FORBIDDEN", "Brak uprawnienia do rozmowy.", 403);
      if (!voice)
        throw new DomainError(
          "VOICE_UNAVAILABLE",
          "Moduł głosowy niedostępny.",
          503,
        );
      return voice.transcribe(
        z
          .object({ audio: z.string(), mimeType: z.string() })
          .strict()
          .parse(req.body),
      );
    },
  );
  const assets = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ] as const;
  for (const [route, file, contentType] of assets)
    app.get(route, async (_req, reply) =>
      reply.type(contentType).send(readFileSync(resolve(publicDir, file))),
    );
  const bundleDir = resolve(publicDir, "assets");
  if (existsSync(bundleDir))
    for (const file of readdirSync(bundleDir)) {
      if (!/^[a-zA-Z0-9_.-]+\.(js|css|svg|woff2)$/.test(file)) continue;
      app.get(`/assets/${file}`, async (_req, reply) =>
        reply
          .type(
            file.endsWith(".js")
              ? "text/javascript"
              : file.endsWith(".css")
                ? "text/css"
                : file.endsWith(".svg")
                  ? "image/svg+xml"
                  : "font/woff2",
          )
          .send(readFileSync(resolve(bundleDir, file))),
      );
    }
  return app;
}
