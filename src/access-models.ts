import { z } from "zod";

export const accessKeySchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/);
export const accessRoleSchema = z.string().trim().min(1).max(120);
export const accessMemberSchema = z
  .object({
    key: accessKeySchema,
    applicationId: z.string().uuid(),
    applicationVersion: z.number().int().positive(),
    role: accessRoleSchema,
    validityDays: z.number().int().min(1).max(365),
    licenseId: z.string().uuid().optional(),
  })
  .strict();
export const accessMembersSchema = z
  .array(accessMemberSchema)
  .min(1)
  .max(30)
  .superRefine((members, ctx) => {
    if (
      new Set(members.map((m) => m.key)).size !== members.length ||
      new Set(members.map((m) => `${m.applicationId}:${m.role}`)).size !==
        members.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Pozycje zestawu i pary aplikacja/rola muszą być unikalne.",
      });
  });
export const applicationDataSchema = z
  .object({
    kind: z.literal("application"),
    description: z.string().trim().min(1).max(10_000),
    applicationKey: accessKeySchema,
    supportedRoles: z
      .array(accessRoleSchema)
      .min(1)
      .max(50)
      .refine(
        (roles) => new Set(roles).size === roles.length,
        "Role nie mogą się powtarzać.",
      ),
  })
  .strict();
export const accessBundleDataSchema = z
  .object({
    kind: z.literal("access_bundle"),
    description: z.string().trim().min(1).max(10_000),
    accessKey: accessKeySchema,
    members: accessMembersSchema,
  })
  .strict();
export type AccessMember = z.infer<typeof accessMemberSchema>;

export const accessBindingFields = {
  requirementId: z.string().uuid(),
  memberKey: accessKeySchema,
  personId: z.string().uuid().optional(),
  employmentEpisodeId: z.string().uuid().optional(),
  expectedEpisodeVersion: z.number().int().positive().optional(),
  scopeRevision: z.number().int().positive().optional(),
  bundleId: z.string().uuid().optional(),
  bundleVersion: z.number().int().positive().optional(),
  applicationId: z.string().uuid().optional(),
  applicationVersion: z.number().int().positive().optional(),
  profileVersion: z.number().int().min(0).optional(),
  licenseSeatId: z.string().uuid().optional(),
  licenseVersion: z.number().int().positive().optional(),
};
export const accessAttestationFields = {
  accountRef: z.string().trim().min(1).max(200),
  observedOn: z.iso.date(),
  validUntil: z.iso.date(),
  verificationMethod: z.string().trim().min(1).max(2000),
  note: z.string().trim().min(1).max(4000),
  humanConfirmed: z.literal(true),
};
export interface AccessGrant {
  id: string;
  version: number;
  applicationId: string;
  applicationVersion: number;
  personId: string;
  employmentEpisodeId: string;
  caseId: string;
  scopeRevision: number;
  requirementId: string;
  bundleId: string;
  bundleVersion: number;
  memberKey: string;
  role: string;
  accountRef: string;
  licenseSeatId: string | null;
  status: "active" | "revoked";
  observedOn: string;
  validUntil: string;
  expiresAt: string;
  timezone: string;
  profileVersion: number;
  verificationMethod: string;
  note: string;
  performedBy: string;
  approvedBy: string | null;
  recordedAt: string;
  revokedOn: string | null;
  lastEventId: string;
}
export interface AccessEvent {
  id: string;
  grantId: string;
  grantVersion: number;
  kind: "attest" | "renew" | "revoke";
  snapshot: AccessGrant;
  snapshotHash: string;
  previousHash: string | null;
  requestedBy: string;
  approvedBy: string | null;
  performedBy: string;
  runId: string;
  stepId: string;
  operationKey: string;
  recordedAt: string;
}
