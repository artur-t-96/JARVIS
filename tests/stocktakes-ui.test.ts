import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
const { StocktakeLines } = await tsImport("../web/src/Stocktakes.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
});
test("inventory view separates register versions, missing observations and unresolved findings from a completed check", () => {
  const asset = {
    id: "a",
    title: "SYNTHETIC laptop",
    serial: "SYNTHETIC-1",
    version: 1,
    location: "REGISTER_LOCATION",
    condition: "good",
  };
  const line = {
    baseline: asset,
    current: { ...asset, version: 2, location: "CURRENT_LOCATION" },
    observation: {
      id: "o",
      present: false,
      observedOn: "2026-09-08",
      note: "SYNTHETIC_MISSING_NOTE",
      actorId: "witness",
      runId: "r",
    },
    discrepancy: { id: "d", reasons: ["Missing device remains unresolved"] },
    stale: true,
    ready: false,
    resolution: null,
  };
  const html = renderToStaticMarkup(
    createElement(StocktakeLines, {
      report: {
        record: { status: "cancelled" },
        lines: [line],
        ownerPrincipalId: "owner",
        dueDate: "2026-09-10",
      },
      onAction: () => {},
      isOwner: true,
      allowed: true,
    }),
  );
  for (const text of [
    "REGISTER_LOCATION",
    "CURRENT_LOCATION",
    "Nie odnaleziono urządzenia",
    "witness",
    "SYNTHETIC_MISSING_NOTE",
    "Niewyjaśniona rozbieżność",
    "owner",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /disabled=""[^>]*>Wyjaśnij rozbieżność/);
  assert.doesNotMatch(html, /Obserwacja zgodna/);
  assert.match(html, /Zapisz obserwację/);
  const unobserved = renderToStaticMarkup(
    createElement(StocktakeLines, {
      report: {
        record: { status: "open" },
        lines: [
          { ...line, observation: null, discrepancy: null, stale: false },
        ],
      },
      onAction: () => {},
      isOwner: false,
      allowed: false,
    }),
  );
  assert.match(unobserved, /Nie sprawdzono/);
  assert.doesNotMatch(unobserved, /Zapisz obserwację/);
});
