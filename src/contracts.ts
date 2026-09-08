import { z } from "zod";

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type RunStatus =
  | "planned"
  | "running"
  | "waiting_approval"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "needs_reconciliation";
export type StepStatus =
  | "pending"
  | "executing"
  | "verifying"
  | "waiting_approval"
  | "succeeded"
  | "blocked"
  | "failed"
  | "unknown";

export const stepSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
    title: z.string().min(1).max(160),
    toolId: z.string().min(1).max(100),
    input: z.record(z.string(), z.json()),
  })
  .strict();
export const planSchema = z
  .object({
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(2000),
    steps: z.array(stepSchema).min(1).max(12),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;
export type PlanStep = Plan["steps"][number];

export interface Principal {
  id: string;
  tenantId: string;
  roles: ("operator" | "approver" | "viewer")[];
}
export interface Policy {
  tenantId: string;
  version: string;
  name: string;
  allowedTools: string[];
  approvalTools: string[];
  allowSelfApproval: boolean;
}
export interface Evidence {
  source: string;
  summary: string;
  observedAt: string;
  data: JsonObject;
}
export interface ToolResult {
  data: JsonObject;
}
export interface Verification {
  ok: boolean;
  summary: string;
  evidence: Evidence[];
}
export interface ToolContext {
  tenantId: string;
  runId: string;
  stepId: string;
  operationKey: string;
  signal: AbortSignal;
}
export type Reconciliation =
  | { status: "applied"; result: ToolResult }
  | { status: "not_applied" }
  | { status: "unknown"; reason: string };
export interface ToolDefinition {
  id: string;
  version: string;
  description: string;
  effect: "read" | "write";
  recovery: "idempotent" | "reconcile" | "manual";
  inputSchema: z.ZodType;
  execute(ctx: ToolContext, input: JsonObject): Promise<ToolResult>;
  reconcile?(ctx: ToolContext, input: JsonObject): Promise<Reconciliation>;
  verify(
    ctx: ToolContext,
    input: JsonObject,
    result: ToolResult,
  ): Promise<Verification>;
}
export interface Planner {
  kind: string;
  plan(
    request: string,
    tools: Pick<ToolDefinition, "id" | "description" | "effect">[],
  ): Promise<Plan>;
}

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export class OutcomeUnknownError extends Error {}
export class RetryableError extends Error {}
