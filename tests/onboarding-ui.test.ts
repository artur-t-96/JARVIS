import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { onboardingStage, type OnboardingOverview } from "../src/onboarding.js";

const { OnboardingCard } = await tsImport("../web/src/Onboarding.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
});
const overview: OnboardingOverview = {
  evaluatedAt: "2026-09-08T10:00:00Z",
  today: "2026-09-08",
  timezone: "Europe/Warsaw",
  case: {
    id: "case-private-id",
    version: 7,
    status: "open",
    scopeRevision: 2,
    ownerPrincipalId: "manager",
    profileVersion: 3,
  },
  person: { id: "person-private-id", title: "Anna Syntetyczna" },
  episode: {
    id: "episode-private-id",
    version: 1,
    kind: "contractor",
    status: "onboarding",
    startDate: "2026-09-09",
    role: "Analityk",
  },
  engagement: {
    id: "project-private-id",
    module: "cases",
    title: "Projekt Alfa",
  },
  engagementUnavailable: false,
  ready: false,
  acceptanceCurrent: false,
  stage: onboardingStage({
    caseStatus: "open",
    episodeStatus: "onboarding",
    startDate: "2026-09-09",
    today: "2026-09-08",
    ready: false,
    acceptanceCurrent: false,
  }),
  tasks: [
    {
      id: "task-private-id",
      title: "Potwierdź wymagane dostępy",
      status: "offered",
      required: true,
      assigneePrincipalId: "it-one",
      assigneeRole: "it",
      dueDate: "2026-09-07",
      overdue: true,
      waitingFor: ["Potwierdź dokumenty"],
    },
  ],
};
test("onboarding summary exposes readable project, deadlines and dependencies without premature activation", () => {
  const html = renderToStaticMarkup(
    createElement(OnboardingCard, { overview, onPrepare() {} }),
  );
  for (const label of [
    "Anna Syntetyczna",
    "Projekt Alfa",
    "Konsultant klienta",
    "Analityk",
    "Właściciel odbioru",
    "it-one",
    "po terminie",
    "Najpierw:",
    "Potwierdź dokumenty",
  ])
    assert.ok(html.includes(label), label);
  assert.ok(!html.includes("Potwierdź rozpoczęcie"));
  assert.ok(!html.includes("private-id"));
  assert.ok(!html.includes("Gotowe do oceny"));
});
test("an active employment with stale evidence remains historical activation, while revoked preparation cannot offer a command", () => {
  const stage = onboardingStage({
    caseStatus: "accepted",
    episodeStatus: "active",
    startDate: "2026-09-01",
    today: "2026-09-08",
    ready: false,
    acceptanceCurrent: false,
  });
  const html = renderToStaticMarkup(
    createElement(OnboardingCard, {
      overview: { ...overview, stage },
      onPrepare() {},
    }),
  );
  assert.match(html, /Współpraca aktywna/);
  assert.match(html, /ponownego sprawdzenia/);
  assert.ok(!html.includes("Potwierdź rozpoczęcie"));
  const cancelled = onboardingStage({
    caseStatus: "cancelled",
    episodeStatus: "onboarding",
    startDate: "2026-09-09",
    today: "2026-09-08",
    ready: false,
    acceptanceCurrent: false,
  });
  assert.equal(cancelled.action, undefined);
  assert.match(cancelled.next, /nie zamknęło okresu/);
});
