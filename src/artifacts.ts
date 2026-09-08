import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, lstatSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DomainError, type Principal, type JsonObject } from "./contracts.js";
import { WorkspaceStore } from "./workspace.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const md = (value: unknown) =>
  String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "");
export interface Artifact {
  filename: string;
  contentType: string;
  body: string;
  sha256: string;
  manifest: {
    formatVersion: 1;
    tenantId: string;
    entityId: string;
    entityVersion: number;
    sha256: string;
    bytes: number;
  };
}
/** Exports are derived from an authorized immutable snapshot, with no external URLs fetched. */
export function exportArtifact(
  workspace: WorkspaceStore,
  p: Principal,
  module: "documents" | "cases",
  id: string,
): Artifact {
  const entity = workspace.get(p, module, id);
  let body: string, filename: string, contentType: string;
  if (module === "documents") {
    const readiness = workspace.documentReadiness(p, id);
    if (!readiness.integrity)
      throw new DomainError(
        "DOCUMENT_INTEGRITY_FAILED",
        "Treść i kontekst dokumentu nie odpowiadają historii.",
        409,
      );
    if (entity.status === "approved" && !readiness.approvalCurrent)
      throw new DomainError(
        "DOCUMENT_APPROVAL_STALE",
        "Akceptacja nie odpowiada bieżącym źródłom. Przygotuj nową rewizję przed eksportem zatwierdzonego dokumentu.",
        409,
      );
    body = `# ${md(entity.title)}\n\nStatus: ${md(entity.status)} · wersja rekordu ${entity.version} · rewizja ${md(entity.data.revision ?? 1)}\n\n${String(entity.data.content)}\n\n---\n\nŹródła (wersja i data odczytu):\n${JSON.stringify(entity.data.sources ?? [], null, 2)}\n`;
    filename = `document-${id}-v${entity.version}.md`;
    contentType = "text/markdown; charset=utf-8";
  } else {
    if (entity.status !== "accepted")
      throw new DomainError(
        "CASE_NOT_ACCEPTED",
        "Pakiet wymaga odbioru aktualnej wersji sprawy.",
        409,
      );
    const readiness = workspace.readiness(p, id);
    if (!readiness.acceptanceCurrent)
      throw new DomainError(
        "CASE_ACCEPTANCE_STALE",
        "Dowody albo zakres odbioru nie są aktualne. Sprawdź gotowość sprawy przed eksportem pakietu.",
        409,
      );
    body =
      JSON.stringify(
        {
          format: "jarvis-case-package",
          formatVersion: 1,
          case: entity,
          readiness,
          settlement: entity.data.settlementDraft ?? null,
          financialPosting: false,
          paymentExecuted: false,
        },
        null,
        2,
      ) + "\n";
    filename = `case-${id}-v${entity.version}.json`;
    contentType = "application/json; charset=utf-8";
  }
  const sha256 = digest(body);
  return {
    filename,
    contentType,
    body,
    sha256,
    manifest: {
      formatVersion: 1,
      tenantId: p.tenantId,
      entityId: id,
      entityVersion: entity.version,
      sha256,
      bytes: Buffer.byteLength(body),
    },
  };
}
export function materializeArtifact(dataDir: string, artifact: Artifact) {
  const root = lstatSync(dataDir);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Unsafe evidence root");
  const directory = resolve(
    dataDir,
    "evidence",
    "exports",
    digest(artifact.manifest.tenantId),
  );
  // Every managed directory component must be a real directory, never an external symlink.
  let current = resolve(dataDir);
  for (const part of [
    "evidence",
    "exports",
    digest(artifact.manifest.tenantId),
  ]) {
    current = join(current, part);
    mkdirSync(current, { recursive: true, mode: 0o700 });
    if (lstatSync(current).isSymbolicLink())
      throw new Error("Unsafe evidence directory");
  }
  for (const [name, content] of [
    [artifact.filename, artifact.body],
    [
      `${artifact.filename}.manifest.json`,
      JSON.stringify(artifact.manifest, null, 2) + "\n",
    ],
  ]) {
    const path = join(directory, name!);
    try {
      writeFileSync(path, content!, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (
        lstatSync(path).isSymbolicLink() ||
        readFileSync(path, "utf8") !== content
      )
        throw new DomainError(
          "ARTIFACT_CONFLICT",
          "Zapisany artefakt nie odpowiada sumie kontrolnej.",
          409,
        );
    }
  }
}
export const documentTemplates = [
  { id: "case_scope", label: "Uzgodniony zakres sprawy", module: "cases" },
  { id: "case_brief", label: "Karta sprawy", module: "cases" },
  { id: "asset_report", label: "Protokół wyposażenia", module: "assets" },
  { id: "sales_offer", label: "Podsumowanie oferty", module: "sales" },
  {
    id: "purchase_request",
    label: "Zapotrzebowanie zakupowe",
    module: "purchases",
  },
] as const;
export function prepareDocument(
  workspace: WorkspaceStore,
  p: Principal,
  templateId: string,
  sourceId: string,
): JsonObject {
  const template = documentTemplates.find((t) => t.id === templateId);
  if (!template) throw new DomainError("UNKNOWN_TEMPLATE", "Nieznany szablon.");
  const source = workspace.get(p, template.module, sourceId);
  if (template.id === "case_scope") {
    const scope = workspace.documentScope(p, sourceId);
    const s = scope.snapshot;
    const content = `# Uzgodniony zakres sprawy\n\n${md(source.title)}\n\nRewizja zakresu: ${scope.version}.\n\n## Zakres\n\n${String(s.brief)}\n\n## Kryteria odbioru\n\n${String(s.acceptanceCriteria)}\n\n## Termin\n\n${s.dueDate ?? "Brak terminu — wymaga ustalenia."}\n\n## Powiązania i wymagania\n\n${JSON.stringify({ personId: s.personId, employmentEpisodeId: s.employmentEpisodeId, employmentStartDate: s.employmentStartDate, employmentKind: s.employmentKind, requirements: s.requirements }, null, 2)}\n\nRaport opisuje uzgodniony zakres. Wykonanie, dowody i odbiór są sprawdzane osobno. Ten raport nie stanowi umowy.`;
    return {
      title: `${template.label}: ${source.title}`.slice(0, 160),
      data: {
        accessScope: ["onboarding", "offboarding"].includes(
          String(source.data.caseType),
        )
          ? "people"
          : "documents",
        documentType: "report",
        linkedCaseId: source.id,
        content,
        sources: [JSON.parse(JSON.stringify(scope.source))],
      },
    };
  }
  const fields: Record<string, string[]> = {
    cases: [
      "brief",
      "acceptanceCriteria",
      "dueDate",
      "scopeRevision",
      "tasks",
      "worklogs",
    ],
    assets: [
      "assetType",
      "serial",
      "location",
      "condition",
      "handover",
      "reservation",
    ],
    sales: [
      "organizationName",
      "scope",
      "value",
      "currency",
      "acceptance",
      "nextStep",
    ],
    purchases: [
      "description",
      "quantity",
      "budgetAmount",
      "currency",
      "expectedDelivery",
      "delivery",
    ],
  };
  const content = `# ${template.label}: ${md(source.title)}\n\nŹródło: ${source.module}/${source.id}, wersja ${source.version}, odczyt ${source.updatedAt}.\nStatus: ${source.status}.\n\n${fields[source.module]!.map((key) => `## ${key}\n\n${source.data[key] === undefined ? "Brak danych — wymaga uzupełnienia." : JSON.stringify(source.data[key], null, 2)}`).join("\n\n")}\n\nMateriał przygotowany z lokalnej ewidencji. Wymaga kontroli i akceptacji człowieka.`;
  const accessScope =
    source.module === "sales"
      ? "sales"
      : source.module === "cases" &&
          ["onboarding", "offboarding"].includes(String(source.data.caseType))
        ? "people"
        : "documents";
  return {
    title: `${template.label}: ${source.title}`.slice(0, 160),
    data: {
      accessScope,
      documentType: source.module === "sales" ? "offer" : "report",
      content,
      sources: [
        {
          module: source.module,
          id: source.id,
          version: source.version,
          observedAt: new Date().toISOString(),
        },
      ],
      ...(source.module === "cases" ? { linkedCaseId: source.id } : {}),
    },
  };
}
