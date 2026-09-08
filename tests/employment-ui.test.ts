import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import {
  availableEmploymentPeriods,
  changeCommandField,
  employmentCaseOptions,
  employmentPersonId,
  requiresEmploymentPeriod,
  selectedEmploymentInput,
  type EmploymentPeriod,
} from "../web/src/employment-periods.js";
import type { Entity } from "../web/src/types.js";

const { EmploymentPeriodSelect } = await tsImport(
  "../web/src/EmploymentPeriodSelect.tsx",
  {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
  },
);
const episode = (
  overrides: Partial<EmploymentPeriod> = {},
): EmploymentPeriod => ({
  id: "private-period-a",
  personId: "private-person-a",
  version: 7,
  kind: "contractor",
  status: "onboarding",
  startDate: "2026-09-01",
  endDate: null,
  role: "Analityk",
  engagementRef: { module: "cases", id: "private-case-a" },
  engagementLabel: "Projekt Alfa",
  ...overrides,
});
const a = episode();
const b = episode({
  id: "private-period-b",
  version: 12,
  engagementLabel: "Projekt Beta",
  status: "active",
});
const record = (overrides: Partial<Entity> = {}): Entity => ({
  id: "private-person-a",
  module: "people",
  title: "Anna Testowa",
  status: "active",
  version: 4,
  data: {},
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

test("each employment-sensitive ERP action requires an explicit choice and derives the exact selected period version", () => {
  const actions = [
    ["people", "activate", "onboarding"],
    ["people", "beginOffboarding", "active"],
    ["people", "endEmployment", "offboarding"],
    ["assets", "reserve", "onboarding"],
    ["assets", "issue", "active"],
    ["licenses", "assign", "active"],
    ["licenses", "revoke", "offboarding"],
  ] as const;
  for (const [module, action, status] of actions) {
    const current = episode({ status });
    assert.equal(requiresEmploymentPeriod(module, action), true);
    assert.throws(
      () => selectedEmploymentInput(module, action, a.personId, "", [current]),
      /Wybierz aktualny okres/,
    );
    assert.deepEqual(
      selectedEmploymentInput(module, action, a.personId, a.id, [current]),
      { employmentEpisodeId: a.id, expectedEpisodeVersion: 7 },
    );
  }
  assert.deepEqual(
    selectedEmploymentInput("assets", "reserve", a.personId, b.id, [a, b]),
    { employmentEpisodeId: b.id, expectedEpisodeVersion: 12 },
  );
  assert.equal(requiresEmploymentPeriod("people", "startEmployment"), false);
});

test("a changed person, closed period or unavailable record cannot reuse a prior selection", () => {
  assert.throws(
    () =>
      selectedEmploymentInput("assets", "reserve", "different-person", a.id, [
        a,
      ]),
    /Wybierz aktualny okres/,
  );
  assert.throws(
    () =>
      selectedEmploymentInput("assets", "reserve", a.personId, a.id, [
        episode({ status: "ended" }),
      ]),
    /Wybierz aktualny okres/,
  );
  assert.throws(
    () => selectedEmploymentInput("people", "activate", b.personId, b.id, [b]),
    /Wybierz aktualny okres/,
  );
  assert.throws(
    () =>
      selectedEmploymentInput("licenses", "assign", a.personId, a.id, [
        episode({ version: 0 }),
      ]),
    /Wybierz aktualny okres/,
  );
  assert.deepEqual(
    availableEmploymentPeriods("people", "endEmployment", a.personId, [a, b]),
    [],
  );
  assert.equal(
    employmentPersonId("people", record(), { personId: "forged-other" }),
    a.personId,
  );
});

test("changing person or period clears dependent bindings and ignores a manually supplied version", () => {
  const values = {
    personId: a.personId,
    employmentEpisodeId: a.id,
    expectedEpisodeVersion: 999,
    caseId: "case-a",
    note: "Keep my note",
  };
  const nextPerson = changeCommandField(values, "personId", "person-b");
  assert.equal(nextPerson.employmentEpisodeId, "");
  assert.equal(nextPerson.caseId, "");
  assert.equal(nextPerson.expectedEpisodeVersion, undefined);
  assert.equal(nextPerson.note, values.note);
  const nextPeriod = changeCommandField(values, "employmentEpisodeId", b.id);
  assert.equal(nextPeriod.caseId, "");
  assert.equal(nextPeriod.expectedEpisodeVersion, undefined);
  assert.deepEqual(
    selectedEmploymentInput(
      "licenses",
      "assign",
      a.personId,
      nextPeriod.employmentEpisodeId,
      [a, b],
    ),
    { employmentEpisodeId: b.id, expectedEpisodeVersion: b.version },
  );
});

test("optional case choices only include the chosen person's exact period", () => {
  const caseRecord = record({
    id: "case-a",
    module: "cases",
    title: "Wdrożenie do Alfa",
    status: "open",
    data: { personId: a.personId, employmentEpisodeId: a.id },
  });
  assert.deepEqual(
    employmentCaseOptions(
      [
        caseRecord,
        {
          ...caseRecord,
          id: "other-period",
          data: { ...caseRecord.data, employmentEpisodeId: b.id },
        },
        {
          ...caseRecord,
          id: "other-person",
          data: { ...caseRecord.data, personId: "other" },
        },
        { ...caseRecord, id: "cancelled", status: "cancelled" },
      ],
      a.personId,
      a.id,
    ),
    [{ id: "case-a", label: "Wdrożenie do Alfa" }],
  );
});

function render(overrides: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(EmploymentPeriodSelect, {
      personId: a.personId,
      episodes: [a, b],
      selectedId: "",
      loading: false,
      error: "",
      disabled: false,
      onSelect() {},
      onRefresh() {},
      ...overrides,
    }),
  );
}
test("period UI renders readable project/state choices and never asks for UUID or version text fields", () => {
  const html = render();
  assert.match(html, /Projekt Alfa/);
  assert.match(html, /Projekt Beta/);
  assert.match(html, /Analityk/);
  assert.match(html, /Onboarding/);
  assert.match(html, /Aktywne/);
  assert.match(html, /Wybierz konkretną współpracę/);
  assert.doesNotMatch(html, /<input|expectedEpisodeVersion|Wersja okresu|UUID/);
  const visibleText = html.replace(/<[^>]*>/g, "");
  assert.doesNotMatch(
    visibleText,
    /private-period|private-person|private-case/,
  );
  const single = render({ episodes: [a] });
  assert.match(single, /<option value="" selected="">/);
});

test("loading, denied access and empty periods do not imply a valid available workflow", () => {
  const loading = render({ loading: true, episodes: [] });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /disabled=""/);
  assert.match(loading, /Pobieranie okresów/);
  const failed = render({ error: "Brak dostępu", episodes: [] });
  assert.match(failed, /role="alert">Brak dostępu/);
  assert.match(failed, /Odśwież okresy/);
  const missing = render({ personId: "", episodes: [] });
  assert.match(missing, /Najpierw wybierz osobę/);
  assert.match(render({ episodes: [] }), /Nie ma okresu w odpowiednim stanie/);
});

const policyUi = await tsImport("../web/src/EmploymentPolicyEditor.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
});
const profileUi = await tsImport("../web/src/Initiatives.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
});
const engagementUi = await tsImport("../web/src/EngagementSelect.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
});

test("project choices contain only agreed local offers, won deals or active delivery cases with readable labels", () => {
  const fixtures = [
    record({
      id: "offer",
      module: "sales",
      title: "Oferta Alfa",
      status: "accepted",
      data: { kind: "offer" },
    }),
    record({
      id: "handed",
      module: "sales",
      title: "Oferta przekazana",
      status: "handed_over",
      data: { kind: "offer" },
    }),
    record({
      id: "won",
      module: "sales",
      title: "Wygrany projekt",
      status: "won",
      data: { kind: "deal" },
    }),
    record({
      id: "delivery",
      module: "cases",
      title: "Realizacja Beta",
      status: "open",
      data: { caseType: "delivery" },
    }),
    record({
      id: "draft",
      module: "sales",
      title: "Niezatwierdzony szkic",
      status: "draft",
      data: { kind: "offer" },
    }),
    record({
      id: "lost",
      module: "sales",
      title: "Przegrana szansa",
      status: "lost",
      data: { kind: "deal" },
    }),
    record({
      id: "cancelled",
      module: "cases",
      title: "Anulowana realizacja",
      status: "cancelled",
      data: { caseType: "delivery" },
    }),
    record({
      id: "general",
      module: "cases",
      title: "Dowolna sprawa",
      status: "open",
      data: { caseType: "general" },
    }),
  ];
  const options = engagementUi.agreedEngagementOptions(fixtures);
  assert.deepEqual(
    options.map((option: { reference: { id: string } }) => option.reference.id),
    ["offer", "handed", "won", "delivery"],
  );
  assert.deepEqual(options[0].reference, { module: "sales", id: "offer" });
  assert.match(options[0].label, /Oferta Alfa · Zaakceptowana oferta/);
  assert.match(options[3].label, /Realizacja Beta · Realizacja/);
  const html = renderToStaticMarkup(
    createElement(engagementUi.EngagementSelect, {
      value: undefined,
      disabled: false,
      onSelect() {},
    }),
  );
  assert.match(html, /Uzgodniony projekt lub oferta/);
  assert.doesNotMatch(html, /<input|<textarea|JSON|UUID/);
});

test("structured employment policy editor preserves the chosen limit in the approved command and keeps internal overlap disabled", () => {
  const selected = policyUi.changeEmploymentMode(
    policyUi.safeEmploymentPolicy,
    "parallel_projects",
  );
  assert.deepEqual(selected, {
    mode: "parallel_projects",
    maxConcurrent: 2,
    allowInternalOverlap: false,
  });
  const profile = {
    companyName: "Firma A",
    timezone: "Europe/Warsaw",
    licenseReminderDays: 14,
    quietHours: { enabled: false, start: "20:00", end: "08:00" },
    rules: {},
    roleBindings: {},
    processTemplates: { onboarding: [], offboarding: [] },
    employmentPolicy: { ...selected, maxConcurrent: 6 },
  };
  const input = profileUi.companyProfileInput(profile, 8);
  assert.deepEqual(input.employmentPolicy, {
    mode: "parallel_projects",
    maxConcurrent: 6,
    allowInternalOverlap: false,
  });
  assert.equal(input.expectedVersion, 8);
  input.employmentPolicy.maxConcurrent = 12;
  assert.equal(
    profile.employmentPolicy.maxConcurrent,
    6,
    "preparation must not mutate the saved profile",
  );
  const single = policyUi.changeEmploymentMode(
    profile.employmentPolicy,
    "single_open",
  );
  assert.deepEqual(single, {
    mode: "single_open",
    maxConcurrent: 1,
    allowInternalOverlap: false,
  });
  const html = renderToStaticMarkup(
    createElement(policyUi.EmploymentPolicyEditor, {
      value: profile.employmentPolicy,
      disabled: false,
      onChange() {},
    }),
  );
  assert.match(html, /Równoległe projekty konsultanta/);
  assert.match(html, /type="number"[^>]*min="1"[^>]*max="20"/);
  assert.doesNotMatch(html, /<textarea|JSON|type="checkbox"/);
  const legacy = profileUi.companyProfileInput(
    { ...profile, employmentPolicy: undefined },
    2,
  );
  assert.deepEqual(legacy.employmentPolicy, policyUi.safeEmploymentPolicy);
});
