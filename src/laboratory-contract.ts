import { z } from "zod";
import type {
  JsonObject,
  Principal,
  ToolContext,
  StepEvidenceReceipt,
} from "./contracts.js";

export const laboratoryTarget = "jarvis-local-service" as const;
export const laboratoryTest = "jarvis.lab.http" as const;
export const laboratoryFreshnessMs = 5 * 60_000;
export const laboratoryScopeSchema = z
  .object({
    targetId: z.literal(laboratoryTarget),
    observationId: z.string().uuid(),
    observationHash: z.string().regex(/^[a-f0-9]{64}$/),
    procedureId: z.literal("lab.repairCase"),
    procedureVersion: z.literal("1"),
  })
  .strict();
export const laboratoryCaseInputSchema = z
  .object({
    caseId: z.string().uuid(),
    expectedCaseVersion: z.number().int().positive(),
    scopeRevision: z.number().int().positive(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetId: z.literal(laboratoryTarget),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export interface LaboratoryCasePolicy {
  canAccess(principal: Principal, input: JsonObject): boolean;
  authorize(
    ctx: ToolContext,
    input: JsonObject,
    purpose: "execute" | "reconcile",
  ): void;
}
export type StepEvidenceReader = (
  tenantId: string,
  runId: string,
  stepId: string,
) => StepEvidenceReceipt | null;

export interface LaboratoryProofSource {
  title: string;
  version: number;
  revision: number | null;
  identity: JsonObject;
  hash: string;
}
export type LaboratoryProofReader = (
  tenant: string,
  id: string,
  caseId: string,
  revision: number,
  now: string,
) => LaboratoryProofSource;
