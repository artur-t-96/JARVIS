import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { actionSchemas } from "../src/workspace-models.js";

const options = {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
};
const { equipmentCommand, equipmentState } = await tsImport(
  "../web/src/equipment.ts",
  options,
);
const { EquipmentTaskContent, TaskEquipment } = await tsImport(
  "../web/src/TaskEquipment.tsx",
  options,
);
const { HumanTaskCard } = await tsImport("../web/src/HumanTasks.tsx", options);
const {
  AllocationSelect,
  allocationSelection,
  allocationChoices,
  allocationExpired,
} = await tsImport("../web/src/AssetCustody.tsx", options);
const ids = Array.from(
  { length: 8 },
  (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);
function fixture(status = "reserved") {
  const binding = {
    id: ids[0],
    expectedVersion: 2,
    allocationId: ids[1],
    expectedAllocationVersion: 1,
    taskId: ids[2],
    expectedTaskVersion: 3,
    caseId: ids[3],
    allocationCaseId: ids[3],
    expectedCaseVersion: 4,
    scopeRevision: 1,
    scopeHash: "a".repeat(64),
    personId: ids[4],
    employmentEpisodeId: ids[5],
    expectedEpisodeVersion: 1,
    profileVersion: 2,
  };
  return {
    task: {
      id: ids[2],
      title: "Wydanie sprzętu",
      version: 3,
      status: "accepted",
      scopeRevision: 1,
    },
    recipientLabel: "Anna Testowa",
    engagementLabel: "Projekt Beta · konsultant",
    allocations: [
      {
        id: ids[1],
        version: 1,
        status,
        reservedUntil: "2099-09-12",
        expiresAt: "2099-09-12T21:59:59.999Z",
        expired: false,
        asset: {
          id: ids[0],
          version: 2,
          title: "Laptop demonstracyjny",
          serial: "SYNTH-001",
          location: "Magazyn",
          condition: "good",
        },
        binding: {
          status: "unbound",
          requirementId: ids[6],
          title: "Wydany laptop",
        },
        ...(status === "issued"
          ? {
              issueEvent: {
                id: ids[7],
                occurredOn: "2099-09-10",
                performedBy: "operator-it",
                approvedBy: "approver",
              },
            }
          : {}),
        allowedActions:
          status === "issued"
            ? ["returnForTask", "bindAssetForTask"]
            : ["issueForTask"],
        commandBindings: {
          issueForTask: binding,
          returnForTask: binding,
          bindAssetForTask: {
            ...binding,
            issueEventId: ids[7],
            requirementId: ids[6],
          },
        },
      },
    ],
    requirements: [
      {
        id: ids[6],
        title: "Wydany laptop",
        key: "equipment",
        status: "unbound",
      },
    ],
  };
}
const attestation = {
  date: "2099-09-10",
  location: " Biuro Beta ",
  condition: "good",
  note: " Fizycznie przekazano wskazane urządzenie. ",
  humanConfirmed: true,
};

test("equipment commands preserve exact task/allocation/episode/event bindings and only add human facts", () => {
  const view = fixture();
  const original = structuredClone(view);
  const issue = equipmentCommand(view, ids[1], "issueForTask", {
    ...attestation,
    performedBy: "forged",
    personId: ids[7],
    expectedAllocationVersion: 999,
  });
  assert.equal(
    actionSchemas.assets!.issueForTask!.safeParse(issue.input).success,
    true,
  );
  assert.equal(issue.input.personId, ids[4]);
  assert.equal(issue.input.expectedAllocationVersion, 1);
  assert.equal(issue.input.location, "Biuro Beta");
  assert.equal(issue.input.performedBy, undefined);
  assert.equal(issue.input.issuedOn, attestation.date);
  assert.deepEqual(view, original);
  const issued = fixture("issued");
  const bind = equipmentCommand(issued, ids[1], "bindAssetForTask");
  assert.equal(
    actionSchemas.assets!.bindAssetForTask!.safeParse(bind.input).success,
    true,
  );
  assert.equal(bind.input.issueEventId, ids[7]);
  assert.equal(bind.input.humanConfirmed, undefined);
  assert.equal(bind.input.issuedOn, undefined, "binding never reissues");
  const returned = equipmentCommand(issued, ids[1], "returnForTask", {
    ...attestation,
    condition: "repair",
  });
  assert.equal(
    actionSchemas.assets!.returnForTask!.safeParse(returned.input).success,
    true,
  );
  assert.equal(returned.input.returnedOn, attestation.date);
  assert.equal(returned.input.condition, "repair");
});

test("stale, unavailable, unaccepted, expired and damaged issue choices cannot prepare commands", () => {
  assert.throws(() =>
    equipmentCommand(fixture(), ids[7], "issueForTask", attestation),
  );
  const offered = fixture();
  offered.task.status = "offered";
  assert.throws(() =>
    equipmentCommand(offered, ids[1], "issueForTask", attestation),
  );
  const stale = fixture();
  stale.task.version++;
  assert.throws(
    () => equipmentCommand(stale, ids[1], "issueForTask", attestation),
    /nieaktualny/,
  );
  const expired = fixture();
  expired.allocations[0]!.expired = true;
  assert.throws(
    () => equipmentCommand(expired, ids[1], "issueForTask", attestation),
    /rezerwacji/,
  );
  assert.throws(() =>
    equipmentCommand(fixture(), ids[1], "issueForTask", {
      ...attestation,
      humanConfirmed: false,
    }),
  );
  assert.throws(
    () =>
      equipmentCommand(fixture(), ids[1], "issueForTask", {
        ...attestation,
        condition: "repair",
      }),
    /naprawy/,
  );
  const forgedEvent = fixture("issued");
  forgedEvent.allocations[0]!.commandBindings.bindAssetForTask.issueEventId =
    ids[0];
  assert.throws(
    () => equipmentCommand(forgedEvent, ids[1], "bindAssetForTask"),
    /poświadczonego/,
  );
});

test("narrow task view distinguishes issued versus bound and leaves document/access and human task gates visible", () => {
  const issued = fixture("issued");
  const html = renderToStaticMarkup(
    createElement(EquipmentTaskContent, {
      equipment: issued,
      onAction: () => {},
    }),
  );
  assert.match(html, /Anna Testowa/);
  assert.match(html, /Projekt Beta/);
  assert.match(html, /SYNTH-001/);
  assert.match(html, /Wydany — dowód wymaga powiązania/);
  assert.match(html, /Powiąż wydanie z wymaganiem/);
  assert.match(html, /nie wydaje sprzętu ponownie/);
  assert.match(html, /Dokumenty i dostęp wymagają odrębnego potwierdzenia/);
  assert.match(html, /operator-it/);
  assert.match(html, /approver/);
  assert.doesNotMatch(
    html,
    /Poświadcz wydanie<|ops\.assets\.|type="text"|name=".*Id"|email|department/,
  );
  for (const id of ids) assert.ok(!html.includes(id));
  const bound = structuredClone(issued);
  bound.allocations[0]!.binding.status = "bound";
  assert.equal(
    equipmentState(bound.allocations[0]),
    "Wydany — dowód powiązany",
  );
  const returned = structuredClone(issued);
  returned.allocations[0]!.status = "returned";
  assert.match(
    equipmentState(returned.allocations[0]),
    /nie potwierdza gotowości/,
  );
  const initial = renderToStaticMarkup(
    createElement(TaskEquipment, {
      taskId: ids[2],
      title: "Wydanie",
      onClose: () => {},
    }),
  );
  assert.doesNotMatch(initial, /Anna Testowa|Poświadcz wydanie/);
});

test("offered equipment tasks show minimal recipient/project before acceptance, without allocation actions", () => {
  const common = {
    id: ids[2],
    caseId: ids[3],
    caseVersion: 1,
    scopeRevision: 1,
    version: 1,
    title: "Wydanie sprzętu",
    kind: "work",
    status: "offered",
    assigneePrincipalId: "operator-it",
    assigneeRole: "it",
    dueDate: "2099-09-12",
    overdue: false,
    dependsOn: [],
    allowedActions: ["acceptTask"],
    performedBy: null,
    evidenceNote: null,
    events: [],
  };
  for (const project of ["Projekt Alfa", "Projekt Beta"]) {
    const html = renderToStaticMarkup(
      createElement(HumanTaskCard, {
        task: {
          ...common,
          operationalContext: {
            recipientLabel: "Anna Testowa",
            engagementLabel: project,
            equipment: true,
          },
        },
        onAction: () => {},
        onEquipment: () => {},
      }),
    );
    assert.match(html, new RegExp(project));
    assert.match(html, /Przyjmij zadanie/);
    assert.match(html, /Sprzęt i przekazanie/);
    assert.doesNotMatch(html, /Poświadcz wydanie|Powiąż wydanie/);
  }
  const source = readFileSync(
    new URL("../web/src/TaskEquipment.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\/api\/(people|workspace|cases|company)/,
    "narrow IT component never requests an HR directory or full case",
  );
});

test("full inventory selector pins the selected allocation version, expiration never silently releases it", () => {
  const reserved = {
    id: ids[1],
    personId: ids[4],
    employmentEpisodeId: ids[5],
    caseId: ids[3],
    version: 2,
    status: "reserved",
    recipientLabel: "Anna Testowa",
    engagementLabel: "Projekt Beta",
    reservedUntil: "2099-09-12",
    expiresAt: "2099-09-12T21:59:59.999Z",
    timezone: "Europe/Warsaw",
    issuedOn: null,
    returnedOn: null,
    provenance: "p05",
    issueEventId: null,
  };
  const expired = {
    ...reserved,
    id: ids[7],
    expiresAt: "2020-01-01T00:00:00Z",
  };
  assert.deepEqual(
    allocationSelection([reserved, expired], "issue", reserved.id),
    { allocationId: reserved.id, expectedAllocationVersion: 2 },
  );
  assert.throws(() =>
    allocationSelection([reserved, expired], "issue", expired.id),
  );
  assert.deepEqual(
    allocationChoices([reserved, expired], "expireReservation"),
    [expired],
  );
  assert.equal(expired.status, "reserved");
  assert.equal(allocationExpired(expired), true);
  assert.throws(
    () =>
      allocationSelection(
        [{ ...reserved, employmentEpisodeId: null }],
        "issue",
        reserved.id,
      ),
    /Historyczny/,
  );
  const html = renderToStaticMarkup(
    createElement(AllocationSelect, {
      allocations: [reserved],
      action: "issue",
      selectedId: "",
      disabled: false,
      onSelect: () => {},
    }),
  );
  assert.match(html, /<select/);
  assert.match(html, /Projekt Beta/);
  assert.doesNotMatch(html, /<input|expectedAllocationVersion/);
});
