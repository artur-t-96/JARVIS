import Fastify, { type FastifyRequest } from "fastify";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z, ZodError } from "zod";
import { authenticate, type AppConfig } from "./config.js";
import {
  DomainError,
  type Planner,
  type Principal,
  type ToolDefinition,
} from "./contracts.js";
import { Engine } from "./engine.js";

export interface AppOptions {
  engine: Engine;
  config: AppConfig;
  planner: Planner;
  tools: ToolDefinition[];
  version?: string;
  publicDir?: string;
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
  publicDir = resolve("public"),
}: AppOptions) {
  const app = Fastify({
    logger: false,
    bodyLimit: 20_000,
    requestTimeout: 30_000,
    trustProxy: false,
  });
  const principal = (req: FastifyRequest): Principal =>
    authenticate(config, req.headers.authorization);
  const runId = (req: FastifyRequest) =>
    z.object({ id: z.string().uuid() }).parse(req.params).id;
  const counts = new Map<string, { started: number; count: number }>();
  const inFlight = new Set<string>();
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header("Cache-Control", "no-store");
    const host = req.headers.host ?? "";
    if (config.mode === "local") {
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
    if (req.url.startsWith("/api/") && req.url !== "/api/health")
      principal(req);
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
  app.get("/api/context", async (req) => {
    const actor = principal(req);
    const policy = config.policies.find((p) => p.tenantId === actor.tenantId)!;
    return {
      principal: actor,
      policy: { name: policy.name, version: policy.version },
      planner: { kind: planner.kind },
      mode: config.mode,
      tools: tools
        .filter((t) => policy.allowedTools.includes(t.id))
        .map((t) => ({
          id: t.id,
          description: t.description,
          effect: t.effect,
        })),
    };
  });
  app.get("/api/runs", async (req) => ({
    runs: engine.listRuns(principal(req)),
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
        tools.filter((t) => policy.allowedTools.includes(t.id)),
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
  const assets = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/styles.css", "styles.css", "text/css; charset=utf-8"],
  ] as const;
  for (const [route, file, contentType] of assets)
    app.get(route, async (_req, reply) =>
      reply.type(contentType).send(readFileSync(resolve(publicDir, file))),
    );
  return app;
}
