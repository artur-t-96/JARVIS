import { z } from "zod";

const short = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2000);
const id = z.string().uuid();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Niepoprawna data kalendarzowa");
const base = { id, expectedVersion: z.number().int().positive() };
export const licenseTermsSchema = z
  .object({
    supplierId: id,
    supplierVersion: z.number().int().positive(),
    agreementReference: short,
    ownerPrincipalId: short,
    validFrom: day,
    expiresOn: day,
    totalSeats: z.number().int().min(1).max(100_000),
    totalCostMinor: z.number().int().min(0).max(100_000_000_000),
    currency: z.enum(["PLN", "EUR", "USD"]),
    priceBasis: z.enum(["net", "gross"]),
    renewalLeadDays: z.number().int().min(0).max(365),
    description: note,
  })
  .strict()
  .refine(
    (t) => t.validFrom <= t.expiresOn,
    "Koniec okresu poprzedza jego początek.",
  );
export type LicenseTerms = z.infer<typeof licenseTermsSchema>;
export const licenseContractActions = {
  proposeTerms: z.object({ ...base, terms: licenseTermsSchema }).strict(),
  reviseTerms: z
    .object({ ...base, terms: licenseTermsSchema, reason: note })
    .strict(),
  decideTerms: z
    .object({
      ...base,
      decision: z.enum(["approved", "rejected"]),
      note,
      humanDecision: z.literal(true),
    })
    .strict(),
  cancelTerms: z.object({ ...base, reason: note }).strict(),
  confirmTerms: z
    .object({
      ...base,
      costDecisionHash: z.string().regex(/^[a-f0-9]{64}$/),
      confirmationReference: short,
      confirmationLine: z.number().int().min(1).max(100_000),
      confirmedOn: day,
      evidenceNote: note,
      humanConfirmed: z.literal(true),
    })
    .strict(),
  assignOwner: z
    .object({ ...base, ownerPrincipalId: short, reason: note })
    .strict(),
};
export const licenseContractActionNames: string[] = Object.keys(
  licenseContractActions,
);
