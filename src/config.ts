import { z } from "zod";
import { resolve } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { DomainError, type Policy, type Principal } from "./contracts.js";

const principalSchema = z
  .object({
    id: z.string().min(1).max(100),
    tenantId: z.string().min(1).max(100),
    roles: z.array(z.enum(["operator", "approver", "viewer"])).min(1),
    scopes: z.array(z.string()).optional(),
  })
  .strict();
const policySchema = z
  .object({
    tenantId: z.string().min(1).max(100),
    version: z.string().min(1),
    name: z.string().min(1),
    allowedTools: z.array(z.string()),
    approvalTools: z.array(z.string()),
    allowSelfApproval: z.boolean(),
  })
  .strict();
const authSchema = z
  .object({
    principals: z
      .array(principalSchema.extend({ token: z.string().min(32).max(512) }))
      .min(1),
    policies: z.array(policySchema).min(1),
  })
  .strict();
export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  mode: "local" | "authenticated" | "accounts";
  principals: Principal[];
  policies: Policy[];
  tokens: Map<string, Principal>;
  plannerKind: "demo" | "anthropic";
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = z
    .enum(["local", "authenticated", "accounts"])
    .parse(env.JARVIS_MODE ?? "local");
  const host = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  if (mode !== "authenticated" && !["127.0.0.1", "::1"].includes(host))
    throw new Error("Local mode must bind a loopback address");
  const plannerKind = env.JARVIS_PLANNER ?? "demo";
  if (plannerKind !== "demo" && plannerKind !== "anthropic")
    throw new Error("Invalid JARVIS_PLANNER");
  let principals: Principal[], policies: Policy[];
  const tokens = new Map<string, Principal>();
  if (mode === "authenticated") {
    if (!env.JARVIS_AUTH_FILE)
      throw new Error("Authenticated mode requires JARVIS_AUTH_FILE");
    let auth: z.infer<typeof authSchema>;
    try {
      const stat = statSync(env.JARVIS_AUTH_FILE);
      if ((stat.mode & 0o077) !== 0)
        throw new Error("Auth file permissions must be private");
      auth = authSchema.parse(
        JSON.parse(readFileSync(env.JARVIS_AUTH_FILE, "utf8")),
      );
    } catch {
      throw new Error("Invalid JARVIS_AUTH_FILE (credentials not logged)");
    }
    principals = auth.principals.map(({ token, ...p }) => {
      if (tokens.has(token)) throw new Error("Duplicate token");
      tokens.set(token, p);
      return p;
    });
    policies = auth.policies;
    if (
      new Set(principals.map((p) => `${p.tenantId}:${p.id}`)).size !==
        principals.length ||
      new Set(policies.map((p) => p.tenantId)).size !== policies.length ||
      principals.some(
        (p) => !policies.some((policy) => policy.tenantId === p.tenantId),
      )
    )
      throw new Error("Ambiguous principal or tenant configuration");
  } else {
    principals = [
      {
        id: "local-operator",
        tenantId: "jarvis-lab",
        roles: ["operator", "approver", "viewer"],
        scopes: ["*"],
      },
    ];
    policies = [
      {
        tenantId: "jarvis-lab",
        version: "lab-v1",
        name: "Laboratorium JARVIS",
        allowedTools: ["demo.inspect", "demo.publish"],
        approvalTools: [],
        allowSelfApproval: true,
      },
    ];
  }
  return {
    host,
    port,
    dataDir: resolve(env.JARVIS_DATA_DIR ?? ".data"),
    mode,
    principals: mode === "accounts" ? [] : principals,
    policies,
    tokens,
    plannerKind,
  };
}
export function authenticate(
  config: AppConfig,
  authorization: string | undefined,
): Principal {
  if (config.mode === "local") return config.principals[0]!;
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (token.length < 32 || token.length > 512)
    throw new DomainError(
      "UNAUTHORIZED",
      "Wymagany poprawny token dostępu.",
      401,
    );
  const supplied = Buffer.from(token);
  for (const [expected, principal] of config.tokens) {
    const candidate = Buffer.from(expected);
    if (
      candidate.length === supplied.length &&
      timingSafeEqual(candidate, supplied)
    )
      return principal;
  }
  throw new DomainError(
    "UNAUTHORIZED",
    "Wymagany poprawny token dostępu.",
    401,
  );
}
