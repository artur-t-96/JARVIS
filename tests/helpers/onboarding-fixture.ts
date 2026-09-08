import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../src/contracts.js";
import { baselineProcessTemplates } from "../../src/workspace-models.js";
import type { CustodyFixture } from "./custody-fixture.js";
import { approveDocument } from "./document-fixture.js";
import { stageFile } from "./document-file-fixture.js";
import { taskWitness } from "./task-access-fixture.js";

/** Synthetic end-to-end business flow, always through independently approved Core commands. */
export async function seedOnboarding(
  f: CustodyFixture,
  options: {
    tenant?: string;
    kind?: "internal" | "contractor";
    personId?: string;
    startDate?: string;
  } = {},
) {
  const tenant = options.tenant ?? "synthetic-a",
    kind = options.kind ?? "internal",
    startDate = options.startDate ?? "2026-09-08",
    actor = f.actor("manager", tenant),
    profile = f.initiatives.profile(actor);
  const complete = (tool: string, input: JsonObject, id = "manager") =>
    f.complete(tool, input, id, tenant);
  const create = async (module: string, title: string, data: JsonObject) => {
    const run = await complete(`ops.${module}.create`, { title, data });
    return String(run.steps[0]!.output!.data.entityId);
  };
  await complete("initiatives.configure", {
    companyName: `Synthetic onboarding ${tenant}`,
    timezone: "Europe/Warsaw",
    licenseReminderDays: profile.licenseReminderDays,
    quietHours: profile.quietHours,
    rules: profile.rules,
    roleBindings: { hr: "manager", it: "it-one", manager: "manager" },
    processTemplates: baselineProcessTemplates(kind),
    employmentPolicy:
      kind === "contractor"
        ? {
            mode: "parallel_projects",
            maxConcurrent: 3,
            allowInternalOverlap: false,
          }
        : profile.employmentPolicy,
    expectedVersion: profile.version,
  } as unknown as JsonObject);
  const personId =
    options.personId ??
    (await create("people", "SYNTHETIC ONBOARDING PERSON", {
      personCategory: kind,
      department: "PRIVATE_HR_ONBOARDING_SENTINEL",
    }));
  const projectId =
    kind === "contractor"
      ? await create("cases", `Synthetic project ${randomUUID()}`, {
          caseType: "delivery",
          brief: "Synthetic agreed project",
          acceptanceCriteria: "Explicit synthetic acceptance",
        })
      : undefined;
  await complete("ops.people.startEmployment", {
    id: personId,
    expectedVersion: f.get("people", personId, tenant).version,
    employmentKind: kind,
    startDate,
    role: "Synthetic local role",
    humanDecision: true,
    ...(projectId ? { engagementRef: { module: "cases", id: projectId } } : {}),
  });
  const episode = f.workspace
    .listEmploymentEpisodes(actor, personId)
    .find((e) =>
      projectId ? e.engagementRef?.id === projectId : e.status === "onboarding",
    )!;
  const caseId = episode.onboardingCaseId!,
    getCase = () => f.get("cases", caseId, tenant),
    readiness = () => f.workspace.readiness(actor, caseId),
    licenseId = await create("licenses", "Synthetic application licence", {
      product: "Synthetic local application",
      totalSeats: 2,
      expiresOn: "2026-10-01",
    });
  await complete("ops.licenses.assign", {
    id: licenseId,
    expectedVersion: 1,
    personId,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    caseId,
    note: "Synthetic licence for this exact project only",
  });
  const licenseSeatId = String(
      (
        f.get("licenses", licenseId, tenant).data.assignments as JsonObject[]
      )[0]!.id,
    ),
    apps: string[] = [];
  for (const key of ["mail", "wiki"])
    apps.push(
      await create("it", `Synthetic ${key}`, {
        kind: "application",
        applicationKey: `${key}-${randomUUID()}`,
        description: "Synthetic local definition only",
        supportedRoles: ["member", "reader"],
      }),
    );
  const accessKey = `${kind === "internal" ? "employee-workspace" : "contractor-workspace"}-${episode.id.slice(0, 8)}`,
    bundleId = await create("it", "Synthetic project access", {
      kind: "access_bundle",
      accessKey,
      description: "Synthetic account checklist",
      members: apps.map((applicationId, i) => ({
        key: i === 0 ? "mail" : "wiki",
        applicationId,
        applicationVersion: 1,
        role: i === 0 ? "member" : "reader",
        validityDays: 7,
        ...(i === 0 ? { licenseId } : {}),
      })),
    });
  await complete("ops.cases.revise", {
    id: caseId,
    expectedVersion: getCase().version,
    brief: String(getCase().data.brief),
    acceptanceCriteria: String(getCase().data.acceptanceCriteria),
    reason:
      "Explicit synthetic equipment, original document and application scope",
    requirements: readiness().definitions.map((r) =>
      r.kind === "access_attested"
        ? { ...r, expected: { accessKey, bundleId, bundleVersion: 1 } }
        : r.kind === "document_approved"
          ? { ...r, expected: { ...r.expected, fileRequired: true } }
          : r,
    ) as unknown as JsonObject[],
  });
  const assetId = await create("assets", "Synthetic assigned laptop", {
    assetType: "laptop",
    serial: `ONBOARDING-${randomUUID()}`,
    location: "Synthetic stock",
    condition: "good",
  });
  await complete("ops.assets.reserve", {
    id: assetId,
    expectedVersion: 1,
    personId,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: episode.version,
    caseId,
    until: "2026-09-12",
    purpose: "Synthetic isolated onboarding acceptance",
  });
  const tasks = () =>
      f.workspace.listTasks(actor).filter((t) => t.caseId === caseId),
    task = (key: string) => {
      const result = tasks().find((t) => t.templateKey === key);
      assert.ok(result, `Missing current ${key} task`);
      return result;
    };
  async function transition(
    key: string,
    action: "acceptTask" | "completeTask",
  ) {
    const t = task(key);
    await complete(
      `ops.cases.${action}`,
      {
        id: caseId,
        expectedVersion: getCase().version,
        taskId: t.id,
        expectedTaskVersion: t.version,
        humanConfirmed: true,
        ...(action === "completeTask"
          ? { evidenceNote: `Synthetic ${key} work checked` }
          : {}),
      },
      t.assigneePrincipalId!,
    );
  }
  const documents = async () => {
    await transition("documents", "acceptTask");
    const scope = f.workspace.documentScope(actor, caseId),
      documentId = await create(
        "documents",
        "SYNTHETIC CONTRACT FIXTURE — NOT A REAL CONTRACT",
        {
          documentType: "contract",
          accessScope: "people",
          linkedCaseId: caseId,
          content:
            "Synthetic onboarding original for an isolated acceptance test. No legal agreement.",
          sources: [scope.source] as unknown as JsonObject[],
        },
      );
    await complete(
      "ops.documents.attachFile",
      await stageFile(f, documentId, tenant),
    );
    await approveDocument(f, documentId, tenant);
    await complete("ops.cases.bindEvidence", {
      id: caseId,
      expectedVersion: getCase().version,
      requirementId: readiness().requirements.find(
        (r) => r.kind === "document_approved",
      )!.id,
      sourceModule: "documents",
      sourceId: documentId,
      sourceVersion: f.get("documents", documentId, tenant).version,
    });
    await transition("documents", "completeTask");
    return documentId;
  };
  const equipment = async () => {
    await transition("equipment", "acceptTask");
    const view = () =>
      f.workspace.taskEquipment(
        f.actor("it-one", tenant),
        task("equipment").id,
      );
    await complete(
      "ops.assets.issueForTask",
      {
        ...view().allocations[0]!.commandBindings.issueForTask!,
        issuedOn: "2026-09-08",
        location: "Synthetic recipient desk",
        condition: "good",
        handoverNote: "Synthetic physical attestation only",
        humanConfirmed: true,
      },
      "it-one",
    );
    await complete(
      "ops.assets.bindAssetForTask",
      view().allocations[0]!.commandBindings.bindAssetForTask!,
      "it-one",
    );
    await transition("equipment", "completeTask");
  };
  const access = async () => {
    await transition("access", "acceptTask");
    const view = () =>
      f.workspace.taskAccess(f.actor("it-one", tenant), task("access").id);
    for (let i = 0; i < 2; i++)
      await complete(
        "ops.cases.attestAccessForTask",
        {
          ...view().requirements[0]!.members[i]!.commandBindings
            .attestAccessForTask!,
          ...taskWitness(i),
          ...(i === 0 ? { licenseSeatId } : {}),
        },
        "it-one",
      );
    await complete(
      "ops.cases.bindAccessForTask",
      {
        ...view().requirements[0]!.bindInput!,
        humanConfirmed: true,
      },
      "it-one",
    );
    await transition("access", "completeTask");
  };
  const managerReview = async () => {
    await transition("readiness", "acceptTask");
    await transition("readiness", "completeTask");
  };
  const accept = async (decision = "accepted") => {
    await complete("ops.cases.submit", {
      id: caseId,
      expectedVersion: getCase().version,
    });
    await complete("ops.cases.accept", {
      id: caseId,
      expectedVersion: getCase().version,
      decision,
      note: "Synthetic scope and all three independent sources reviewed",
      humanDecision: true,
    });
  };
  const activationInput = (): JsonObject => ({
    id: personId,
    expectedVersion: f.get("people", personId, tenant).version,
    employmentEpisodeId: episode.id,
    expectedEpisodeVersion: f.workspace
      .listEmploymentEpisodes(actor, personId)
      .find((e) => e.id === episode.id)!.version,
    humanDecision: true,
  });
  return {
    tenant,
    kind,
    personId,
    projectId,
    episodeId: episode.id,
    caseId,
    assetId,
    bundleId,
    licenseId,
    licenseSeatId,
    getCase,
    readiness,
    task,
    transition,
    documents,
    equipment,
    access,
    managerReview,
    accept,
    activationInput,
    complete,
  };
}
export type OnboardingFixture = Awaited<ReturnType<typeof seedOnboarding>>;
