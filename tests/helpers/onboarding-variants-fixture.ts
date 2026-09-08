import type { JsonObject } from "../../src/contracts.js";
import {
  baselineOnboardingVariant,
  type OnboardingVariants,
} from "../../src/onboarding-profile.js";
import type { CustodyFixture } from "./custody-fixture.js";

export const variants = (): OnboardingVariants => ({
  internal: baselineOnboardingVariant("internal"),
  contractor: baselineOnboardingVariant("contractor"),
});
export function profileInput(
  f: CustodyFixture,
  tenant = "synthetic-a",
  overrides: JsonObject = {},
): JsonObject {
  const p = f.initiatives.profile(f.actor("manager", tenant));
  return {
    expectedVersion: p.version,
    companyName: `Synthetic variants ${tenant}`,
    timezone: p.timezone,
    licenseReminderDays: p.licenseReminderDays,
    quietHours: p.quietHours,
    rules: p.rules,
    processTemplates: p.processTemplates,
    roleBindings: { hr: "manager", it: "it-one", manager: "manager" },
    employmentPolicy: {
      mode: "parallel_projects",
      maxConcurrent: 3,
      allowInternalOverlap: false,
    },
    ...(p.onboardingVariants
      ? { onboardingVariants: p.onboardingVariants }
      : {}),
    ...overrides,
  } as unknown as JsonObject;
}
export async function configureVariants(
  f: CustodyFixture,
  value = variants(),
  tenant = "synthetic-a",
) {
  return f.complete(
    "initiatives.configure",
    profileInput(f, tenant, {
      onboardingVariants: value as unknown as JsonObject,
    }),
    "manager",
    tenant,
  );
}
export async function startVariant(
  f: CustodyFixture,
  kind: "internal" | "contractor",
  tenant = "synthetic-a",
) {
  const create = async (module: string, title: string, data: JsonObject) =>
    String(
      (
        await f.complete(
          `ops.${module}.create`,
          { title, data },
          "manager",
          tenant,
        )
      ).steps[0]!.output!.data.entityId,
    );
  const personId = await create("people", `Synthetic ${kind}`, {
    personCategory: kind,
  });
  const projectId =
    kind === "contractor"
      ? await create("cases", "Synthetic project", {
          caseType: "delivery",
          brief: "Synthetic project only",
          acceptanceCriteria: "Synthetic criteria",
        })
      : undefined;
  const input = {
    id: personId,
    expectedVersion: 1,
    employmentKind: kind,
    startDate: "2026-09-08",
    role: "Synthetic role",
    humanDecision: true,
    ...(projectId ? { engagementRef: { module: "cases", id: projectId } } : {}),
  } as JsonObject;
  const run = await f.complete(
    "ops.people.startEmployment",
    input,
    "manager",
    tenant,
  );
  const episode = f.workspace.listEmploymentEpisodes(
    f.actor("manager", tenant),
    personId,
  )[0]!;
  return {
    personId,
    projectId,
    input,
    run,
    episode,
    caseId: episode.onboardingCaseId!,
  };
}
