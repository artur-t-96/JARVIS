import { z } from "zod";
const short = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2000);
const id = z.string().uuid();
const version = z.number().int().positive();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Niepoprawna data kalendarzowa");
export const stocktakePinsSchema = z
  .array(z.object({ id, expectedVersion: version }).strict())
  .min(1)
  .max(200)
  .refine(
    (pins) => new Set(pins.map((p) => p.id)).size === pins.length,
    "Urządzenie występuje więcej niż raz.",
  );
export const stocktakeCreateSchema = z
  .object({
    ownerPrincipalId: short,
    dueDate: day,
    note,
    profileVersion: z.number().int().nonnegative(),
    assetPins: stocktakePinsSchema,
  })
  .strict();
const base = { id, expectedVersion: version };
export const stocktakeActions = {
  reviseStocktake: z
    .object({ ...base, assetPins: stocktakePinsSchema, reason: note })
    .strict(),
  recordObservation: z
    .object({
      ...base,
      assetId: id,
      expectedAssetVersion: version,
      present: z.boolean(),
      location: short.optional(),
      condition: z.enum(["good", "repair"]).optional(),
      observedOn: day,
      note,
      humanConfirmed: z.literal(true),
    })
    .strict()
    .refine(
      (v) =>
        v.present
          ? Boolean(v.location && v.condition)
          : v.location === undefined && v.condition === undefined,
      "Dla znalezionego sprzętu podaj lokalizację i stan; przy braku nie zgaduj tych danych.",
    ),
  resolveDiscrepancy: z
    .object({
      ...base,
      assetId: id,
      expectedAssetVersion: version,
      observationId: id,
      observationHash: z.string().regex(/^[a-f0-9]{64}$/),
      reason: note,
      humanDecision: z.literal(true),
    })
    .strict(),
  assignStocktakeOwner: z
    .object({ ...base, ownerPrincipalId: short, dueDate: day, reason: note })
    .strict(),
  acceptStocktake: z
    .object({
      ...base,
      reportHash: z.string().regex(/^[a-f0-9]{64}$/),
      note,
      humanDecision: z.literal(true),
    })
    .strict(),
  cancelStocktake: z.object({ ...base, reason: note }).strict(),
};
export type StocktakeCreate = z.infer<typeof stocktakeCreateSchema>;
