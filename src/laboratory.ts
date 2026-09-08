import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { hash } from "./engine.js";
import { migrateDatabase } from "./migrations.js";
import {
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
  DomainError,
} from "./contracts.js";

/** A real HTTP fixture owned entirely by this JARVIS installation, never another application. */
export class LocalLaboratory {
  private db: DatabaseSync;
  private server: Server;
  private token = randomBytes(32).toString("hex");
  private origin = "";
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    migrateDatabase(this.db, {
      namespace: "laboratory",
      migrations: [
        {
          version: 1,
          name: "isolated service fixture and effect ledger",
          up: (db) =>
            db.exec(
              "CREATE TABLE IF NOT EXISTS laboratory_state(tenant_id TEXT PRIMARY KEY,healthy INTEGER NOT NULL,version INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS laboratory_effects(tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(tenant_id,operation_key));",
            ),
        },
      ],
    });
    this.server = createServer((req, res) => {
      if (
        req.headers.authorization !== `Bearer ${this.token}` ||
        req.method !== "GET"
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      let tenant: string;
      try {
        tenant = decodeURIComponent((req.url ?? "").replace(/^\/health\//, ""));
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      const row = this.state(tenant);
      res.writeHead(row.healthy ? 200 : 503, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ fixture: "jarvis-local-service", ...row }));
    });
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Lab failed");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  private state(tenantId: string) {
    const r = this.db
      .prepare("SELECT * FROM laboratory_state WHERE tenant_id=?")
      .get(tenantId) as { healthy: number; version: number } | undefined;
    return { healthy: Boolean(r?.healthy), version: r?.version ?? 0 };
  }
  private async inspect(ctx: ToolContext) {
    const response = await fetch(
      `${this.origin}/health/${encodeURIComponent(ctx.tenantId)}`,
      {
        redirect: "error",
        signal: ctx.signal,
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    const body = z
      .object({
        fixture: z.literal("jarvis-local-service"),
        healthy: z.boolean(),
        version: z.number().int().nonnegative(),
      })
      .parse(await response.json());
    if (response.status !== (body.healthy ? 200 : 503))
      throw new Error("Inconsistent lab health");
    return {
      ...body,
      httpStatus: response.status,
      observedAt: new Date().toISOString(),
      environment: "jarvis-laboratory",
    };
  }
  private effect(ctx: ToolContext, input: unknown) {
    const r = this.db
      .prepare(
        "SELECT * FROM laboratory_effects WHERE tenant_id=? AND operation_key=?",
      )
      .get(ctx.tenantId, ctx.operationKey) as
      { input_hash: string; result_json: string } | undefined;
    if (r && r.input_hash !== hash(input))
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Konflikt operacji laboratorium.",
        409,
      );
    return r ? (JSON.parse(r.result_json) as ToolResult) : undefined;
  }
  tools(): ToolDefinition[] {
    const inspect: ToolDefinition = {
      id: "lab.inspect",
      scope: "it",
      version: "1",
      description: "Sprawdź HTTP własnego laboratorium JARVIS",
      effect: "read",
      recovery: "idempotent",
      inputSchema: z.object({}).strict(),
      execute: async (ctx) => ({ data: await this.inspect(ctx) }),
      verify: async (_ctx, _input, result) => ({
        ok: result.data.fixture === "jarvis-local-service",
        summary: "Odczytano faktyczny status HTTP lokalnej usługi testowej.",
        evidence: [
          {
            source: "jarvis-laboratory/http",
            summary: `HTTP ${result.data.httpStatus}`,
            observedAt: String(result.data.observedAt),
            data: result.data,
          },
        ],
      }),
    };
    const change = (healthy: boolean): ToolDefinition => ({
      id: healthy ? "lab.repair" : "lab.simulateFailure",
      scope: "it",
      version: "2",
      description: healthy
        ? "Przywróć usługę w laboratorium JARVIS"
        : "Wprowadź kontrolowaną awarię własnego laboratorium",
      effect: "write",
      recovery: "idempotent",
      inputSchema: z
        .object({ expectedVersion: z.number().int().nonnegative() })
        .strict(),
      execute: async (ctx, input) => {
        ctx.signal.throwIfAborted();
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const existing = this.effect(ctx, { healthy, input });
          if (existing) {
            this.db.exec("COMMIT");
            return existing;
          }
          const current = this.state(ctx.tenantId);
          if (current.version !== input.expectedVersion)
            throw new DomainError(
              "VERSION_CONFLICT",
              "Stan laboratorium zmienił się. Sprawdź go ponownie.",
              409,
            );
          const version = current.version + 1;
          this.db
            .prepare(
              "INSERT INTO laboratory_state VALUES(?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET healthy=excluded.healthy,version=excluded.version",
            )
            .run(ctx.tenantId, healthy ? 1 : 0, version);
          const result = {
            data: {
              fixture: "jarvis-local-service",
              healthy,
              version,
              environment: "jarvis-laboratory",
            },
          };
          this.db
            .prepare("INSERT INTO laboratory_effects VALUES(?,?,?,?)")
            .run(
              ctx.tenantId,
              ctx.operationKey,
              hash({ healthy, input }),
              JSON.stringify(result),
            );
          this.db.exec("COMMIT");
          return result;
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
      },
      reconcile: async (ctx, input) => {
        const result = this.effect(ctx, { healthy, input });
        return result
          ? { status: "applied", result }
          : { status: "not_applied" };
      },
      verify: async (ctx, _input, result) => {
        const observed = await this.inspect(ctx);
        return {
          ok:
            observed.healthy === healthy &&
            observed.version === result.data.version,
          summary: "Niezależny test HTTP lokalnej usługi po operacji.",
          evidence: [
            {
              source: "jarvis-laboratory/http",
              summary: `HTTP ${observed.httpStatus}`,
              observedAt: observed.observedAt,
              data: observed,
            },
          ],
        };
      },
    });
    return [inspect, change(true), change(false)];
  }
  async close() {
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve())),
    );
    this.db.close();
  }
}
