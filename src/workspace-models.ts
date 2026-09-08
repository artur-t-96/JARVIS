import { z } from "zod";
import { caseRequirementDefinitionsSchema } from "./case-readiness.js";

export interface WorkspaceField {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "select" | "boolean";
  required?: boolean;
  options?: string[];
}
export interface WorkspaceAction {
  id: string;
  label: string;
  fields?: WorkspaceField[];
}
export interface ModuleDefinition {
  id: string;
  label: string;
  description: string;
  fields: WorkspaceField[];
  actions: WorkspaceAction[];
}
const text = z.string().trim().min(1).max(2000);
const short = z.string().trim().min(1).max(200);
const id = z.string().uuid();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Niepoprawna data kalendarzowa");
const optionalText = z.string().trim().max(2000).optional();
const email = z.string().email().max(254).optional();
const money = z.number().finite().min(0).max(1_000_000_000);
const integer = z.number().int().min(1).max(100_000);
const yes = z.literal(true);
export const principalIdSchema = z.string().trim().min(1).max(200);
export const engagementRefSchema = z
  .object({ module: z.enum(["sales", "cases"]), id })
  .strict();
export type EngagementRef = z.infer<typeof engagementRefSchema>;
export const employmentPolicySchema = z
  .object({
    mode: z.enum(["single_open", "parallel_projects"]),
    maxConcurrent: z.number().int().min(1).max(20),
    allowInternalOverlap: z.literal(false),
  })
  .strict()
  .refine(
    (policy) => policy.mode !== "single_open" || policy.maxConcurrent === 1,
    "Pojedyncza współpraca wymaga limitu 1.",
  );
export type EmploymentPolicy = z.infer<typeof employmentPolicySchema>;
export const defaultEmploymentPolicy: EmploymentPolicy = {
  mode: "single_open",
  maxConcurrent: 1,
  allowInternalOverlap: false,
};
const episodeInput = {
  employmentEpisodeId: id,
  expectedEpisodeVersion: z.number().int().positive(),
};
const resourceEpisodeInput = {
  personId: id,
  ...episodeInput,
  caseId: id.optional(),
  profileVersion: z.number().int().min(0).optional(),
};

export const taskKindSchema = z.enum([
  "information",
  "decision",
  "work",
  "attestation",
]);
export const taskStatusSchema = z.enum([
  "unassigned",
  "offered",
  "accepted",
  "declined",
  "completed",
  "cancelled",
]);
export const taskRoleSchema = z.enum(["hr", "it", "manager"]);
export const roleBindingsSchema = z
  .object({
    hr: principalIdSchema.optional(),
    it: principalIdSchema.optional(),
    manager: principalIdSchema.optional(),
  })
  .strict();
const templateKey = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);
export const processTemplateTaskSchema = z
  .object({
    key: templateKey,
    title: short,
    required: z.boolean(),
    offsetDays: z.number().int().min(-365).max(365),
    dependsOn: z.array(templateKey).max(30),
    assigneeRole: taskRoleSchema,
    kind: taskKindSchema,
    requirementKeys: z.array(templateKey).max(30),
  })
  .strict();
export const processTemplateSchema = z
  .array(processTemplateTaskSchema)
  .min(1)
  .max(30)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (const [index, task] of tasks.entries()) {
      if (
        seen.has(task.key) ||
        new Set(task.dependsOn).size !== task.dependsOn.length ||
        task.dependsOn.some((key) => !seen.has(key)) ||
        new Set(task.requirementKeys).size !== task.requirementKeys.length
      )
        context.addIssue({
          code: "custom",
          message:
            "Unikalne klucze i wymagania; zależności wskazują wcześniejsze zadania.",
          path: [index],
        });
      seen.add(task.key);
    }
    if (!tasks.some((task) => task.required))
      context.addIssue({
        code: "custom",
        message: "Szablon wymaga obowiązkowego zadania.",
      });
  });
export const processTemplatesSchema = z
  .object({
    onboarding: processTemplateSchema,
    offboarding: processTemplateSchema,
  })
  .strict();
export type TaskKind = z.infer<typeof taskKindSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskRole = z.infer<typeof taskRoleSchema>;
export type RoleBindings = z.infer<typeof roleBindingsSchema>;
/** Draft defaults only. A saved company profile still needs explicit Core approval. */
export function baselineProcessTemplates(
  kind: "internal" | "contractor",
): z.infer<typeof processTemplatesSchema> {
  const contractor = kind === "contractor";
  return {
    onboarding: [
      {
        key: "documents",
        title: contractor
          ? "Potwierdź dokumenty współpracy konsultanta"
          : "Potwierdź dokumenty pracownika",
        required: true,
        offsetDays: contractor ? -3 : -1,
        dependsOn: [],
        assigneeRole: "hr",
        kind: "work",
        requirementKeys: ["documents"],
      },
      {
        key: "equipment",
        title: contractor
          ? "Przygotuj uzgodniony sprzęt konsultanta"
          : "Przygotuj sprzęt pracownika",
        required: true,
        offsetDays: contractor ? -2 : -1,
        dependsOn: [],
        assigneeRole: "it",
        kind: "work",
        requirementKeys: ["equipment"],
      },
      {
        key: "access",
        title: contractor
          ? "Potwierdź uzgodnione dostępy konsultanta"
          : "Potwierdź wymagane dostępy pracownika",
        required: true,
        offsetDays: 0,
        dependsOn: ["documents"],
        assigneeRole: "it",
        kind: "attestation",
        requirementKeys: ["access"],
      },
      {
        key: "readiness",
        title: contractor
          ? "Oceń gotowość konsultanta do współpracy"
          : "Oceń gotowość pracownika do rozpoczęcia",
        required: true,
        offsetDays: 0,
        dependsOn: ["documents", "equipment", "access"],
        assigneeRole: "manager",
        kind: "decision",
        requirementKeys: ["documents", "equipment", "access"],
      },
    ],
    offboarding: [
      {
        key: "handover",
        title: "Przekaż obowiązki i materiały",
        required: true,
        offsetDays: contractor ? -3 : -1,
        dependsOn: [],
        assigneeRole: "manager",
        kind: "work",
        requirementKeys: [],
      },
      {
        key: "resources",
        title: "Rozlicz sprzęt i potwierdź cofnięcie dostępów",
        required: true,
        offsetDays: 0,
        dependsOn: [],
        assigneeRole: "it",
        kind: "attestation",
        requirementKeys: [],
      },
      {
        key: "closure",
        title: contractor
          ? "Oceń zakończenie współpracy konsultanta"
          : "Oceń zakończenie zatrudnienia",
        required: true,
        offsetDays: 0,
        dependsOn: ["handover", "resources"],
        assigneeRole: "hr",
        kind: "decision",
        requirementKeys: [],
      },
    ],
  };
}
export const documentSourceSchema = z
  .object({
    module: z.enum([
      "people",
      "cases",
      "assets",
      "purchases",
      "licenses",
      "sales",
      "recruitment",
      "documents",
      "it",
    ]),
    id,
    version: z.number().int().min(1),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const createDataSchemas = {
  people: z
    .object({
      email,
      personCategory: z.enum(["internal", "contractor"]),
      department: optionalText,
      jobTitle: optionalText,
    })
    .strict(),
  cases: z
    .object({
      requirements: caseRequirementDefinitionsSchema.optional(),
      caseType: z.enum([
        "general",
        "onboarding",
        "offboarding",
        "procurement",
        "delivery",
        "it",
      ]),
      brief: text,
      acceptanceCriteria: text,
      dueDate: date.optional(),
      personId: id.optional(),
      employmentEpisodeId: id.optional(),
      ownerId: id.optional(),
    })
    .strict(),
  assets: z
    .object({
      assetType: z.enum(["laptop", "phone", "monitor", "other"]),
      serial: short,
      location: short,
      condition: z.enum(["good", "repair"]),
    })
    .strict(),
  purchases: z
    .object({
      kind: z.enum(["supplier", "order"]),
      supplierId: id.optional(),
      description: text,
      quantity: integer.optional(),
      budgetAmount: money.optional(),
      currency: z.enum(["PLN", "EUR", "USD"]).optional(),
      expectedDelivery: date.optional(),
      supplierEmail: email,
    })
    .strict(),
  licenses: z
    .object({
      product: short,
      totalSeats: integer,
      expiresOn: date.optional(),
      supplierId: id.optional(),
    })
    .strict(),
  sales: z
    .object({
      kind: z.enum(["client", "deal", "offer"]),
      organizationName: short,
      parentId: id.optional(),
      contactEmail: email,
      value: money.optional(),
      currency: z.enum(["PLN", "EUR", "USD"]).optional(),
      scope: optionalText,
    })
    .strict(),
  recruitment: z
    .object({
      kind: z.enum(["vacancy", "application"]),
      employmentKind: z.enum(["internal", "contractor"]),
      personId: id.optional(),
      vacancyId: id.optional(),
      description: text,
      requirements: optionalText,
    })
    .strict(),
  documents: z
    .object({
      accessScope: z.enum(["people", "sales", "it", "documents"]),
      sources: z.array(documentSourceSchema).max(20).optional(),
      documentType: z.enum(["policy", "contract", "offer", "report", "other"]),
      content: z.string().trim().min(1).max(50_000),
      ownerId: id.optional(),
      linkedCaseId: id.optional(),
    })
    .strict(),
  it: z
    .object({
      kind: z.enum(["observation", "incident", "lab_case"]),
      description: text,
      severity: z.enum(["low", "medium", "high", "critical"]),
      environment: z.enum(["local", "lab"]),
      relatedAssetId: id.optional(),
    })
    .strict(),
};
export type ModuleId = keyof typeof createDataSchemas;
export type DomainCreateData = {
  [M in ModuleId]: z.infer<(typeof createDataSchemas)[M]>;
};
export const moduleIds = Object.keys(createDataSchemas) as ModuleId[];
const base = { id, expectedVersion: z.number().int().min(1) };
const allocationInput = {
  allocationId: id,
  expectedAllocationVersion: z.number().int().positive(),
};
const custodyEpisodeInput = { ...resourceEpisodeInput, caseId: id };
const taskCustodyInput = {
  ...base,
  ...allocationInput,
  ...custodyEpisodeInput,
  taskId: id,
  expectedTaskVersion: z.number().int().positive(),
  expectedCaseVersion: z.number().int().positive(),
  scopeRevision: z.number().int().positive(),
  scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
  allocationCaseId: id,
};
const issueAttestation = {
  issuedOn: date,
  location: short,
  condition: z.enum(["good", "repair"]),
  handoverNote: text,
  humanConfirmed: yes,
};
const returnAttestation = {
  returnedOn: date,
  location: short,
  condition: z.enum(["good", "repair"]),
  receiptNote: text,
  humanConfirmed: yes,
};
export const actionSchemas: Record<ModuleId, Record<string, z.ZodType>> = {
  people: {
    startEmployment: z
      .object({
        ...base,
        employmentKind: z.enum(["internal", "contractor"]),
        engagementRef: engagementRefSchema.optional(),
        profileVersion: z.number().int().min(0).optional(),
        startDate: date,
        role: short,
        humanDecision: yes,
      })
      .strict(),
    activate: z
      .object({ ...base, ...episodeInput, humanDecision: yes })
      .strict(),
    beginOffboarding: z
      .object({
        ...base,
        ...episodeInput,
        profileVersion: z.number().int().min(0).optional(),
        endDate: date,
        reason: text,
        humanDecision: yes,
      })
      .strict(),
    endEmployment: z
      .object({
        ...base,
        ...episodeInput,
        endDate: date,
        reason: text,
        humanDecision: yes,
      })
      .strict(),
  },
  cases: {
    addWorklog: z
      .object({
        ...base,
        description: text,
        minutes: z.number().int().min(0).max(1_000_000),
        performedOn: date,
        amount: money.multipleOf(0.01).optional(),
        currency: z.enum(["PLN", "EUR", "USD"]).optional(),
      })
      .strict()
      .refine(
        (v) => (v.amount === undefined) === (v.currency === undefined),
        "Kwota wymaga waluty",
      )
      .refine(
        (v) => v.minutes > 0 || (v.amount ?? 0) > 0,
        "Podaj czas albo koszt",
      ),
    revise: z
      .object({
        ...base,
        brief: text,
        acceptanceCriteria: text,
        reason: text,
        dueDate: date.optional(),
        startDate: date.optional(),
        profileVersion: z.number().int().min(0).optional(),
        expectedEpisodeVersion: z.number().int().positive().optional(),
        ownerPrincipalId: principalIdSchema.optional(),
        requirements: caseRequirementDefinitionsSchema.optional(),
      })
      .strict(),
    addTask: z
      .object({
        ...base,
        title: short,
        assigneeId: id.optional(),
        assigneePrincipalId: principalIdSchema.nullable().optional(),
        profileVersion: z.number().int().min(0).optional(),
        assigneeRole: taskRoleSchema.optional(),
        kind: taskKindSchema,
        required: z.boolean(),
        dueDate: date.optional(),
        dependsOn: z.array(id).max(50).optional(),
      })
      .strict(),
    completeTask: z
      .object({
        ...base,
        taskId: id,
        expectedTaskVersion: z.number().int().min(1),
        evidenceNote: text,
        humanConfirmed: yes,
      })
      .strict(),
    acceptTask: z
      .object({
        ...base,
        taskId: id,
        expectedTaskVersion: z.number().int().min(1),
        humanConfirmed: yes,
      })
      .strict(),
    declineTask: z
      .object({
        ...base,
        taskId: id,
        expectedTaskVersion: z.number().int().min(1),
        reason: text,
        humanConfirmed: yes,
      })
      .strict(),
    transferTask: z
      .object({
        ...base,
        taskId: id,
        expectedTaskVersion: z.number().int().min(1),
        assigneePrincipalId: principalIdSchema,
        reason: text,
        humanConfirmed: yes,
      })
      .strict(),
    cancelTask: z
      .object({
        ...base,
        taskId: id,
        expectedTaskVersion: z.number().int().min(1),
        reason: text,
        humanConfirmed: yes,
      })
      .strict(),
    bindEvidence: z
      .object({
        ...base,
        requirementId: id,
        sourceModule: z.enum([
          "assets",
          "documents",
          "licenses",
          "purchases",
          "it",
        ]),
        sourceId: id,
        sourceVersion: z.number().int().min(1),
        allocationId: id.optional(),
        issueEventId: id.optional(),
      })
      .strict(),
    addEvidence: z
      .object({
        ...base,
        title: short,
        reference: short,
        note: text,
        humanConfirmed: yes,
      })
      .strict(),
    submit: z.object(base).strict(),
    accept: z
      .object({
        ...base,
        decision: z.enum(["accepted", "rejected"]),
        note: text,
        humanDecision: yes,
      })
      .strict(),
    cancel: z.object({ ...base, reason: text }).strict(),
  },
  assets: {
    reserve: z
      .object({ ...base, ...custodyEpisodeInput, purpose: text, until: date })
      .strict(),
    issue: z
      .object({
        ...base,
        ...allocationInput,
        ...custodyEpisodeInput,
        ...issueAttestation,
      })
      .strict(),
    return: z
      .object({ ...base, ...allocationInput, ...returnAttestation })
      .strict(),
    release: z.object({ ...base, ...allocationInput, reason: text }).strict(),
    expireReservation: z
      .object({ ...base, ...allocationInput, reason: text })
      .strict(),
    issueForTask: z
      .object({ ...taskCustodyInput, ...issueAttestation })
      .strict(),
    returnForTask: z
      .object({ ...taskCustodyInput, ...returnAttestation })
      .strict(),
    bindAssetForTask: z
      .object({ ...taskCustodyInput, requirementId: id, issueEventId: id })
      .strict(),
    markRepaired: z
      .object({ ...base, note: text, humanConfirmed: yes })
      .strict(),
  },
  purchases: {
    placeOrder: z.object(base).strict(),
    acknowledge: z
      .object({
        ...base,
        supplierReference: short,
        acknowledgedOn: date,
        evidenceNote: text,
        humanConfirmed: yes,
      })
      .strict(),
    recordDelivery: z
      .object({
        ...base,
        quantityReceived: integer,
        receivedOn: date,
        deliveryNote: text,
        humanConfirmed: yes,
      })
      .strict(),
    cancel: z.object({ ...base, reason: text }).strict(),
    deactivate: z.object({ ...base, reason: text }).strict(),
  },
  licenses: {
    assign: z.object({ ...base, ...resourceEpisodeInput, note: text }).strict(),
    revoke: z
      .object({ ...base, ...resourceEpisodeInput, reason: text })
      .strict(),
    resize: z.object({ ...base, totalSeats: integer }).strict(),
    renew: z
      .object({
        ...base,
        expiresOn: date,
        evidenceNote: text,
        humanConfirmed: yes,
      })
      .strict(),
  },
  sales: {
    qualify: z.object({ ...base, qualification: text }).strict(),
    submitOffer: z.object(base).strict(),
    acceptOffer: z
      .object({
        ...base,
        acceptedOn: date,
        acceptanceNote: text,
        humanDecision: yes,
      })
      .strict(),
    handoff: z
      .object({ ...base, acceptanceCriteria: text, ownerId: id.optional() })
      .strict(),
    lose: z.object({ ...base, reason: text, humanDecision: yes }).strict(),
  },
  recruitment: {
    screen: z
      .object({
        ...base,
        decision: z.enum(["advance", "reject"]),
        assessment: text,
        humanDecision: yes,
      })
      .strict(),
    interview: z
      .object({ ...base, assessment: text, humanDecision: yes })
      .strict(),
    makeOffer: z.object({ ...base, terms: text, startDate: date }).strict(),
    decide: z
      .object({
        ...base,
        decision: z.enum(["accepted", "rejected"]),
        reason: text,
        humanDecision: yes,
      })
      .strict(),
    hire: z
      .object({
        ...base,
        engagementRef: engagementRefSchema.optional(),
        profileVersion: z.number().int().min(0).optional(),
        startDate: date,
        role: short,
        humanDecision: yes,
      })
      .strict(),
    withdraw: z.object({ ...base, reason: text, humanDecision: yes }).strict(),
    close: z.object({ ...base, reason: text }).strict(),
  },
  documents: {
    revise: z
      .object({
        ...base,
        content: z.string().trim().min(1).max(50_000),
        changeNote: text,
      })
      .strict(),
    submit: z.object(base).strict(),
    approve: z
      .object({
        ...base,
        decision: z.enum(["approved", "rejected"]),
        note: text,
        humanDecision: yes,
      })
      .strict(),
    archive: z.object({ ...base, reason: text }).strict(),
  },
  it: {
    triage: z
      .object({ ...base, assessment: text, ownerId: id.optional() })
      .strict(),
    promoteIncident: z
      .object({
        ...base,
        description: text,
        severity: z.enum(["low", "medium", "high", "critical"]),
      })
      .strict(),
    recordAction: z
      .object({
        ...base,
        actionNote: text,
        evidenceNote: text,
        humanConfirmed: yes,
      })
      .strict(),
    resolve: z
      .object({
        ...base,
        resolution: text,
        evidenceNote: text,
        humanConfirmed: yes,
      })
      .strict(),
    reopen: z.object({ ...base, reason: text }).strict(),
  },
};
const f = (
  key: string,
  label: string,
  type: WorkspaceField["type"] = "text",
  required = true,
  options?: string[],
): WorkspaceField => ({
  key,
  label,
  type,
  required,
  ...(options ? { options } : {}),
});
const fields: Record<ModuleId, WorkspaceField[]> = {
  people: [
    f("email", "E-mail", "text", false),
    f("personCategory", "Rodzaj współpracy", "select", true, [
      "internal",
      "contractor",
    ]),
    f("department", "Dział", "text", false),
    f("jobTitle", "Rola", "text", false),
  ],
  cases: [
    f("caseType", "Typ sprawy", "select", true, [
      "general",
      "onboarding",
      "offboarding",
      "procurement",
      "delivery",
      "it",
    ]),
    f("brief", "Zakres", "textarea"),
    f("acceptanceCriteria", "Kryteria odbioru", "textarea"),
    f("dueDate", "Termin sprawy", "date", false),
    f("personId", "ID osoby (lifecycle)", "text", false),
    f("employmentEpisodeId", "ID okresu współpracy (lifecycle)", "text", false),
    f("ownerId", "ID właściciela", "text", false),
  ],
  assets: [
    f("assetType", "Typ sprzętu", "select", true, [
      "laptop",
      "phone",
      "monitor",
      "other",
    ]),
    f("serial", "Numer seryjny"),
    f("location", "Lokalizacja"),
    f("condition", "Stan", "select", true, ["good", "repair"]),
  ],
  purchases: [
    f("kind", "Rodzaj wpisu", "select", true, ["supplier", "order"]),
    f("supplierId", "ID dostawcy (wymagane dla zamówienia)", "text", false),
    f("description", "Opis", "textarea"),
    f("quantity", "Liczba sztuk (zamówienie)", "number", false),
    f("budgetAmount", "Budżet", "number", false),
    f("currency", "Waluta", "select", false, ["PLN", "EUR", "USD"]),
    f("expectedDelivery", "Planowana dostawa", "date", false),
    f("supplierEmail", "E-mail dostawcy", "text", false),
  ],
  licenses: [
    f("product", "Produkt"),
    f("totalSeats", "Liczba stanowisk", "number"),
    f("expiresOn", "Ważna do", "date", false),
    f("supplierId", "ID dostawcy", "text", false),
  ],
  sales: [
    f("kind", "Rodzaj wpisu", "select", true, ["client", "deal", "offer"]),
    f("organizationName", "Firma"),
    f(
      "parentId",
      "ID klienta / szansy (wymagane dla deal/offer)",
      "text",
      false,
    ),
    f("contactEmail", "E-mail kontaktowy", "text", false),
    f("value", "Wartość", "number", false),
    f("currency", "Waluta", "select", false, ["PLN", "EUR", "USD"]),
    f("scope", "Zakres oferty", "textarea", false),
  ],
  recruitment: [
    f("kind", "Rodzaj wpisu", "select", true, ["vacancy", "application"]),
    f("employmentKind", "Rodzaj zatrudnienia", "select", true, [
      "internal",
      "contractor",
    ]),
    f("personId", "ID osoby (aplikacja)", "text", false),
    f("vacancyId", "ID rekrutacji (aplikacja)", "text", false),
    f("description", "Opis", "textarea"),
    f("requirements", "Wymagania", "textarea", false),
  ],
  documents: [
    f("accessScope", "Obszar dostępu", "select", true, [
      "people",
      "sales",
      "it",
      "documents",
    ]),
    f("documentType", "Typ", "select", true, [
      "policy",
      "contract",
      "offer",
      "report",
      "other",
    ]),
    f("content", "Treść dokumentu", "textarea"),
    f("ownerId", "ID właściciela", "text", false),
    f("linkedCaseId", "ID powiązanej sprawy", "text", false),
  ],
  it: [
    f("kind", "Rodzaj wpisu", "select", true, [
      "observation",
      "incident",
      "lab_case",
    ]),
    f("description", "Opis", "textarea"),
    f("severity", "Ważność", "select", true, [
      "low",
      "medium",
      "high",
      "critical",
    ]),
    f("environment", "Środowisko", "select", true, ["local", "lab"]),
    f("relatedAssetId", "ID sprzętu", "text", false),
  ],
};
const actionLabels: Record<string, string> = {
  startEmployment: "Rozpocznij okres współpracy",
  activate: "Potwierdź rozpoczęcie pracy",
  beginOffboarding: "Rozpocznij offboarding",
  endEmployment: "Potwierdź zakończenie współpracy",
  revise: "Utwórz nową rewizję",
  addTask: "Dodaj zadanie człowieka",
  completeTask: "Potwierdź wykonanie zadania",
  acceptTask: "Przyjmij zadanie",
  declineTask: "Odmów przyjęcia zadania",
  transferTask: "Przekaż zadanie do przyjęcia",
  cancelTask: "Anuluj zadanie",
  addEvidence: "Dodaj dowód człowieka",
  bindEvidence: "Powiąż dowód wymagania",
  addWorklog: "Zarejestruj czas lub koszt",
  submit: "Przekaż do odbioru",
  accept: "Decyzja odbioru",
  cancel: "Anuluj",
  reserve: "Zarezerwuj",
  issue: "Potwierdź wydanie",
  return: "Potwierdź zwrot",
  release: "Zwolnij rezerwację",
  expireReservation: "Zwolnij wygasłą rezerwację",
  issueForTask: "Poświadcz wydanie w zadaniu IT",
  returnForTask: "Poświadcz zwrot w zadaniu IT",
  bindAssetForTask: "Powiąż poświadczone wydanie z wymaganiem",
  markRepaired: "Potwierdź naprawę",
  placeOrder: "Zatwierdź lokalne zamówienie",
  acknowledge: "Zarejestruj potwierdzenie dostawcy",
  recordDelivery: "Potwierdź odbiór dostawy",
  deactivate: "Wyłącz dostawcę",
  assign: "Zapisz przydział stanowiska",
  revoke: "Zakończ przydział stanowiska",
  resize: "Zmień liczbę stanowisk",
  renew: "Zarejestruj odnowienie",
  qualify: "Zakwalifikuj szansę",
  submitOffer: "Przekaż ofertę do decyzji",
  acceptOffer: "Zarejestruj akceptację oferty",
  handoff: "Przekaż do realizacji",
  lose: "Zamknij jako przegrane",
  screen: "Decyzja wstępnej oceny",
  interview: "Zapisz ocenę rozmowy",
  makeOffer: "Przygotuj ofertę współpracy",
  decide: "Decyzja kandydata",
  hire: "Zatwierdź rozpoczęcie współpracy",
  withdraw: "Wycofaj aplikację",
  close: "Zamknij rekrutację",
  approve: "Decyzja o wersji dokumentu",
  archive: "Archiwizuj",
  triage: "Przeprowadź triage",
  promoteIncident: "Utwórz incydent z obserwacji",
  recordAction: "Zarejestruj wykonane działanie lokalne",
  resolve: "Potwierdź rozwiązanie",
  reopen: "Otwórz ponownie",
};
const fieldLabels: Record<string, string> = {
  dueDate: "Termin wykonania",
  minutes: "Czas pracy w minutach",
  performedOn: "Data wykonania",
  amount: "Zadeklarowany koszt",
  currency: "Waluta",
  dependsOn: "Zadania wymagane wcześniej",
  humanDecision: "Potwierdzam decyzję człowieka",
  humanConfirmed: "Potwierdzam faktyczne wykonanie / otrzymanie dowodu",
  personId: "ID osoby",
  ownerId: "ID właściciela",
  assigneeId: "ID wykonawcy",
  assigneePrincipalId: "Konto wykonawcy",
  ownerPrincipalId: "Konto właściciela sprawy",
  employmentEpisodeId: "Okres współpracy",
  expectedEpisodeVersion: "Wersja okresu współpracy",
  engagementRef: "Uzgodniony projekt lub umowa",
  caseId: "Powiązana sprawa okresu",
  assigneeRole: "Odpowiedzialność w procesie",
  kind: "Rodzaj zadania",
  taskId: "ID zadania",
  employmentKind: "Rodzaj współpracy",
  startDate: "Data rozpoczęcia",
  endDate: "Data zakończenia",
  role: "Rola",
  reason: "Uzasadnienie",
  note: "Notatka",
  brief: "Zakres",
  acceptanceCriteria: "Kryteria odbioru",
  title: "Tytuł",
  required: "Zadanie obowiązkowe",
  reference: "Lokalna referencja dowodu (opis lub ścieżka)",
  evidenceNote: "Opis rzeczywistego dowodu",
  decision: "Decyzja",
  until: "Rezerwacja do",
  purpose: "Cel rezerwacji",
  issuedOn: "Data wydania",
  handoverNote: "Protokół wydania",
  allocationId: "Alokacja urządzenia",
  expectedAllocationVersion: "Wersja alokacji",
  issueEventId: "Zdarzenie poświadczonego wydania",
  allocationCaseId: "Sprawa pierwotnej alokacji",
  expectedCaseVersion: "Wersja sprawy",
  scopeRevision: "Rewizja zakresu",
  scopeHash: "Odcisk zakresu",
  location: "Lokalizacja po przekazaniu",
  returnedOn: "Data zwrotu",
  condition: "Stan",
  receiptNote: "Protokół zwrotu",
  supplierReference: "Numer potwierdzenia dostawcy",
  acknowledgedOn: "Data potwierdzenia",
  quantityReceived: "Odebrana ilość",
  receivedOn: "Data odbioru",
  deliveryNote: "Dowód dostawy",
  totalSeats: "Liczba stanowisk",
  expiresOn: "Ważna do",
  qualification: "Ocena szansy",
  acceptedOn: "Data akceptacji",
  acceptanceNote: "Dowód akceptacji",
  assessment: "Ocena człowieka",
  terms: "Warunki",
  content: "Treść nowej wersji",
  changeNote: "Opis zmiany",
  description: "Opis",
  severity: "Ważność",
  actionNote: "Opis wykonanego działania",
  resolution: "Rozwiązanie",
};
function actionFields(schema: z.ZodType): WorkspaceField[] {
  const json = z.toJSONSchema(schema) as {
    properties?: Record<
      string,
      { type?: string; enum?: string[]; const?: unknown }
    >;
    required?: string[];
  };
  return Object.entries(json.properties ?? {})
    .filter(
      ([key]) =>
        ![
          "id",
          "expectedVersion",
          "expectedTaskVersion",
          "profileVersion",
        ].includes(key),
    )
    .map(([key, value]) =>
      f(
        key,
        fieldLabels[key] ?? key,
        value.enum
          ? "select"
          : value.type === "boolean" || value.const === true
            ? "boolean"
            : value.type === "integer" || value.type === "number"
              ? "number"
              : /(Date|On)$/.test(key) || key === "until"
                ? "date"
                : [
                      "content",
                      "brief",
                      "acceptanceCriteria",
                      "description",
                      "evidenceNote",
                    ].includes(key)
                  ? "textarea"
                  : "text",
        (json.required ?? []).includes(key),
        value.enum,
      ),
    );
}
const labels: Record<ModuleId, [string, string]> = {
  people: [
    "Ludzie i współpraca",
    "Osoby oraz rozłączne okresy zatrudnienia wewnętrznego lub kontraktorskiego.",
  ],
  cases: [
    "Sprawy i odbiór",
    "Rewizje zakresu, zadania człowieka, dowody i jawny odbiór biznesowy.",
  ],
  assets: [
    "Sprzęt",
    "Rezerwacja, protokół wydania i zwrotu; jedna aktywna alokacja.",
  ],
  purchases: [
    "Zakupy i dostawcy",
    "Lokalna ewidencja zamówień: potwierdzenie dostawcy i odbiór to różne zdarzenia.",
  ],
  licenses: [
    "Licencje",
    "Lokalna ewidencja stanowisk i przydziałów. Nie nadaje kont u dostawcy.",
  ],
  sales: [
    "Sprzedaż",
    "Klienci, szanse, oferty i przekazanie zaakceptowanej oferty do realizacji.",
  ],
  recruitment: [
    "Rekrutacja",
    "Osobne wakaty i aplikacje; zatrudnienie zawsze po jawnej decyzji.",
  ],
  documents: ["Dokumenty", "Treść, kolejne wersje i odbiór konkretnej wersji."],
  it: [
    "IT i laboratorium",
    "Lokalne obserwacje, incydenty oraz dowody działań człowieka. Bez skanowania sieci.",
  ],
};
export function workspaceCatalog(): ModuleDefinition[] {
  return moduleIds.map((module) => ({
    id: module,
    label: labels[module][0],
    description: labels[module][1],
    fields: fields[module],
    actions: Object.entries(actionSchemas[module]).map(([id, schema]) => ({
      id,
      label: actionLabels[id] ?? id,
      fields: actionFields(schema),
    })),
  }));
}
