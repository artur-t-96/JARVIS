import { z } from "zod";

const short = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2000);
const count = z.number().int().min(0).max(100_000);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const date = new Date(v + "T00:00:00Z");
    return (
      Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v
    );
  }, "Niepoprawna data kalendarzowa");
export const equipmentType = z.enum([
  "laptop",
  "desktop",
  "phone",
  "monitor",
  "accessory",
  "other",
]);
const base = {
  id: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
};
export const deliveryActions = {
  recordDelivery: z
    .object({
      ...base,
      documentNumber: short,
      documentLine: z.number().int().positive().max(100_000),
      quantityReceived: count.refine((v) => v > 0, "Podaj otrzymaną ilość"),
      quantityAccepted: count,
      receivedOn: day,
      deliveryNote: note,
      rejectionReason: note.optional(),
      replacesLegacyQuantity: count.default(0),
      humanConfirmed: z.literal(true),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (
        v.quantityAccepted > v.quantityReceived ||
        v.replacesLegacyQuantity > v.quantityAccepted
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Przyjęta ilość i uzupełnienie historii nie mogą przekraczać otrzymanej ilości.",
        });
      if (v.quantityAccepted < v.quantityReceived && !v.rejectionReason)
        ctx.addIssue({
          code: "custom",
          message: "Podaj przyczynę odrzucenia części dostawy.",
        });
    }),
  returnRejectedDelivery: z
    .object({
      ...base,
      receiptId: z.string().uuid(),
      expectedReceiptVersion: z.number().int().positive(),
      returnedOn: day,
      returnReference: short,
      evidenceNote: note,
      humanConfirmed: z.literal(true),
    })
    .strict(),
  registerDeliveredAssets: z
    .object({
      ...base,
      receiptId: z.string().uuid(),
      expectedReceiptVersion: z.number().int().positive(),
      assets: z
        .array(
          z
            .object({
              title: z.string().trim().min(1).max(160),
              serial: short,
              assetType: equipmentType,
              location: short,
              manufacturer: short.optional(),
              model: short.optional(),
            })
            .strict(),
        )
        .min(1)
        .max(100),
      evidenceNote: note,
      humanConfirmed: z.literal(true),
    })
    .strict(),
};
export const deliveryActionNames = Object.keys(deliveryActions);
export const deliveryDocumentKey = (v: string) =>
  v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
export const equipmentSerialKey = (v: string) =>
  v.normalize("NFKC").trim().toLowerCase();
