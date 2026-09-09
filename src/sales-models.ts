import { z } from "zod";

const short = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2000);
const id = z.string().uuid();
const version = z.number().int().positive();
export const salesDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Niepoprawna data kalendarzowa");
const email = z.string().email().max(254).optional();
const base = { id, expectedVersion: version };
export const SALES_CONTRACT = "p10a1";
export const MAX_SALES_MINOR = 100_000_000_000;
export const offerLineSchema = z
  .object({
    label: short,
    unit: z.enum(["hour", "md", "month", "item", "fixed"]),
    quantityMilli: z.number().int().min(1).max(1_000_000_000),
    unitPriceMinor: z.number().int().min(0).max(MAX_SALES_MINOR),
  })
  .strict()
  .refine(
    (l) => l.unit !== "fixed" || l.quantityMilli === 1000,
    "Pozycja ryczałtowa ma ilość 1.",
  );
export const offerTermsSchema = z
  .object({
    scope: note,
    validUntil: salesDay,
    currency: z.enum(["PLN", "EUR", "USD"]),
    priceBasis: z.enum(["net", "gross"]),
    lines: z.array(offerLineSchema).min(1).max(40),
  })
  .strict();
export type OfferTerms = z.infer<typeof offerTermsSchema>;
export const offerSourcesInput = {
  expectedDealVersion: version,
  expectedClientVersion: version,
  expectedContactVersion: version,
};
export const salesCreateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("client"),
      organizationName: short,
      contactEmail: email,
    })
    .strict(),
  z
    .object({
      kind: z.literal("contact"),
      parentId: id,
      contactEmail: email,
      phone: short.optional(),
      jobTitle: short.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("deal"),
      parentId: id,
      organizationName: short.optional(),
      ownerPrincipalId: short.optional(),
      contactId: id.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("offer"),
      parentId: id,
      ...offerSourcesInput,
      terms: offerTermsSchema,
    })
    .strict(),
]);
const attestation = {
  evidenceReference: short,
  note,
  humanConfirmed: z.literal(true),
};
export const salesActions = {
  qualify: z.object({ ...base, qualification: note }).strict(),
  setDealContact: z
    .object({
      ...base,
      contactId: id,
      expectedContactVersion: version,
      reason: note,
    })
    .strict(),
  assignSalesOwner: z
    .object({ ...base, ownerPrincipalId: short, reason: note })
    .strict(),
  reviseOffer: z
    .object({
      ...base,
      ...offerSourcesInput,
      title: z.string().trim().min(1).max(160),
      terms: offerTermsSchema,
      reason: note,
    })
    .strict(),
  submitOffer: z.object(base).strict(),
  reviewOffer: z
    .object({
      ...base,
      decision: z.enum(["approved", "rejected"]),
      note,
      humanDecision: z.literal(true),
    })
    .strict(),
  recordDispatch: z
    .object({
      ...base,
      ...attestation,
      channel: z.enum(["email", "meeting", "portal", "other"]),
      dispatchedOn: salesDay,
    })
    .strict(),
  acceptOffer: z
    .object({
      ...base,
      acceptedOn: salesDay,
      acceptanceNote: note,
      evidenceReference: short,
      humanDecision: z.literal(true),
    })
    .strict(),
  declineOffer: z
    .object({ ...base, ...attestation, decidedOn: salesDay })
    .strict(),
  cancelOffer: z
    .object({ ...base, ...attestation, cancelledOn: salesDay })
    .strict(),
  scheduleNextStep: z
    .object({
      ...base,
      title: z.string().trim().min(1).max(160),
      description: note,
      ownerPrincipalId: short,
      dueDate: salesDay,
    })
    .strict(),
  acceptNextStep: z
    .object({ ...base, humanConfirmed: z.literal(true) })
    .strict(),
  declineNextStep: z
    .object({ ...base, reason: note, humanDecision: z.literal(true) })
    .strict(),
  completeNextStep: z
    .object({ ...base, ...attestation, completedOn: salesDay })
    .strict(),
  cancelNextStep: z
    .object({ ...base, reason: note, humanDecision: z.literal(true) })
    .strict(),
  handoff: z
    .object({ ...base, acceptanceCriteria: note, ownerId: id.optional() })
    .strict(),
  lose: z
    .object({ ...base, reason: note, humanDecision: z.literal(true) })
    .strict(),
};
export const salesActionNames: string[] = Object.keys(salesActions);

/** Deterministic line rounding: quantity is in thousandths, money in minor units.
 * ATLAS pricing concepts adapted at 33f0f6f5a152727036d413b9aed64a1626f67858;
 * no source price books, float multiplication or currency conversion. */
export function calculateOffer(raw: OfferTerms) {
  const terms = offerTermsSchema.parse(raw);
  const lines = terms.lines.map((l) => {
    const total =
      (BigInt(l.quantityMilli) * BigInt(l.unitPriceMinor) + 500n) / 1000n;
    if (total > BigInt(MAX_SALES_MINOR))
      throw new Error("Wartość pozycji przekracza limit oferty.");
    return { ...l, totalMinor: Number(total) };
  });
  const totalMinor = lines.reduce((sum, l) => sum + l.totalMinor, 0);
  if (totalMinor < 1 || totalMinor > MAX_SALES_MINOR)
    throw new Error(
      "Łączna wartość oferty musi być dodatnia i mieścić się w limicie.",
    );
  return {
    algorithm: SALES_CONTRACT,
    currency: terms.currency,
    priceBasis: terms.priceBasis,
    lines,
    totalMinor,
  };
}
