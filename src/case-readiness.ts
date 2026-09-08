import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DomainError, type JsonObject, type ToolContext } from "./contracts.js";
import type { Entity } from "./workspace.js";
import { readIssuedAllocationProof } from "./asset-custody.js";
import { AccessRegister } from "./access-register.js";
import { DocumentSources } from "./document-sources.js";
import type { DocumentFiles } from "./document-files.js";
import {
  laboratoryTest,
  type LaboratoryProofReader,
} from "./laboratory-contract.js";

const uuid = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const base = {
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
  title: z.string().trim().min(1).max(200),
  required: z.boolean(),
};
export const caseRequirementDefinitionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("asset_issued"),
      expected: z
        .object({
          assetType: z.enum(["laptop", "phone", "monitor", "other"]).optional(),
          assetId: uuid.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("document_approved"),
      expected: z
        .object({
          documentType: z.enum([
            "policy",
            "contract",
            "offer",
            "report",
            "other",
          ]),
          documentId: uuid.optional(),
          documentRevision: z.number().int().positive().optional(),
          contentHash: hash.optional(),
          currentVersionRequired: z.literal(true),
          fileRequired: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("access_attested"),
      expected: z
        .object({
          accessKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/),
          bundleId: uuid.optional(),
          bundleVersion: z.number().int().positive().optional(),
        })
        .strict()
        .refine(
          (value) =>
            (value.bundleId === undefined) ===
            (value.bundleVersion === undefined),
          "Zestaw wymaga identyfikatora i wersji.",
        ),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("delivery_received"),
      expected: z.object({ purchaseId: uuid.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("test_passed"),
      expected: z
        .object({ testKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/) })
        .strict(),
    })
    .strict(),
]);
export const caseRequirementDefinitionsSchema = z
  .array(caseRequirementDefinitionSchema)
  .max(50)
  .superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.key)).size !== items.length)
      ctx.addIssue({
        code: "custom",
        message: "Klucze wymagań muszą być unikalne.",
      });
  });
export type CaseRequirementDefinition = z.infer<
  typeof caseRequirementDefinitionSchema
>;
export type RequirementKind = CaseRequirementDefinition["kind"];
export type RequirementStatus =
  "satisfied" | "missing" | "stale" | "failed" | "exception";
export interface CaseRequirement {
  id: string;
  caseId: string;
  scopeRevision: number;
  key: string;
  title: string;
  kind: RequirementKind;
  required: boolean;
  personId: string | null;
  employmentEpisodeId: string | null;
  expected: JsonObject;
  createdBy: string;
  createdAt: string;
}
export interface EvidenceBinding {
  id: string;
  requirementId: string;
  caseId: string;
  scopeRevision: number;
  sourceModule: string;
  sourceId: string;
  sourceVersion: number;
  sourceHash: string;
  sourceRevision: number | null;
  sourceIdentity: JsonObject;
  observedAt: string;
  requestedBy: string;
  approvedBy: string | null;
  provenance: "independent_local_read";
}
export interface RequirementAssessment {
  id: string;
  key: string;
  kind: RequirementKind;
  title: string;
  required: boolean;
  status: RequirementStatus;
  reason: string;
  nextAction: string;
  source?: {
    module: string;
    id: string;
    title: string;
    version: number;
    hash: string;
    observedAt: string;
    runId?: string;
  };
}
export interface AcceptanceReadiness {
  caseId: string;
  scopeRevision: number;
  scopeHash: string;
  bindingsHash: string;
  ready: boolean;
  requirements: RequirementAssessment[];
  taskBlockers: string[];
  acceptanceCurrent: boolean;
  contractVersion: "p03";
  bindings: EvidenceBinding[];
}
type Row = Record<string, unknown>;
export const readinessCanonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(readinessCanonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${readinessCanonical(item)}`)
    .join(",")}}`;
};
export const readinessHash = (value: unknown) =>
  createHash("sha256").update(readinessCanonical(value)).digest("hex");
function error(code: string, message: string): never {
  throw new DomainError(code, message, 409);
}

export function migrateReadiness(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE ops_case_requirements(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,requirement_key TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('asset_issued','document_approved','access_attested','delivery_received','test_passed')),required INTEGER NOT NULL CHECK(required IN(0,1)),person_id TEXT,employment_episode_id TEXT,expected_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,case_id,scope_revision,requirement_key),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
    CREATE TABLE ops_requirement_bindings(tenant_id TEXT NOT NULL,id TEXT NOT NULL,requirement_id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,source_module TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,source_revision INTEGER,source_identity_json TEXT NOT NULL,observed_at TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,provenance TEXT NOT NULL CHECK(provenance='independent_local_read'),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,requirement_id),FOREIGN KEY(tenant_id,requirement_id) REFERENCES ops_case_requirements(tenant_id,id));
    CREATE TABLE ops_case_exceptions(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,requirement_id TEXT NOT NULL,rule TEXT NOT NULL,reason TEXT NOT NULL,approved_by TEXT NOT NULL,risk_owner_principal_id TEXT NOT NULL,expires_at TEXT NOT NULL,closure_plan TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','closed')),created_at TEXT NOT NULL,closed_at TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,requirement_id) REFERENCES ops_case_requirements(tenant_id,id));
    ALTER TABLE ops_acceptances ADD COLUMN scope_hash TEXT;
    ALTER TABLE ops_acceptances ADD COLUMN bindings_hash TEXT;
    ALTER TABLE ops_acceptances ADD COLUMN bindings_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE ops_acceptances ADD COLUMN contract_version TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE ops_acceptances ADD COLUMN requested_by TEXT;
    ALTER TABLE ops_acceptances ADD COLUMN approved_by TEXT;
    ALTER TABLE ops_acceptances ADD COLUMN person_id TEXT;
    ALTER TABLE ops_acceptances ADD COLUMN employment_episode_id TEXT;
    ALTER TABLE ops_allocations ADD COLUMN employment_episode_id TEXT;
    ALTER TABLE ops_allocations ADD COLUMN case_id TEXT;
    ALTER TABLE ops_license_seats ADD COLUMN employment_episode_id TEXT;
    ALTER TABLE ops_license_seats ADD COLUMN case_id TEXT;
  `);
}

export function onboardingRequirements(
  kind: string,
): CaseRequirementDefinition[] {
  return [
    {
      key: "equipment",
      title: "Sprzęt wydany właściwej osobie i współpracy",
      kind: "asset_issued",
      required: true,
      expected: { assetType: "laptop" },
    },
    {
      key: "documents",
      title:
        kind === "contractor"
          ? "Zaakceptowana wersja umowy konsultanta"
          : "Zaakceptowana wersja dokumentu pracownika",
      kind: "document_approved",
      required: true,
      expected: { documentType: "contract", currentVersionRequired: true },
    },
    {
      key: "access",
      title:
        kind === "contractor"
          ? "Potwierdzony wymagany dostęp konsultanta"
          : "Potwierdzony wymagany dostęp pracownika",
      kind: "access_attested",
      required: true,
      expected: {
        accessKey:
          kind === "contractor" ? "contractor-workspace" : "employee-workspace",
      },
    },
  ];
}

export class CaseReadinessStore {
  private laboratoryProof?: LaboratoryProofReader;
  constructor(
    private readonly db: DatabaseSync,
    private readonly authorizedOwner?: (
      tenant: string,
      entity: Entity,
    ) => boolean,
    private readonly documentFiles?: DocumentFiles,
  ) {}
  setLaboratoryProofReader(reader: LaboratoryProofReader) {
    this.laboratoryProof = reader;
  }
  requirements(
    tenant: string,
    caseId: string,
    revision: number,
  ): CaseRequirement[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM ops_case_requirements WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY requirement_key",
        )
        .all(tenant, caseId, revision) as Row[]
    ).map((r) => ({
      id: String(r.id),
      caseId: String(r.case_id),
      scopeRevision: Number(r.scope_revision),
      key: String(r.requirement_key),
      title: String(r.title),
      kind: r.kind as RequirementKind,
      required: Boolean(r.required),
      personId: r.person_id ? String(r.person_id) : null,
      employmentEpisodeId: r.employment_episode_id
        ? String(r.employment_episode_id)
        : null,
      expected: JSON.parse(String(r.expected_json)),
      createdBy: String(r.created_by),
      createdAt: String(r.created_at),
    }));
  }
  definitions(
    tenant: string,
    e: Entity,
    revision = Number(e.data.scopeRevision),
  ): CaseRequirementDefinition[] {
    return this.requirements(tenant, e.id, revision).map(
      ({ key, title, kind, required, expected }) =>
        caseRequirementDefinitionSchema.parse({
          key,
          title,
          kind,
          required,
          expected,
        }),
    );
  }
  initialize(
    tenant: string,
    e: Entity,
    definitions: unknown,
    actor: string,
    now: string,
  ) {
    const proposed = caseRequirementDefinitionsSchema.parse(
      definitions ??
        (e.data.caseType === "onboarding"
          ? onboardingRequirements(String(e.data.employmentKind))
          : e.data.laboratoryContext
            ? [
                {
                  key: "service_http",
                  title: "Niezależny test HTTP po zatwierdzonej naprawie",
                  kind: "test_passed",
                  required: true,
                  expected: { testKey: laboratoryTest },
                },
              ]
            : []),
    );
    if (
      e.data.laboratoryContext &&
      !proposed.some(
        (item) =>
          item.kind === "test_passed" &&
          item.required &&
          item.expected.testKey === laboratoryTest,
      )
    )
      error(
        "LAB_TEST_REQUIRED",
        "Sprawa laboratorium wymaga niezależnego testu własnej usługi w każdej rewizji.",
      );
    if (e.data.caseType === "onboarding") {
      if (!e.data.personId || !e.data.employmentEpisodeId)
        error(
          "LIFECYCLE_BINDING_REQUIRED",
          "Onboarding wymaga osoby i konkretnego okresu współpracy.",
        );
      for (const kind of [
        "asset_issued",
        "document_approved",
        "access_attested",
      ])
        if (!proposed.some((item) => item.kind === kind && item.required))
          error(
            "BASELINE_REQUIREMENT_REQUIRED",
            "Nie można usunąć obowiązkowego sprzętu, dokumentu ani dostępu z onboardingu.",
          );
    }
    for (const item of proposed) {
      if (
        item.kind === "access_attested" &&
        item.expected.bundleId &&
        item.expected.bundleVersion
      ) {
        const bundle = new AccessRegister(this.db).bundle(
          tenant,
          item.expected.bundleId,
          item.expected.bundleVersion,
        );
        if (bundle.data.accessKey !== item.expected.accessKey)
          error(
            "ACCESS_BUNDLE_MISMATCH",
            "Zestaw nie odpowiada wymaganemu kluczowi dostępu.",
          );
      }
      this.db
        .prepare(
          "INSERT INTO ops_case_requirements VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          tenant,
          randomUUID(),
          e.id,
          Number(e.data.scopeRevision),
          item.key,
          item.title,
          item.kind,
          item.required ? 1 : 0,
          typeof e.data.personId === "string" ? e.data.personId : null,
          typeof e.data.employmentEpisodeId === "string"
            ? e.data.employmentEpisodeId
            : null,
          readinessCanonical(item.expected),
          actor,
          now,
        );
    }
  }
  bindings(
    tenant: string,
    caseId: string,
    revision: number,
  ): EvidenceBinding[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM ops_requirement_bindings WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY requirement_id",
        )
        .all(tenant, caseId, revision) as Row[]
    ).map((r) => ({
      id: String(r.id),
      requirementId: String(r.requirement_id),
      caseId: String(r.case_id),
      scopeRevision: Number(r.scope_revision),
      sourceModule: String(r.source_module),
      sourceId: String(r.source_id),
      sourceVersion: Number(r.source_version),
      sourceHash: String(r.source_hash),
      sourceRevision:
        r.source_revision === null ? null : Number(r.source_revision),
      sourceIdentity: JSON.parse(String(r.source_identity_json)),
      observedAt: String(r.observed_at),
      requestedBy: String(r.requested_by),
      approvedBy: r.approved_by ? String(r.approved_by) : null,
      provenance: "independent_local_read",
    }));
  }
  private source(
    tenant: string,
    requirement: CaseRequirement,
    module: string,
    id: string,
    assetPin: { allocationId?: string; issueEventId?: string } | undefined,
    now: string,
  ) {
    if (requirement.kind === "test_passed" && module === "laboratory") {
      if (
        requirement.expected.testKey !== laboratoryTest ||
        !this.laboratoryProof
      )
        error(
          "EVIDENCE_SOURCE_UNSUPPORTED",
          "Brak czytnika tego testu. Wybierz właściwy test w nowej rewizji.",
        );
      return this.laboratoryProof(
        tenant,
        id,
        requirement.caseId,
        requirement.scopeRevision,
        now,
      );
    }
    const r = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module=? AND id=?",
      )
      .get(tenant, module, id) as Row | undefined;
    if (!r)
      error("EVIDENCE_SOURCE_NOT_FOUND", "Brak źródła w tej organizacji.");
    const data = JSON.parse(String(r.data_json)) as JsonObject;
    let identity: JsonObject;
    let revision: number | null = null;
    if (requirement.kind === "asset_issued" && module === "assets") {
      if (!assetPin?.allocationId || !assetPin.issueEventId)
        error(
          "EVIDENCE_SOURCE_UNVERIFIED",
          "Wymagane dokładne poświadczone wydanie: alokacja i niezmienne zdarzenie. Historyczne powiązanie nie zyskuje nowego dowodu.",
        );
      return readIssuedAllocationProof(this.db, tenant, {
        assetId: id,
        allocationId: assetPin.allocationId,
        issueEventId: assetPin.issueEventId,
      });
    } else if (requirement.kind === "access_attested" && module === "it") {
      if (id !== requirement.expected.bundleId)
        error(
          "ACCESS_BUNDLE_MISMATCH",
          "Źródło nie jest zestawem wymaganym przez sprawę.",
        );
      return new AccessRegister(this.db).assessment(
        tenant,
        requirement.caseId,
        requirement.id,
        now,
      );
    } else if (
      requirement.kind === "document_approved" &&
      module === "documents"
    ) {
      revision = Number(data.revision);
      const document = this.db
        .prepare(
          "SELECT * FROM ops_document_versions WHERE tenant_id=? AND document_id=? AND revision=?",
        )
        .get(tenant, id, revision) as Row | undefined;
      if (!document)
        error("EVIDENCE_SOURCE_NOT_FOUND", "Brak zapisanej wersji dokumentu.");
      const references = Array.isArray(data.sources)
        ? (data.sources as JsonObject[])
        : [];
      if (references.length > 20)
        error("DOCUMENT_SOURCES_INVALID", "Zbyt wiele źródeł dokumentu.");
      const sources = new DocumentSources(this.db, this.documentFiles);
      const sourceReferences = sources.references(tenant, references);
      const state = ["p09a1", "p09a2"].includes(String(data.sourceContract))
        ? sources.assessment(tenant, {
            id,
            module: "documents",
            title: String(r.title),
            status: String(r.status),
            version: Number(r.version),
            data,
            createdAt: String(r.created_at),
            updatedAt: String(r.updated_at),
          })
        : null;
      identity = {
        documentId: id,
        documentType: data.documentType ?? null,
        sourceReferences,
        sourcesCurrent:
          sourceReferences.every((source) => source.current) &&
          (!state || state.readyForReview),
        ...(state
          ? {
              contextHash: state.contextHash,
              contextValid: state.integrity && state.readyForReview,
              ...(data.sourceContract === "p09a2"
                ? { files: state.attachments }
                : {}),
            }
          : {}),
        revision,
        contentHash: String(document.content_hash),
        contentMatchesHash:
          readinessHash(String(document.content)) === document.content_hash,
        status: String(document.status),
        entityStatus: String(r.status),
        linkedCaseId: data.linkedCaseId ?? null,
        ownerId: data.ownerId ?? null,
        decidedBy: document.decided_by ? String(document.decided_by) : null,
      };
    } else {
      // A license assignment is not an access attestation. P07/P08/P08a will add
      // real source readers; an arbitrary business record cannot stand in for one.
      error(
        "EVIDENCE_SOURCE_UNSUPPORTED",
        "Ten warunek nie ma jeszcze obsługiwanego źródła potwierdzenia. Wymagana właściwa funkcja domenowa.",
      );
    }
    return {
      title: String(r.title),
      version: Number(r.version),
      revision,
      identity,
      hash: readinessHash(identity),
    };
  }
  bind(
    ctx: ToolContext,
    e: Entity,
    input: {
      requirementId: string;
      sourceModule: string;
      sourceId: string;
      sourceVersion: number;
      allocationId?: string;
      issueEventId?: string;
      accessProofHash?: string;
      sourceProofHash?: string;
    },
    now: string,
  ) {
    const requirement = this.requirements(
      ctx.tenantId,
      e.id,
      Number(e.data.scopeRevision),
    ).find((r) => r.id === input.requirementId);
    if (!requirement)
      error(
        "REQUIREMENT_NOT_FOUND",
        "Warunek nie należy do bieżącej rewizji sprawy.",
      );
    const source = this.source(
      ctx.tenantId,
      requirement,
      input.sourceModule,
      input.sourceId,
      input,
      now,
    );
    if (source.version !== input.sourceVersion)
      error(
        "SOURCE_VERSION_CHANGED",
        "Źródło zmieniło wersję. Odczytaj je przed przygotowaniem nowego planu.",
      );
    if (
      requirement.kind === "test_passed" &&
      (input.sourceProofHash !== source.hash ||
        source.identity.current !== true ||
        source.identity.scopeHash !==
          this.evaluate(ctx.tenantId, e, now).scopeHash ||
        !e.data.laboratoryContext)
    )
      error(
        "LAB_PROOF_CHANGED",
        "Wymagany aktualny pozytywny test dokładnej naprawy i rewizji sprawy.",
      );
    if (requirement.kind === "asset_issued") {
      const value = source.identity,
        expected = requirement.expected;
      if (
        value.status !== "issued" ||
        value.assetStatus !== "issued" ||
        !value.issuedOn ||
        !value.issueEventId ||
        !value.performedBy ||
        value.currentCondition !== "good" ||
        value.caseId !== e.id ||
        (requirement.personId && value.personId !== requirement.personId) ||
        (requirement.employmentEpisodeId &&
          value.employmentEpisodeId !== requirement.employmentEpisodeId) ||
        (expected.assetId && value.assetId !== expected.assetId) ||
        (expected.assetType && value.assetType !== expected.assetType)
      )
        error(
          "EVIDENCE_ASSET_MISMATCH",
          "Poświadczone wydanie nie spełnia warunku właściwej osoby, współpracy, sprawy i stanu urządzenia.",
        );
    }
    if (
      requirement.kind === "access_attested" &&
      (input.accessProofHash !== source.hash ||
        source.identity.current !== true)
    )
      error(
        "ACCESS_PROOF_CHANGED",
        "Wymagane aktualne poświadczenia wszystkich pozycji zestawu i zgoda na dokładny odczyt dowodu.",
      );
    const existing = this.bindings(
      ctx.tenantId,
      e.id,
      Number(e.data.scopeRevision),
    ).find((item) => item.requirementId === requirement.id);
    if (existing)
      error(
        "REVISION_REQUIRED",
        "Powiązanie jest zamrożone. Zmiana wymaganego źródła wymaga nowej rewizji sprawy.",
      );
    this.db
      .prepare(
        "INSERT INTO ops_requirement_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        ctx.tenantId,
        randomUUID(),
        requirement.id,
        e.id,
        requirement.scopeRevision,
        input.sourceModule,
        input.sourceId,
        source.version,
        source.hash,
        source.revision,
        readinessCanonical(source.identity),
        now,
        ctx.actorId ?? "system",
        ctx.approvedBy ?? null,
        ctx.runId,
        ctx.stepId,
        ctx.operationKey,
        "independent_local_read",
      );
  }
  evaluate(tenant: string, e: Entity, now: string): AcceptanceReadiness {
    const revision = Number(e.data.scopeRevision);
    const requirements = this.requirements(tenant, e.id, revision);
    const bindings = this.bindings(tenant, e.id, revision);
    const tasks = this.db
      .prepare(
        "SELECT * FROM ops_tasks WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY id",
      )
      .all(tenant, e.id, revision) as Row[];
    const taskBlockers: string[] = [];
    if (!tasks.length && !e.data.laboratoryContext)
      taskBlockers.push("Dodaj wymagane zadania bieżącej rewizji.");
    for (const task of tasks)
      if (task.required && task.status !== "completed")
        taskBlockers.push(`Ukończ zadanie: ${String(task.title)}`);
    const onboarding = e.data.caseType === "onboarding";
    if (
      e.data.laboratoryContext &&
      (!this.authorizedOwner?.(tenant, e) ||
        !requirements.some(
          (r) =>
            r.kind === "test_passed" &&
            r.required &&
            r.expected.testKey === laboratoryTest,
        ))
    )
      taskBlockers.push(
        "Sprawa IT wymaga aktywnego właściciela i obowiązkowego niezależnego testu usługi.",
      );
    if (onboarding) {
      if (!e.data.ownerPrincipalId || !this.authorizedOwner?.(tenant, e))
        taskBlockers.push(
          "Wskaż w nowej rewizji aktywnego właściciela odbioru z dostępem do pełnej sprawy.",
        );
      for (const kind of [
        "asset_issued",
        "document_approved",
        "access_attested",
      ])
        if (!requirements.some((r) => r.kind === kind && r.required))
          taskBlockers.push(
            "Historyczna sprawa nie ma typowanych bramek onboardingu. Przygotuj nową rewizję.",
          );
      const episode = this.db
        .prepare(
          "SELECT * FROM ops_employment WHERE tenant_id=? AND id=? AND person_id=?",
        )
        .get(
          tenant,
          String(e.data.employmentEpisodeId ?? ""),
          String(e.data.personId ?? ""),
        ) as Row | undefined;
      if (
        !episode ||
        e.data.employmentStartDate !== episode.start_date ||
        e.data.employmentKind !== episode.kind
      )
        taskBlockers.push(
          "Wiązanie osoby, współpracy albo terminu startu zmieniło się. Przygotuj nową rewizję.",
        );
    }
    if (
      !requirements.length &&
      !onboarding &&
      !this.db
        .prepare(
          "SELECT id FROM ops_evidence WHERE tenant_id=? AND case_id=? AND scope_revision=? LIMIT 1",
        )
        .get(tenant, e.id, revision)
    )
      taskBlockers.push("Dodaj dowód pomocniczy wykonania tej rewizji.");
    const assessments = requirements.map(
      (requirement): RequirementAssessment => {
        const result: RequirementAssessment = {
          id: requirement.id,
          key: requirement.key,
          kind: requirement.kind,
          title: requirement.title,
          required: requirement.required,
          status: "missing",
          reason: "Brak typowanego dowodu.",
          nextAction: "Wskaż właściwe źródło dowodu dla tej rewizji.",
        };
        if (
          requirement.personId !== (e.data.personId ?? null) ||
          requirement.employmentEpisodeId !==
            (e.data.employmentEpisodeId ?? null)
        )
          return {
            ...result,
            status: "failed",
            reason: "Warunek wskazuje inną osobę lub współpracę.",
            nextAction: "Przygotuj prawidłową rewizję zakresu.",
          };
        if (
          requirement.kind === "delivery_received" ||
          (requirement.kind === "test_passed" &&
            requirement.expected.testKey !== laboratoryTest)
        )
          return {
            ...result,
            reason: "Właściwy odczyt źródła nie jest jeszcze dostępny.",
            nextAction:
              requirement.kind === "delivery_received"
                ? "Wymagane potwierdzenie odbioru we właściwym rejestrze dostaw."
                : "Wymagany niezależny wynik testu.",
          };
        const binding = bindings.find(
          (item) => item.requirementId === requirement.id,
        );
        if (!binding) return result;
        let source: ReturnType<CaseReadinessStore["source"]>;
        try {
          source = this.source(
            tenant,
            requirement,
            binding.sourceModule,
            binding.sourceId,
            {
              allocationId:
                typeof binding.sourceIdentity.allocationId === "string"
                  ? binding.sourceIdentity.allocationId
                  : undefined,
              issueEventId:
                typeof binding.sourceIdentity.issueEventId === "string"
                  ? binding.sourceIdentity.issueEventId
                  : undefined,
            },
            now,
          );
        } catch {
          return {
            ...result,
            status: "failed",
            reason: "Nie można odczytać właściwego źródła dowodu.",
            nextAction:
              "Przywróć prawidłowe źródło lub przygotuj nową rewizję.",
          };
        }
        result.source = {
          module: binding.sourceModule,
          id: binding.sourceId,
          title: source.title,
          version: binding.sourceVersion,
          hash: binding.sourceHash,
          observedAt:
            requirement.kind === "test_passed"
              ? String(source.identity.observedAt)
              : binding.observedAt,
          ...(requirement.kind === "test_passed"
            ? { runId: String(source.identity.runId) }
            : {}),
        };
        if (
          requirement.kind === "test_passed" &&
          (!e.data.laboratoryContext || source.identity.current !== true)
        )
          return {
            ...result,
            status: "stale",
            reason: "Test wygasł albo stan usługi zmienił się od naprawy.",
            nextAction:
              "Odczytaj aktualny stan; przygotuj nową rewizję, naprawę i dowód.",
          };
        if (
          source.version !== binding.sourceVersion ||
          source.hash !== binding.sourceHash ||
          source.revision !== binding.sourceRevision
        )
          return {
            ...result,
            status: "stale",
            reason: "Źródło zmieniło wersję lub treść po powiązaniu.",
            nextAction: "Przygotuj nową rewizję i odczytaj aktualny dowód.",
          };
        const expected = requirement.expected,
          value = source.identity;
        if (requirement.kind === "access_attested" && value.current !== true)
          return {
            ...result,
            status: "failed",
            reason:
              "Nie wszystkie wymagane aplikacje i role mają aktualne poświadczenie oraz wymaganą licencję.",
            nextAction:
              "Sprawdź i poświadcz brakujące dostępy właściwej współpracy.",
          };
        if (requirement.kind === "asset_issued") {
          if (
            value.status !== "issued" ||
            value.assetStatus !== "issued" ||
            !value.issuedOn ||
            !value.issueEventId ||
            !value.performedBy ||
            value.currentCondition !== "good"
          )
            return {
              ...result,
              status: "failed",
              reason:
                "Sprzęt nie jest faktycznie wydany; rezerwacja ani zwrot nie spełniają warunku.",
              nextAction:
                "Wymagane jest potwierdzone wydanie właściwego sprzętu.",
            };
          if (
            (requirement.personId && value.personId !== requirement.personId) ||
            (requirement.employmentEpisodeId &&
              value.employmentEpisodeId !== requirement.employmentEpisodeId) ||
            value.caseId !== e.id
          )
            return {
              ...result,
              status: "failed",
              reason:
                "Wydanie nie wskazuje właściwej osoby, współpracy i sprawy.",
              nextAction:
                "Wymagane powiązanie wydania z tą osobą, współpracą i sprawą.",
            };
          if (
            (expected.assetId && expected.assetId !== value.assetId) ||
            (expected.assetType && expected.assetType !== value.assetType)
          )
            return {
              ...result,
              status: "failed",
              reason: "Wydany sprzęt nie odpowiada wymaganiu zakresu.",
              nextAction: "Wydaj wymagany sprzęt lub jawnie zmień zakres.",
            };
        }
        if (requirement.kind === "document_approved") {
          if (
            expected.fileRequired &&
            (!Array.isArray(value.files) ||
              !value.files.length ||
              value.files.some(
                (f) =>
                  !f ||
                  typeof f !== "object" ||
                  Array.isArray(f) ||
                  f.valid !== true,
              ))
          )
            return {
              ...result,
              status: "failed",
              reason: "Wymagany jest aktualny plik zaakceptowanej rewizji.",
              nextAction:
                "Dodaj właściwy plik, zatwierdź nową rewizję i powiąż dowód.",
            };
          if (
            Array.isArray(value.sourceReferences) &&
            value.sourceReferences.some(
              (source) =>
                typeof source === "object" &&
                source !== null &&
                !Array.isArray(source) &&
                source.module === "cases" &&
                source.id === e.id &&
                source.kind !== "case_scope",
            )
          )
            return {
              ...result,
              status: "failed",
              reason: "Dokument zależy od zmiennego stanu tej samej sprawy.",
              nextAction:
                "Wymagane niezależne źródło związane z konkretnym zakresem; nie można użyć zależności cyklicznej.",
            };
          if (value.sourcesCurrent !== true)
            return {
              ...result,
              status: "stale",
              reason: "Źródło dokumentu zmieniło wersję lub jest niedostępne.",
              nextAction:
                "Przygotuj dokument z aktualnymi źródłami i nową rewizję odbioru.",
            };
          if (
            (onboarding && value.contextValid !== true) ||
            value.status !== "approved" ||
            value.entityStatus !== "approved" ||
            value.contentMatchesHash !== true ||
            !value.decidedBy
          )
            return {
              ...result,
              status: "failed",
              reason: "Wersja dokumentu nie ma zgodnego hasha i akceptacji.",
              nextAction: "Przeprowadź akceptację właściwej wersji dokumentu.",
            };
          if (
            (onboarding && value.linkedCaseId !== e.id) ||
            expected.documentType !== value.documentType ||
            (expected.documentId && expected.documentId !== value.documentId) ||
            (expected.documentRevision &&
              expected.documentRevision !== value.revision) ||
            (expected.contentHash && expected.contentHash !== value.contentHash)
          )
            return {
              ...result,
              status: "failed",
              reason:
                "Dokument, rewizja lub powiązanie sprawy nie odpowiada wymaganiu.",
              nextAction: "Wskaż dokument dla tej sprawy i wymaganej wersji.",
            };
        }
        const exception = this.db
          .prepare(
            "SELECT id FROM ops_case_exceptions WHERE tenant_id=? AND requirement_id=? AND scope_revision=? AND status='open' AND expires_at>?",
          )
          .get(tenant, requirement.id, revision, now);
        if (exception)
          return {
            ...result,
            status: "failed",
            reason:
              "Brak reguły zezwalającej na zastąpienie tego dowodu wyjątkiem.",
            nextAction: "Zamknij wyjątek i spełnij warunek źródłowy.",
          };
        return {
          ...result,
          status: "satisfied",
          reason: "Aktualny niezależny odczyt spełnia wymaganie tej rewizji.",
          nextAction:
            "Dowód zostanie ponownie sprawdzony przy odbiorze i aktywacji.",
        };
      },
    );
    const scopeHash = readinessHash({
      caseId: e.id,
      scopeRevision: revision,
      caseType: e.data.caseType,
      brief: e.data.brief,
      acceptanceCriteria: e.data.acceptanceCriteria,
      dueDate: e.data.dueDate ?? null,
      personId: e.data.personId ?? null,
      employmentEpisodeId: e.data.employmentEpisodeId ?? null,
      employmentStartDate: e.data.employmentStartDate ?? null,
      employmentKind: e.data.employmentKind ?? null,
      profileVersion: e.data.profileVersion ?? null,
      ownerPrincipalId: e.data.ownerPrincipalId ?? null,
      processTemplateSnapshot: e.data.processTemplateSnapshot ?? null,
      ...(e.data.laboratoryContext
        ? { laboratoryContext: e.data.laboratoryContext }
        : {}),
      requirements: requirements.map(
        ({
          id,
          key,
          title,
          kind,
          required,
          personId,
          employmentEpisodeId,
          expected,
        }) => ({
          id,
          key,
          title,
          kind,
          required,
          personId,
          employmentEpisodeId,
          expected,
        }),
      ),
      tasks: tasks.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.kind,
        required: r.required,
        dueDate: r.due_date,
        dependsOn: JSON.parse(String(r.depends_on_json)),
        requirementKeys: JSON.parse(String(r.requirement_keys_json)),
      })),
    });
    const bindingsHash = readinessHash(bindings);
    const latest = this.db
      .prepare(
        "SELECT * FROM ops_acceptances WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(tenant, e.id, revision) as Row | undefined;
    const ready =
      !taskBlockers.length &&
      assessments.every((r) => !r.required || r.status === "satisfied");
    const acceptanceCurrent = Boolean(
      ready &&
      latest?.decision === "accepted" &&
      latest.contract_version === "p03" &&
      latest.scope_hash === scopeHash &&
      latest.bindings_hash === bindingsHash &&
      latest.person_id === (e.data.personId ?? null) &&
      latest.employment_episode_id === (e.data.employmentEpisodeId ?? null),
    );
    return {
      caseId: e.id,
      scopeRevision: revision,
      scopeHash,
      bindingsHash,
      ready,
      requirements: assessments,
      taskBlockers,
      acceptanceCurrent,
      contractVersion: "p03",
      bindings,
    };
  }
}
