import assert from "node:assert/strict";
import test from "node:test";
import { calculateOffer, type OfferTerms } from "../src/sales-models.js";

test("offer quote uses minor units, explicit units and line rounding without mixing tax bases", () => {
  const terms: OfferTerms = {
    scope: "Projekt",
    validUntil: "2026-10-01",
    currency: "EUR",
    priceBasis: "gross",
    lines: [
      {
        label: "Analiza",
        unit: "md",
        quantityMilli: 125,
        unitPriceMinor: 12345,
      },
      {
        label: "Utrzymanie",
        unit: "month",
        quantityMilli: 3000,
        unitPriceMinor: 1010,
      },
      {
        label: "Uruchomienie",
        unit: "fixed",
        quantityMilli: 1000,
        unitPriceMinor: 9999,
      },
    ],
  };
  const q = calculateOffer(terms);
  assert.equal(q.totalMinor, 14572);
  assert.equal(q.lines[0]!.totalMinor, 1543);
  assert.equal(q.lines[0]!.unit, "md");
  assert.equal(q.priceBasis, "gross");
  assert.equal(q.currency, "EUR");
  assert.deepEqual(
    calculateOffer({ ...terms, priceBasis: "net" }).lines,
    q.lines,
  );
});
test("offer rounding, overflow, zero value and invalid units are rejected deterministically", () => {
  const terms: OfferTerms = {
    scope: "Projekt",
    validUntil: "2026-10-01",
    currency: "PLN",
    priceBasis: "net",
    lines: [
      { label: "Czas", unit: "hour", quantityMilli: 500, unitPriceMinor: 1 },
    ],
  };
  assert.equal(calculateOffer(terms).totalMinor, 1);
  assert.throws(() =>
    calculateOffer({
      ...terms,
      lines: [{ ...terms.lines[0]!, quantityMilli: 1 }],
    }),
  );
  assert.throws(() =>
    calculateOffer({
      ...terms,
      lines: [
        {
          ...terms.lines[0]!,
          unitPriceMinor: 100_000_000_000,
          quantityMilli: 1001,
        },
      ],
    }),
  );
  assert.throws(() =>
    calculateOffer({
      ...terms,
      lines: [{ ...terms.lines[0]!, unit: "fixed" }],
    }),
  );
  assert.throws(() => calculateOffer({ ...terms, validUntil: "2026-02-30" }));
  assert.throws(() =>
    calculateOffer({ ...terms, lines: Array(41).fill(terms.lines[0]) }),
  );
});
