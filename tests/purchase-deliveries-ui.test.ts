import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
const { DeliverySummary } = await tsImport(
  "../web/src/PurchaseDeliveries.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
test("delivery summary distinguishes physical arrival, accepted units, unresolved damage and unproven historical quantities", () => {
  const html = renderToStaticMarkup(
    createElement(DeliverySummary, {
      view: {
        order: { data: { quantity: 4 } },
        totals: {
          physicalQuantity: 5,
          acceptedQuantity: 3,
          confirmedQuantity: 2,
          rejectedQuantity: 2,
          unresolvedQuantity: 1,
          unverifiedLegacyQuantity: 1,
          outstandingQuantity: 1,
        },
      },
    }),
  );
  assert.match(html, /Otrzymano fizycznie<\/dt><dd>5 szt/);
  assert.match(html, /Przyjęto zgodne<\/dt><dd>3 szt/);
  assert.match(html, /Pozostaje do przyjęcia<\/dt><dd>1 szt/);
  assert.match(html, /Odrzucone oczekujące zwrotu<\/dt><dd>1 szt/);
  assert.match(html, /Nie stanowi dowodu kompletnego przyjęcia/);
});
