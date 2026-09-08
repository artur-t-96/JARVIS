import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";

const options = {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
};
const { ReadinessCard } = await tsImport(
  "../web/src/CaseReadiness.tsx",
  options,
);
const { HumanTaskCard, taskCommand } = await tsImport(
  "../web/src/HumanTasks.tsx",
  options,
);
const { applyCompanyTemplate, companyProfileInput } = await tsImport(
  "../web/src/Initiatives.tsx",
  options,
);
const { baselineProcessTemplates } = await import("../src/workspace-models.js");
const { isHumanTaskOperation } = await tsImport(
  "../web/src/RunPage.tsx",
  options,
);

test("human task results lead back to the narrow task view rather than a full HR case", () => {
  for (const action of [
    "acceptTask",
    "declineTask",
    "transferTask",
    "completeTask",
    "cancelTask",
  ])
    assert.equal(isHumanTaskOperation(`ops.cases.${action}`), true);
  assert.equal(isHumanTaskOperation("ops.cases.bindEvidence"), false);
  assert.equal(isHumanTaskOperation("ops.cases.notARealTask"), false);
});

test("case readiness renders unmet typed evidence and its next action without implying business acceptance", () => {
  const html = renderToStaticMarkup(
    createElement(ReadinessCard, {
      readiness: {
        caseId: "case",
        scopeRevision: 3,
        scopeHash: "scope",
        bindingsHash: "binding",
        ready: false,
        acceptanceCurrent: false,
        taskBlockers: ["IT nie potwierdził dostępu"],
        requirements: [
          {
            id: "asset",
            kind: "asset_issued",
            title: "Laptop dla tej współpracy",
            required: true,
            status: "missing",
            reason: "Sprzęt jest tylko zarezerwowany",
            nextAction: "Potwierdź wydanie właściwej osobie",
          },
          {
            id: "doc",
            kind: "document_approved",
            title: "Umowa <script>alert(1)</script>",
            required: true,
            status: "stale",
            reason: "Wersja dokumentu uległa zmianie",
            nextAction: "Wskaż zaakceptowaną wersję",
            source: {
              module: "documents",
              id: "private-source-id",
              title: "Wersja umowy",
              version: 2,
              hash: "hash-2",
              observedAt: "2026-09-08T10:00:00Z",
            },
          },
        ],
      },
    }),
  );
  assert.match(html, /Odbiór zablokowany/);
  assert.match(html, /Potwierdź wydanie właściwej osobie/);
  assert.match(html, /Wersja dokumentu uległa zmianie/);
  assert.match(html, /wersja 2/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|private-source-id|ops\./);
  assert.match(html, /odbiór sprawy jest osobną decyzją/);
});

const task = {
  id: "task-1",
  caseId: "case-1",
  caseVersion: 9,
  scopeRevision: 2,
  version: 4,
  title: "Przygotuj narzędzia",
  kind: "work",
  status: "accepted",
  assigneePrincipalId: "it-account",
  assigneeLabel: "Wykonawca IT",
  assigneeRole: "it",
  dueDate: "2026-09-07",
  overdue: true,
  dependsOn: [{ id: "task-0", completed: false }],
  allowedActions: ["completeTask", "transferTask"],
  performedBy: null,
  evidenceNote: null,
  events: [],
};

test("human task presents responsibility separately from acceptance and blocks premature completion", () => {
  const html = renderToStaticMarkup(
    createElement(HumanTaskCard, {
      task,
      onAction: () => assert.fail("Rendering cannot perform actions"),
    }),
  );
  assert.match(html, /Przyjęte do pracy/);
  assert.match(html, /Wykonawca IT/);
  assert.match(html, /Po terminie/);
  assert.match(html, /disabled=""[^>]*>Potwierdź wykonanie/);
  assert.match(html, /Przekaż zadanie/);
  assert.doesNotMatch(html, /Odebrane|ops\.|task-0|it-account/);
  const withoutActions = renderToStaticMarkup(
    createElement(HumanTaskCard, { task, actions: [], onAction: () => {} }),
  );
  assert.doesNotMatch(withoutActions, /<button/);
});

test("task commands pin both versions and cannot claim an actor or invent an unavailable action", () => {
  const values = {
    reason: "  Zastępstwo IT  ",
    assigneePrincipalId: "replacement-account",
    evidenceNote: "",
    performedBy: "forged-actor",
  };
  assert.deepEqual(taskCommand(task, "transferTask", values), {
    toolId: "ops.cases.transferTask",
    input: {
      id: "case-1",
      expectedVersion: 9,
      taskId: "task-1",
      expectedTaskVersion: 4,
      humanConfirmed: true,
      reason: "Zastępstwo IT",
      assigneePrincipalId: "replacement-account",
    },
  });
  assert.throws(
    () => taskCommand(task, "acceptTask", values),
    /nie jest dostępna/,
  );
  assert.throws(
    () =>
      taskCommand({ ...task, caseVersion: undefined }, "transferTask", values),
    /Brak aktualnej wersji sprawy/,
  );
});

test("loading a real company baseline changes only the draft and preserves typed requirements and role bindings in its command", () => {
  const profile = {
    tenantId: "company-a",
    version: 5,
    companyName: "Firma A",
    timezone: "Europe/Warsaw",
    licenseReminderDays: 14,
    quietHours: { enabled: true, start: "20:00", end: "08:00" },
    rules: { overdue_task: true },
    roleBindings: { hr: "hr-a", it: "it-a", manager: "manager-a" },
    processTemplates: baselineProcessTemplates("internal"),
    updatedAt: "2026-09-08T10:00:00Z",
    updatedBy: "owner",
  };
  const original = structuredClone(profile);
  const contractor = baselineProcessTemplates("contractor");
  const draft = applyCompanyTemplate(profile, {
    id: "contractor",
    label: "Konsultant klienta",
    processTemplates: contractor,
  });
  assert.deepEqual(
    profile,
    original,
    "selecting a draft must not mutate the saved profile",
  );
  assert.deepEqual(draft.roleBindings, original.roleBindings);
  assert.notDeepEqual(draft.processTemplates, profile.processTemplates);
  const input = companyProfileInput(draft, profile.version);
  assert.equal(input.expectedVersion, 5);
  assert.deepEqual(input.processTemplates, contractor);
  assert.deepEqual(input.roleBindings, original.roleBindings);
  assert.ok(
    input.processTemplates.onboarding.every(
      (item: {
        kind?: string;
        assigneeRole?: string;
        requirementKeys?: string[];
      }) =>
        item.kind && item.assigneeRole && Array.isArray(item.requirementKeys),
    ),
  );
  assert.equal("tenantId" in input, false);
  assert.equal("updatedBy" in input, false);
  draft.processTemplates.onboarding[0].title = "Zmiana w formularzu";
  assert.notEqual(contractor.onboarding[0]!.title, "Zmiana w formularzu");
});
