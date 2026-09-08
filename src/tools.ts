import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  DomainError,
  OutcomeUnknownError,
  type JsonObject,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./contracts.js";

export const demoInputSchema = z
  .object({
    subject: z
      .string()
      .min(1)
      .max(240)
      .refine(
        (value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value),
        "Invalid subject",
      ),
  })
  .strict();
type DemoInput = z.infer<typeof demoInputSchema>;
interface PublicationRow {
  id: string;
  tenant_id: string;
  operation_key: string;
  args_hash: string;
  subject: string;
  status: string;
  created_at: string;
}

export interface DemoToolOptions {
  /** Tests only: simulate a lost acknowledgement after the first durable effect. */
  testFaultAfterPublishOnce?: boolean;
}

function validateContext(ctx: ToolContext): void {
  ctx.signal.throwIfAborted();
  if (
    ![ctx.tenantId, ctx.operationKey, ctx.runId, ctx.stepId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 512,
    )
  ) {
    throw new DomainError(
      "invalid_tool_context",
      "Brak poprawnego kontekstu wykonania.",
    );
  }
}

function parseInput(input: JsonObject): DemoInput {
  const parsed = demoInputSchema.safeParse(input);
  if (!parsed.success)
    throw new DomainError(
      "invalid_tool_input",
      "Temat testu musi mieć od 1 do 240 znaków.",
    );
  return parsed.data;
}

// The strict schema has one key, so this serialization is a canonical argument
// representation; extra keys are rejected before hashing or writing.
function inputHash(input: DemoInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ subject: input.subject }))
    .digest("hex");
}

function inspectData(ctx: ToolContext, input: DemoInput): JsonObject {
  return {
    tenantId: ctx.tenantId,
    subject: input.subject,
    fixtureId: "synthetic-publication-v1",
    isTestData: true,
    brief:
      "Stały scenariusz testowy: sprawdzenie tematu i zapis demonstracyjnego rekordu.",
    checks: {
      subjectPresent: true,
      subjectWithinLimit: true,
      externalSystemsUsed: false,
    },
  };
}

function receipt(row: PublicationRow): ToolResult {
  return {
    data: { recordId: row.id, subject: row.subject, status: "published" },
  };
}

export function createDemoTools(
  effectsDbPath: string,
  options: DemoToolOptions = {},
): { tools: ToolDefinition[]; close(): void } {
  if (effectsDbPath !== ":memory:")
    mkdirSync(dirname(effectsDbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(effectsDbPath);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS demo_publications (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status = 'published'),
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, operation_key)
    );
  `);
  const find = db.prepare(
    "SELECT id, tenant_id, operation_key, args_hash, subject, status, created_at FROM demo_publications WHERE tenant_id = ? AND operation_key = ?",
  );
  let faultPending = options.testFaultAfterPublishOnce === true;

  function findPublication(ctx: ToolContext): PublicationRow | undefined {
    return find.get(ctx.tenantId, ctx.operationKey) as unknown as
      PublicationRow | undefined;
  }

  function assertSameInput(row: PublicationRow, input: DemoInput): void {
    if (row.args_hash !== inputHash(input) || row.subject !== input.subject) {
      throw new DomainError(
        "idempotency_conflict",
        "Ten klucz operacji jest już przypisany do innego tematu.",
        409,
      );
    }
  }

  const inspect: ToolDefinition = {
    id: "demo.inspect",
    version: "1",
    effect: "read",
    recovery: "idempotent",
    description:
      "Sprawdza temat na jawnie oznaczonych danych testowych. Nie odczytuje innych aplikacji.",
    inputSchema: demoInputSchema,
    async execute(ctx, raw) {
      validateContext(ctx);
      return { data: inspectData(ctx, parseInput(raw)) };
    },
    async verify(ctx, raw, result) {
      validateContext(ctx);
      const expected = inspectData(ctx, parseInput(raw));
      const ok = JSON.stringify(result.data) === JSON.stringify(expected);
      return {
        ok,
        summary: ok
          ? "Odczyt zgadza się ze stałym zestawem danych testowych."
          : "Odczyt nie zgadza się z danymi testowymi.",
        evidence: [
          {
            source: "demo-fixtures:synthetic-publication-v1",
            summary:
              "Niezależne odtworzenie danych testowych w kontekście organizacji.",
            observedAt: new Date().toISOString(),
            data: expected,
          },
        ],
      };
    },
  };

  const publish: ToolDefinition = {
    id: "demo.publish",
    version: "1",
    effect: "write",
    recovery: "reconcile",
    description:
      "Zapisuje demonstracyjny rekord w lokalnej bazie JARVIS. Nie publikuje w zewnętrznym systemie.",
    inputSchema: demoInputSchema,
    async execute(ctx, raw) {
      validateContext(ctx);
      const input = parseInput(raw);
      db.exec("BEGIN IMMEDIATE");
      let row: PublicationRow;
      let created = false;
      try {
        const existing = findPublication(ctx);
        if (existing) {
          assertSameInput(existing, input);
          row = existing;
        } else {
          const id = randomUUID();
          const now = new Date().toISOString();
          db.prepare(
            "INSERT INTO demo_publications (id, tenant_id, operation_key, args_hash, subject, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            id,
            ctx.tenantId,
            ctx.operationKey,
            inputHash(input),
            input.subject,
            "published",
            now,
          );
          row = {
            id,
            tenant_id: ctx.tenantId,
            operation_key: ctx.operationKey,
            args_hash: inputHash(input),
            subject: input.subject,
            status: "published",
            created_at: now,
          };
          created = true;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (created && faultPending) {
        faultPending = false;
        throw new OutcomeUnknownError(
          "Test: potwierdzenie zapisu nie dotarło.",
        );
      }
      return receipt(row);
    },
    async reconcile(ctx, raw) {
      validateContext(ctx);
      const input = parseInput(raw);
      const row = findPublication(ctx);
      if (!row) return { status: "not_applied" };
      assertSameInput(row, input);
      if (row.status !== "published")
        return { status: "unknown", reason: "Zapis ma nieoczekiwany stan." };
      return { status: "applied", result: receipt(row) };
    },
    async verify(ctx, raw, result) {
      validateContext(ctx);
      const input = parseInput(raw);
      // Read the independently persisted effect; a returned receipt by itself
      // is deliberately insufficient proof of success.
      const row = findPublication(ctx);
      const ok = Boolean(
        row &&
        row.args_hash === inputHash(input) &&
        row.subject === input.subject &&
        row.status === "published" &&
        result.data.recordId === row.id &&
        result.data.subject === row.subject &&
        result.data.status === row.status,
      );
      return {
        ok,
        summary: ok
          ? "Rekord został niezależnie potwierdzony w lokalnej bazie efektów."
          : "Brak zgodnego rekordu w lokalnej bazie efektów.",
        evidence: [
          {
            source: "demo-effects:demo_publications",
            summary: "Odczyt rekordu po organizacji i kluczu operacji.",
            observedAt: new Date().toISOString(),
            data: {
              tenantId: ctx.tenantId,
              operationKey: ctx.operationKey,
              found: Boolean(row),
              ...(row
                ? {
                    recordId: row.id,
                    subject: row.subject,
                    status: row.status,
                    createdAt: row.created_at,
                    argsHash: row.args_hash,
                  }
                : {}),
            },
          },
        ],
      };
    },
  };
  return { tools: [inspect, publish], close: () => db.close() };
}
