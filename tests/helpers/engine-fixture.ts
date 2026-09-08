import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  OutcomeUnknownError,
  type JsonObject,
  type Plan,
  type Policy,
  type Principal,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "../../src/contracts.js";

export const operator: Principal = {
  id: "operator-a",
  tenantId: "tenant-a",
  roles: ["operator"],
};
export const approver: Principal = {
  id: "approver-a",
  tenantId: "tenant-a",
  roles: ["approver"],
};
export const viewer: Principal = {
  id: "viewer-a",
  tenantId: "tenant-a",
  roles: ["viewer"],
};
export const otherOperator: Principal = {
  id: "operator-b",
  tenantId: "tenant-b",
  roles: ["operator", "approver"],
};
export const principals: Principal[] = [
  operator,
  approver,
  viewer,
  otherOperator,
];

export function policies(version = "1"): Policy[] {
  return ["tenant-a", "tenant-b"].map((tenantId) => ({
    tenantId,
    version,
    name: "Polityka testowa",
    allowedTools: ["test.read", "test.write"],
    approvalTools: ["test.write"],
    allowSelfApproval: false,
  }));
}

export function plan(name = "Pakiet przekazania"): Plan {
  return {
    title: "Sprawdź i zapisz pakiet",
    summary: "Odczyt, zgoda operatora i niezależne potwierdzenie zapisu.",
    steps: [
      {
        id: "inspect",
        title: "Odczytaj dane",
        toolId: "test.read",
        input: { name },
      },
      {
        id: "save",
        title: "Zapisz pakiet",
        toolId: "test.write",
        input: { name },
      },
    ],
  };
}

export function writePlan(name = "Pakiet przekazania"): Plan {
  const result = plan(name);
  result.steps = result.steps.filter((step) => step.toolId === "test.write");
  return result;
}

export interface FixtureOptions {
  fault?: "unknown-after-apply" | "unknown-before-apply";
  reconciliationUnknown?: boolean;
  failVerification?: boolean;
  afterApply?: () => Promise<void>;
  writeVersion?: string;
}

/** A separate durable store models an external system, not an engine transaction. */
export function createFixtureTools(path: string, options: FixtureOptions = {}) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS effects (
      tenant_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      name TEXT NOT NULL,
      PRIMARY KEY (tenant_id, operation_key)
    );
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      operation_key TEXT NOT NULL
    );
  `);

  function effect(ctx: ToolContext) {
    return db
      .prepare(
        "SELECT name FROM effects WHERE tenant_id = ? AND operation_key = ?",
      )
      .get(ctx.tenantId, ctx.operationKey) as { name: string } | undefined;
  }

  function result(ctx: ToolContext, name: string): ToolResult {
    return { data: { receiptId: ctx.operationKey, name } };
  }

  const inputSchema = z.object({ name: z.string().min(1) }).strict();
  const tools: ToolDefinition[] = [
    {
      id: "test.read",
      version: "1",
      description: "Odczyt lokalnych danych testowych.",
      effect: "read",
      recovery: "idempotent",
      inputSchema,
      async execute(_ctx, input) {
        return { data: { name: input.name! } };
      },
      async verify(ctx, input, output) {
        return {
          ok: output.data.name === input.name,
          summary: "Odczyt odpowiada wskazanym danym.",
          evidence: [
            {
              source: "test-source",
              observedAt: new Date().toISOString(),
              summary: "Dane wejściowe odczytane.",
              data: { tenantId: ctx.tenantId, name: input.name! },
            },
          ],
        };
      },
    },
    {
      id: "test.write",
      version: options.writeVersion ?? "1",
      description: "Zapis wymagający zgody.",
      effect: "write",
      recovery: "reconcile",
      inputSchema,
      async execute(ctx, input) {
        db.prepare(
          "INSERT INTO calls (tenant_id, operation_key) VALUES (?, ?)",
        ).run(ctx.tenantId, ctx.operationKey);
        if (options.fault === "unknown-before-apply")
          throw new OutcomeUnknownError("Nie znamy wyniku połączenia.");
        const name = String(input.name);
        const previous = effect(ctx);
        if (previous && previous.name !== name)
          throw new Error("Operation key reused with different arguments.");
        db.prepare(
          "INSERT OR IGNORE INTO effects (tenant_id, operation_key, name) VALUES (?, ?, ?)",
        ).run(ctx.tenantId, ctx.operationKey, name);
        await options.afterApply?.();
        if (options.fault === "unknown-after-apply")
          throw new OutcomeUnknownError(
            "Odpowiedź zaginęła po trwałym zapisie.",
          );
        return result(ctx, name);
      },
      async reconcile(ctx, input) {
        if (options.reconciliationUnknown)
          return { status: "unknown", reason: "System źródłowy niedostępny." };
        const previous = effect(ctx);
        if (!previous) return { status: "not_applied" };
        if (previous.name !== input.name)
          return {
            status: "unknown",
            reason: "Zapis nie odpowiada zatwierdzonym argumentom.",
          };
        return { status: "applied", result: result(ctx, previous.name) };
      },
      async verify(ctx, input: JsonObject, output) {
        // Read the durable resource independently of execute's response/receipt.
        const current = effect(ctx);
        const ok =
          !options.failVerification &&
          current?.name === input.name &&
          output.data.receiptId === ctx.operationKey &&
          output.data.name === current?.name;
        return {
          ok,
          summary: ok
            ? "Niezależny odczyt potwierdza zapis."
            : "Stan docelowy nie potwierdza wyniku.",
          evidence: [
            {
              source: "fixture-effects-db",
              observedAt: new Date().toISOString(),
              summary: "Odczyt rekordu w oddzielnej bazie narzędzia.",
              data: {
                tenantId: ctx.tenantId,
                operationKey: ctx.operationKey,
                name: current?.name ?? null,
              },
            },
          ],
        };
      },
    },
  ];

  return {
    tools,
    close: () => db.close(),
    effectCount: () =>
      Number(
        (
          db.prepare("SELECT count(*) AS count FROM effects").get() as {
            count: number;
          }
        ).count,
      ),
    executeCount: () =>
      Number(
        (
          db.prepare("SELECT count(*) AS count FROM calls").get() as {
            count: number;
          }
        ).count,
      ),
  };
}
