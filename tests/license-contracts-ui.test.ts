import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
const { LicenseTerms, licenseMinor, licenseSidebarAction } = await tsImport(
  "../web/src/LicenseContracts.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
test("license terms show full-period cost, dates and distinct human authors without rounding away precision", () => {
  const html = renderToStaticMarkup(
    createElement(LicenseTerms, {
      record: {
        data: {
          terms: {
            agreementReference: "SYNTHETIC agreement",
            validFrom: "2026-09-01",
            expiresOn: "2027-08-31",
            totalSeats: 3,
            totalCostMinor: 12345,
            currency: "PLN",
            priceBasis: "gross",
            description: "Entire contractual period",
            ownerPrincipalId: "owner",
            renewalLeadDays: 45,
          },
          costDecision: {
            decision: "approved",
            actorId: "owner",
            approvedBy: "reviewer",
            at: "2026-09-08",
            note: "Cost approved",
          },
          confirmation: {
            actorId: "witness",
            approvedBy: "reviewer",
            confirmedOn: "2026-09-08",
            documentReference: "CONFIRM-1",
            line: 1,
            evidenceNote: "Evidence checked",
          },
        },
      },
    }),
  );
  assert.match(html, /Koszt całego okresu/);
  assert.match(html, /123,45/);
  assert.match(html, /brutto/);
  assert.match(html, /Poświadczył: witness/);
  assert.match(html, /Decyzja: zatwierdzona · owner/);
  assert.match(html, /CONFIRM-1/);
  assert.equal(licenseMinor("0,29"), 29);
  assert.equal(licenseMinor("1000000000.00"), 100000000000);
  assert.throws(() => licenseMinor("1.999"));
  assert.throws(() => licenseMinor("1e3"));
  assert.equal(
    licenseSidebarAction({ data: { contractWorkflowVersion: 1 } }, "renew"),
    false,
  );
  assert.equal(
    licenseSidebarAction({ data: { kind: "license_terms" } }, "assign"),
    false,
  );
});
