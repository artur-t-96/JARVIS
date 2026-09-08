import { z } from "zod";
import type {
  JsonObject,
  Principal,
  ToolContext,
  StepEvidenceReceipt,
} from "./contracts.js";

export const laboratoryTarget = "jarvis-local-service" as const;
export const laboratoryTest = "jarvis.lab.http" as const;
export const laboratoryTlsTarget = "jarvis-local-tls" as const;
export const laboratoryTlsTest = "jarvis.lab.tls" as const;
export const laboratoryTargetSchema = z.enum([
  laboratoryTarget,
  laboratoryTlsTarget,
]);
export type LaboratoryTarget = z.infer<typeof laboratoryTargetSchema>;
export function laboratoryDefinition(target: LaboratoryTarget) {
  return target === laboratoryTlsTarget
    ? {
        targetId: target,
        title: "Certyfikat HTTPS laboratorium JARVIS",
        protocol: "HTTPS",
        procedureId: "lab.renewCertificate",
        procedureVersion: "1",
        inspectTool: "lab.inspectCertificate",
        failureTool: "lab.simulateCertificateFailure",
        testKey: laboratoryTlsTest,
      }
    : {
        targetId: target,
        title: "Usługa HTTP laboratorium JARVIS",
        protocol: "HTTP",
        procedureId: "lab.repairCase",
        procedureVersion: "1",
        inspectTool: "lab.inspect",
        failureTool: "lab.simulateFailure",
        testKey: laboratoryTest,
      };
}
export const laboratoryFreshnessMs = 5 * 60_000;
const httpScope = z
  .object({
    targetId: z.literal(laboratoryTarget),
    observationId: z.string().uuid(),
    observationHash: z.string().regex(/^[a-f0-9]{64}$/),
    procedureId: z.literal("lab.repairCase"),
    procedureVersion: z.literal("1"),
  })
  .strict();
export const laboratoryScopeSchema = z.discriminatedUnion("targetId", [
  httpScope,
  httpScope.extend({
    targetId: z.literal(laboratoryTlsTarget),
    procedureId: z.literal("lab.renewCertificate"),
  }),
]);
const httpCaseInput = z
  .object({
    caseId: z.string().uuid(),
    expectedCaseVersion: z.number().int().positive(),
    scopeRevision: z.number().int().positive(),
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    targetId: z.literal(laboratoryTarget),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();
export const laboratoryCaseInputSchema = z.discriminatedUnion("targetId", [
  httpCaseInput,
  httpCaseInput.extend({
    targetId: z.literal(laboratoryTlsTarget),
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

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
