import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { purchasingFixture } from "./helpers/purchasing-fixture.js";
import { custodyNow } from "./helpers/custody-fixture.js";
const { PurchaseComparison, purchaseMoney } = await tsImport(
  "../web/src/Purchasing.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
test("offer comparison renders full price basis and blocks stale or incomparable choices without inventing prices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-purchase-ui-"));
  let now = custodyNow;
  const f = purchasingFixture(dir, { domainClock: () => now });
  try {
    const { request, quote, supplier } = await f.seedPurchase();
    const html = () =>
      renderToStaticMarkup(
        createElement(PurchaseComparison, {
          view: f.view(request.id),
          onSelect() {},
        }),
      );
    assert.match(html(), /brutto/);
    assert.match(html(), /8.?100,00/);
    assert.doesNotMatch(html(), /disabled/);
    await f.create(
      "Incomparable",
      f.quotation(request.id, supplier.id, "synthetic-a", { currency: "EUR" }),
    );
    assert.match(html(), /brak porównywalności/);
    assert.match(html(), /disabled/);
    now = Date.parse("2026-10-01T10:00:00Z");
    assert.match(html(), /Oferta wygasła/);
    assert.equal(purchaseMoney(undefined, "PLN"), "Brak kwoty");
    assert.equal(
      f.view(request.id).quotes.find((x) => x.quote.id === quote.id)!.eligible,
      false,
    );
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
