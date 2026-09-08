import { z } from "zod";

const short = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const id = z.string().uuid();
const version = z.number().int().positive();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value + "T00:00:00Z");
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Niepoprawna data kalendarzowa");
export const purchaseCurrency = z.enum(["PLN", "EUR", "USD"]);
export const priceBasis = z.enum(["net", "gross"]);
export const purchaseMinor = z.number().int().min(0).max(100_000_000_000);
const quantity = z.number().int().positive().max(100_000);
const equipment = z.enum([
  "laptop",
  "desktop",
  "phone",
  "monitor",
  "accessory",
  "other",
]);
export const requestFields = {
  description: text,
  quantity,
  budgetMinor: purchaseMinor,
  currency: purchaseCurrency,
  priceBasis,
  requiredBy: day,
  assetType: equipment.optional(),
};
const caseLink = {
  caseId: id.optional(),
  caseScopeRevision: version.optional(),
  caseRequirementId: id.optional(),
};
export const quotationFields = {
  supplierId: id,
  expectedSupplierVersion: version,
  quoteReference: short,
  description: text,
  quantity,
  unitPriceMinor: purchaseMinor,
  shippingMinor: purchaseMinor,
  currency: purchaseCurrency,
  priceBasis,
  validUntil: day,
  expectedDelivery: day,
  terms: text,
};
export const purchaseCreateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("supplier"),
      description: text,
      supplierEmail: z.string().email().max(254).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal("request"), ...requestFields, ...caseLink })
    .strict()
    .refine(
      (v) =>
        !!v.caseId === !!v.caseScopeRevision &&
        (!v.caseRequirementId || !!v.caseId),
      "Powiązanie wymaga sprawy i jej rewizji.",
    ),
  z
    .object({
      kind: z.literal("quote"),
      requestId: id,
      expectedRequestVersion: version,
      ...quotationFields,
    })
    .strict(),
]);
const base = { id, expectedVersion: version };
export const purchasingActions = {
  reviseRequest: z
    .object({
      ...base,
      ...requestFields,
      caseScopeRevision: version.optional(),
      reason: text,
    })
    .strict(),
  reviseQuote: z
    .object({
      ...base,
      expectedRequestVersion: version,
      ...quotationFields,
      reason: text,
    })
    .strict(),
  withdrawQuote: z
    .object({ ...base, expectedRequestVersion: version, reason: text })
    .strict(),
  selectQuote: z
    .object({
      ...base,
      quoteId: id,
      expectedQuoteVersion: version,
      selectionReason: text,
    })
    .strict(),
  decideCost: z
    .object({
      ...base,
      quoteId: id,
      expectedQuoteVersion: version,
      decision: z.enum(["approved", "rejected"]),
      note: text,
      humanDecision: z.literal(true),
    })
    .strict(),
  placeOrder: z
    .object({
      ...base,
      costDecisionHash: z.string().regex(/^[a-f0-9]{64}$/),
      expectedSupplierVersion: version,
    })
    .strict(),
};
export const purchasingActionNames = Object.keys(purchasingActions);
export type PurchaseCreate = z.infer<typeof purchaseCreateSchema>;
