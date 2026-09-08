import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { onboardingStage } from "../src/onboarding.js";
const { StartCancellationSummary, StartCancellationDecision } = await tsImport(
  "../web/src/StartCancellation.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
const overview = {
  person: { title: "Anna Syntetyczna" },
  episode: { kind: "contractor", startDate: "2026-09-10" },
  engagement: { title: "Projekt Alfa" },
  cancellation: {
    ready: false,
    resourceHash: "private-resource-hash",
    blockers: [
      {
        kind: "equipment",
        title: "Laptop do zwrotu",
        next: "Potwierdź rzeczywisty zwrot wydanego sprzętu.",
      },
      {
        kind: "access",
        title: "Dostęp wymagający cofnięcia",
        next: "Upływ ważności obserwacji nie dowodzi odebrania uprawnień.",
      },
    ],
  },
};
test("cancellation explains outstanding resources and requires an explicit statement that work never started", () => {
  const blocked = renderToStaticMarkup(
    createElement(StartCancellationSummary, { overview, onPrepare() {} }),
  );
  assert.match(blocked, /Najpierw rozlicz zasoby/);
  assert.match(blocked, /Laptop do zwrotu/);
  assert.match(blocked, /Upływ ważności obserwacji/);
  assert.ok(!blocked.includes("Przygotuj anulowanie rozpoczęcia"));
  assert.ok(!blocked.includes("private-resource-hash"));
  const ready = {
    ...overview,
    cancellation: {
      ready: true,
      resourceHash: "private-resource-hash",
      blockers: [],
      command: { toolId: "ops.people.cancelStart", input: {} },
    },
  };
  const html = renderToStaticMarkup(
    createElement(StartCancellationSummary, {
      overview: ready,
      onPrepare() {},
    }),
  );
  assert.match(html, /Przygotuj anulowanie rozpoczęcia/);
  const form = renderToStaticMarkup(
    createElement(StartCancellationDecision, { overview: ready, onClose() {} }),
  );
  assert.match(form, /Powód anulowania/);
  assert.match(form, /Potwierdzam, że ta współpraca nie została rozpoczęta/);
  assert.match(form, /Projekt Alfa/);
  assert.match(form, /disabled=""/);
  const stage = onboardingStage({
    caseStatus: "cancelled",
    episodeStatus: "cancelled",
    startDate: "2026-09-10",
    today: "2026-09-08",
    ready: false,
    acceptanceCurrent: false,
  });
  assert.match(stage.title, /Rozpoczęcie współpracy anulowane/);
  assert.equal(stage.action, undefined);
  assert.ok(!stage.next.includes("nie zamknęło okresu"));
  const history = renderToStaticMarkup(
    createElement(StartCancellationSummary, {
      overview: {
        ...overview,
        cancellationDecision: {
          at: "2026-09-08T10:00:00Z",
          reason: "Zmienione plany startu",
          requestedBy: "manager",
          approvedBy: "reviewer",
        },
      },
    }),
  );
  assert.match(history, /Zmienione plany startu/);
  assert.match(history, /manager/);
  assert.match(history, /reviewer/);
  assert.ok(!history.includes("Przygotuj anulowanie"));
});
