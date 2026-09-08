import { z } from "zod";
import {
  baselineProcessTemplates,
  processTemplateSchema,
} from "./workspace-models.js";
import {
  caseRequirementDefinitionsSchema,
  onboardingRequirements,
} from "./case-readiness.js";

/** Company rules contain types and a versioned access bundle, never personal evidence. */
export const onboardingVariantSchema = z
  .object({
    tasks: processTemplateSchema,
    requirements: caseRequirementDefinitionsSchema,
  })
  .strict()
  .superRefine((variant, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    for (const kind of ["asset_issued", "document_approved", "access_attested"])
      if (!variant.requirements.some((r) => r.kind === kind && r.required))
        issue("Onboarding wymaga sprzętu, dokumentu i dostępu.", [
          "requirements",
        ]);
    const keys = new Set(variant.requirements.map((r) => r.key));
    for (const [index, task] of variant.tasks.entries())
      if (task.requirementKeys.some((key) => !keys.has(key)))
        issue("Zadanie wskazuje nieistniejący warunek odbioru.", [
          "tasks",
          index,
          "requirementKeys",
        ]);
    for (const [index, requirement] of variant.requirements.entries()) {
      if (
        !["asset_issued", "document_approved", "access_attested"].includes(
          requirement.kind,
        )
      )
        issue("Wariant onboardingu obsługuje dokumenty, sprzęt i dostępy.", [
          "requirements",
          index,
        ]);
      if (
        Object.keys(requirement.expected).some((key) =>
          ["assetId", "documentId", "documentRevision", "contentHash"].includes(
            key,
          ),
        )
      )
        issue(
          "Profil określa rodzaj dowodu. Konkretny dokument lub sprzęt przypisz w sprawie.",
          ["requirements", index, "expected"],
        );
      const role = requirement.kind === "document_approved" ? "hr" : "it";
      if (
        requirement.required &&
        !variant.tasks.some(
          (t) =>
            t.required &&
            t.assigneeRole === role &&
            t.requirementKeys.includes(requirement.key),
        )
      )
        issue(
          "Obowiązkowy warunek potrzebuje wymaganego zadania właściwej roli HR lub IT.",
          ["requirements", index],
        );
    }
  });
export const onboardingVariantsSchema = z
  .object({
    internal: onboardingVariantSchema,
    contractor: onboardingVariantSchema,
  })
  .strict();
export type OnboardingVariant = z.infer<typeof onboardingVariantSchema>;
export type OnboardingVariants = z.infer<typeof onboardingVariantsSchema>;

export function baselineOnboardingVariant(
  kind: "internal" | "contractor",
): OnboardingVariant {
  return {
    tasks: baselineProcessTemplates(kind).onboarding,
    requirements: onboardingRequirements(kind),
  };
}
