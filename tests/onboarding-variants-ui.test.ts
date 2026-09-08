import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { baselineOnboardingVariant } from "../src/onboarding-profile.js";
import { baselineProcessTemplates } from "../src/workspace-models.js";
const options = {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
};
const ui = await tsImport("../web/src/Initiatives.tsx", options);
const variantUi = await tsImport("../web/src/OnboardingVariants.tsx", options);
const profile = {
  tenantId: "synthetic-a",
  version: 3,
  companyName: "Synthetic company",
  timezone: "Europe/Warsaw",
  licenseReminderDays: 30,
  quietHours: { enabled: false, start: "20:00", end: "08:00" },
  rules: { overdue_case: true },
  processTemplates: baselineProcessTemplates("internal"),
  updatedAt: null,
  updatedBy: null,
};
const templates = (["internal", "contractor"] as const).map((id) => ({
  id,
  label: id,
  processTemplates: baselineProcessTemplates(id),
  onboardingVariant: baselineOnboardingVariant(id),
}));
test("loading two variants is an explicit draft; changing one variant preserves the other, offboarding, rules and serialized pins", () => {
  const before = structuredClone(profile);
  const draft = ui.applyOnboardingBaselines(profile, templates);
  assert.deepEqual(profile, before);
  assert.deepEqual(draft.processTemplates, before.processTemplates);
  draft.onboardingVariants.internal.requirements[1].expected.fileRequired = true;
  const changed = ui.applyCompanyTemplate(draft, templates[1]);
  assert.deepEqual(
    changed.onboardingVariants.internal,
    draft.onboardingVariants.internal,
  );
  const input = ui.companyProfileInput(changed, 3);
  assert.deepEqual(input.onboardingVariants, changed.onboardingVariants);
  assert.deepEqual(input.processTemplates, profile.processTemplates);
  assert.equal("tenantId" in input, false);
  assert.equal("updatedBy" in input, false);
  input.onboardingVariants.contractor.tasks[0].title = "Changed copy";
  assert.notEqual(
    changed.onboardingVariants.contractor.tasks[0].title,
    "Changed copy",
  );
});
test("variant summary and editor explain both kinds, mandatory original and missing access bundle without claiming readiness", () => {
  const draft = ui.applyOnboardingBaselines(profile, templates);
  draft.onboardingVariants.internal.requirements[1].expected.fileRequired = true;
  const html = renderToStaticMarkup(
    createElement(variantUi.OnboardingVariantsSummary, {
      variants: draft.onboardingVariants,
    }),
  );
  assert.match(html, /Pracownik wewnętrzny/);
  assert.match(html, /Konsultant klienta/);
  assert.match(html, /oryginał pliku/);
  assert.match(html, /zestaw do wskazania w sprawie/);
  const editor = renderToStaticMarkup(
    createElement(variantUi.OnboardingVariantsEditor, {
      variants: draft.onboardingVariants,
      onChange: () => {},
      canReadIT: false,
      busy: false,
    }),
  );
  assert.match(editor, /Konfiguracja onboardingu/);
  assert.match(editor, /Wymagany oryginał pliku/);
  assert.match(editor, /wymaga obszaru IT/);
});
