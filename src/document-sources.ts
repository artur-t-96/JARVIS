import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { DomainError, type JsonObject } from "./contracts.js";
import type { Entity } from "./workspace.js";
import type { DocumentFiles } from "./document-files.js";

const modules = [
  "people",
  "cases",
  "assets",
  "purchases",
  "licenses",
  "sales",
  "recruitment",
  "documents",
  "it",
] as const;
const common = {
  id: z.string().uuid(),
  version: z.number().int().positive(),
  observedAt: z.string().datetime({ offset: true }),
};
export const documentSourceSchema = z.union([
  z.object({ ...common, module: z.enum(modules) }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("case_scope"),
      module: z.literal("cases"),
      snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
export type DocumentSourceInput = z.infer<typeof documentSourceSchema>;
type Row = Record<string, unknown>;
type SourceReference = {
  module: string;
  id: string;
  version: number;
  kind?: string;
  currentVersion: number | null;
  current: boolean;
};
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
};
export const documentHash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function fail(code: string, message: string): never {
  throw new DomainError(code, message, 409);
}
const objects = (value: unknown): JsonObject[] =>
  Array.isArray(value) ? (value as JsonObject[]) : [];

export function migrateDocumentContext(db: DatabaseSync) {
  db.exec(`
    ALTER TABLE ops_document_versions ADD COLUMN context_json TEXT;
    ALTER TABLE ops_document_versions ADD COLUMN context_hash TEXT;
    ALTER TABLE ops_document_versions ADD COLUMN created_by TEXT;
    ALTER TABLE ops_document_versions ADD COLUMN created_at TEXT;
    ALTER TABLE ops_document_versions ADD COLUMN approved_by TEXT;
  `);
}

/** Scope sources intentionally exclude changing tasks, bindings and acceptance. */
export class DocumentSources {
  constructor(
    private readonly db: DatabaseSync,
    private readonly files?: DocumentFiles,
  ) {}
  private entity(tenant: string, module: string, id: string): Entity {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module=? AND id=?",
      )
      .get(tenant, module, id) as Row | undefined;
    if (!row)
      fail(
        "DOCUMENT_SOURCE_MISSING",
        "Brak źródła dokumentu w tej organizacji.",
      );
    const e: Entity = {
      id: String(row.id),
      module: row.module as Entity["module"],
      title: String(row.title),
      status: String(row.status),
      version: Number(row.version),
      data: JSON.parse(String(row.data_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    const snapshot = this.db
      .prepare(
        "SELECT snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, id, e.version) as Row | undefined;
    if (!snapshot || documentHash(e) !== snapshot.snapshot_hash)
      fail(
        "DOCUMENT_SOURCE_INCONSISTENT",
        "Zapis źródła nie odpowiada jego historii.",
      );
    return e;
  }
  scope(tenant: string, id: string) {
    const e = this.entity(tenant, "cases", id),
      d = e.data;
    const revision = Number(d.scopeRevision);
    if (!Number.isInteger(revision) || revision < 1)
      fail(
        "DOCUMENT_SCOPE_MISSING",
        "Sprawa nie ma zapisanej rewizji zakresu.",
      );
    const requirements = (
      this.db
        .prepare(
          "SELECT * FROM ops_case_requirements WHERE tenant_id=? AND case_id=? AND scope_revision=? ORDER BY requirement_key",
        )
        .all(tenant, id, revision) as Row[]
    ).map((r) => ({
      key: String(r.requirement_key),
      title: String(r.title),
      kind: String(r.kind),
      required: Boolean(r.required),
      personId: r.person_id ?? null,
      employmentEpisodeId: r.employment_episode_id ?? null,
      expected: JSON.parse(String(r.expected_json)),
    }));
    const snapshot = {
      format: "jarvis-case-scope",
      formatVersion: 1,
      tenantId: tenant,
      caseId: id,
      scopeRevision: revision,
      ...Object.fromEntries(
        [
          "caseType",
          "brief",
          "acceptanceCriteria",
          "dueDate",
          "personId",
          "employmentEpisodeId",
          "employmentStartDate",
          "employmentKind",
          "engagementRef",
          "profileVersion",
          "ownerPrincipalId",
        ].map((key) => [key, d[key] ?? null]),
      ),
      requirements,
    } as JsonObject;
    const history = objects(d.scopeHistory).find(
      (h) => h.revision === revision,
    );
    return {
      snapshot,
      version: revision,
      snapshotHash: documentHash(snapshot),
      updatedAt: String(history?.createdAt ?? e.createdAt),
      title: e.title,
      available: e.status !== "cancelled",
    };
  }
  request(tenant: string, input: JsonObject, now: string): DocumentSourceInput {
    if (input.kind === "case_scope") {
      const source = this.scope(tenant, String(input.id));
      return {
        kind: "case_scope",
        module: "cases",
        id: String(input.id),
        version: source.version,
        snapshotHash: source.snapshotHash,
        observedAt: now,
      };
    }
    const e = this.entity(tenant, String(input.module), String(input.id));
    return { module: e.module, id: e.id, version: e.version, observedAt: now };
  }
  capture(tenant: string, inputs: unknown, now: string): JsonObject[] {
    const requests = z
        .array(documentSourceSchema)
        .max(20)
        .parse(inputs ?? []),
      seen = new Set<string>();
    return requests.map((source) => {
      const key = `${"kind" in source ? source.kind : "entity"}:${source.module}:${source.id}`;
      if (seen.has(key))
        fail("DUPLICATE_SOURCE", "Źródło dokumentu się powtarza.");
      seen.add(key);
      const current =
        "kind" in source
          ? this.scope(tenant, source.id)
          : (() => {
              const e = this.entity(tenant, source.module, source.id);
              return {
                snapshot: e,
                version: e.version,
                snapshotHash: documentHash(e),
                updatedAt: e.updatedAt,
                available: true,
              };
            })();
      if (
        !current.available ||
        source.version !== current.version ||
        ("kind" in source && source.snapshotHash !== current.snapshotHash)
      )
        fail(
          "SOURCE_VERSION_CHANGED",
          "Źródło zmieniło zakres lub wersję. Przygotuj dokument ponownie.",
        );
      if (
        Date.parse(source.observedAt) > Date.parse(now) ||
        Date.parse(source.observedAt) < Date.parse(current.updatedAt)
      )
        fail(
          "INVALID_SOURCE_OBSERVATION",
          "Data odczytu źródła nie odpowiada zapisanej wersji.",
        );
      return {
        ...source,
        snapshotHash: current.snapshotHash,
        verifiedAt: now,
        snapshot: JSON.parse(canonical(current.snapshot)),
      };
    });
  }
  references(
    tenant: string,
    sources: JsonObject[],
    traversal = { visited: 0, path: new Set<string>() },
  ): SourceReference[] {
    return sources.map((source) => {
      const base = {
        module: String(source.module),
        id: String(source.id),
        version: Number(source.version),
        ...(source.kind === "case_scope" ? { kind: "case_scope" } : {}),
      };
      try {
        if (source.kind === "case_scope") {
          const current = this.scope(tenant, base.id);
          return {
            ...base,
            currentVersion: current.version,
            current:
              current.available &&
              current.version === source.version &&
              current.snapshotHash === source.snapshotHash &&
              documentHash(source.snapshot) === source.snapshotHash,
          };
        }
        const current = this.entity(tenant, base.module, base.id);
        let available = true;
        if (current.module === "documents") {
          // Files can become unavailable without changing the source record's version.
          // Propagate that fact through document sources, with a bounded traversal.
          if (++traversal.visited > 100 || traversal.path.has(current.id))
            available = false;
          else {
            traversal.path.add(current.id);
            const files = objects(current.data.files);
            available =
              this.integrity(tenant, current) &&
              (files.length === 0 ||
                (!!this.files &&
                  this.files
                    .assessment(tenant, current.id, files)
                    .every((f) => f.valid))) &&
              this.references(
                tenant,
                objects(current.data.sources),
                traversal,
              ).every((r) => r.current);
            traversal.path.delete(current.id);
          }
        }
        return {
          ...base,
          currentVersion: current.version,
          current:
            available &&
            current.version === source.version &&
            documentHash(current) === source.snapshotHash &&
            (source.snapshot === undefined ||
              documentHash(source.snapshot) === source.snapshotHash),
        };
      } catch {
        return { ...base, currentVersion: null, current: false };
      }
    });
  }
  context(e: Entity): JsonObject {
    return {
      contract: e.data.sourceContract === "p09a2" ? "p09a2" : "p09a1",
      title: e.title,
      accessScope: e.data.accessScope ?? null,
      documentType: e.data.documentType ?? null,
      ownerId: e.data.ownerId ?? null,
      linkedCaseId: e.data.linkedCaseId ?? null,
      sources: e.data.sources ?? [],
      ...(e.data.sourceContract === "p09a2"
        ? { files: e.data.files ?? [] }
        : {}),
    };
  }
  assertAcyclic(tenant: string, documentId: string, sources: JsonObject[]) {
    const visited = new Set<string>();
    const visit = (source: JsonObject) => {
      if (source.module !== "documents") return;
      const id = String(source.id);
      if (id === documentId)
        fail(
          "DOCUMENT_SOURCE_CYCLE",
          "Dokument nie może zależeć od siebie ani pośrednio od własnej historii.",
        );
      if (visited.has(id)) return;
      if (visited.size >= 100)
        fail(
          "DOCUMENT_SOURCE_GRAPH_LIMIT",
          "Zbyt wiele powiązanych dokumentów. Wybierz węższe źródło.",
        );
      visited.add(id);
      const e = this.entity(tenant, "documents", id);
      for (const child of [
        ...objects(e.data.sources),
        ...objects(e.data.versions).flatMap((v) =>
          objects((v.context as JsonObject | null)?.sources),
        ),
      ])
        visit(child);
    };
    sources.forEach(visit);
  }
  version(tenant: string, id: string, revision: number) {
    return this.db
      .prepare(
        "SELECT * FROM ops_document_versions WHERE tenant_id=? AND document_id=? AND revision=?",
      )
      .get(tenant, id, revision) as Row | undefined;
  }
  integrity(tenant: string, e: Entity): boolean {
    if (!["p09a1", "p09a2"].includes(String(e.data.sourceContract)))
      return true;
    const versions = this.db
      .prepare(
        "SELECT * FROM ops_document_versions WHERE tenant_id=? AND document_id=? ORDER BY revision",
      )
      .all(tenant, e.id) as Row[];
    if (versions.length !== Number(e.data.revision)) return false;
    const recorded = objects(e.data.versions);
    return versions.every((row, index) => {
      if (Number(row.revision) !== index + 1) return false;
      const saved = recorded.find((v) => v.revision === row.revision);
      if (
        !saved ||
        saved.content !== row.content ||
        saved.contentHash !== row.content_hash ||
        documentHash(String(row.content)) !== row.content_hash ||
        saved.status !== row.status ||
        saved.decidedBy !== row.decided_by ||
        saved.decisionNote !== row.decision_note ||
        saved.decidedAt !== row.decided_at
      )
        return false;
      if (row.context_json === null)
        return (
          Number(row.revision) < Number(e.data.revision) &&
          saved.context == null &&
          saved.contextHash == null &&
          saved.createdBy == null &&
          saved.createdAt == null
        ); // Only recorded historical revisions may lack provenance.
      let context: JsonObject;
      try {
        context = JSON.parse(String(row.context_json));
      } catch {
        return false;
      }
      if (
        !row.created_by ||
        !row.created_at ||
        documentHash(context) !== row.context_hash ||
        saved.contextHash !== row.context_hash ||
        canonical(saved.context) !== canonical(context) ||
        saved.createdBy !== row.created_by ||
        saved.createdAt !== row.created_at ||
        saved.approvedBy !== row.approved_by
      )
        return false;
      if (Number(row.revision) === Number(e.data.revision))
        return (
          String(row.content) === e.data.content &&
          documentHash(this.context(e)) === row.context_hash &&
          (e.status === "archived" || e.status === row.status)
        );
      return true;
    });
  }
  assessment(tenant: string, e: Entity) {
    const references = this.references(tenant, objects(e.data.sources));
    const row = this.version(tenant, e.id, Number(e.data.revision));
    const integrity = this.integrity(tenant, e),
      blockers: string[] = [];
    const attachments =
      this.files?.assessment(tenant, e.id, e.data.files ?? []) ??
      objects(e.data.files).map((f) => ({
        id: String(f.id),
        filename: String(f.filename),
        bytes: Number(f.bytes),
        sha256: String(f.sha256),
        valid: false,
      }));
    if (attachments.some((file) => !file.valid))
      blockers.push(
        "Co najmniej jeden załącznik jest niedostępny lub niezgodny z manifestem.",
      );
    if (
      !integrity ||
      !row ||
      documentHash(String(row.content)) !== row.content_hash ||
      row.content !== e.data.content
    )
      blockers.push(
        "Treść lub pochodzenie rewizji nie odpowiada zapisanej historii.",
      );
    if (!row?.context_hash)
      blockers.push(
        "Historyczna rewizja nie ma pełnego kontekstu źródeł. Utwórz jawną nową rewizję.",
      );
    if (references.some((r) => !r.current))
      blockers.push(
        "Co najmniej jedno źródło jest nieaktualne lub niedostępne.",
      );
    if (e.data.linkedCaseId) {
      try {
        const source = this.entity(
          tenant,
          "cases",
          String(e.data.linkedCaseId),
        );
        if (
          source.data.caseType === "onboarding" &&
          !objects(e.data.sources).some(
            (s) =>
              s.kind === "case_scope" &&
              s.id === source.id &&
              s.version === source.data.scopeRevision &&
              (s.snapshot as JsonObject)?.personId === source.data.personId &&
              (s.snapshot as JsonObject)?.employmentEpisodeId ===
                source.data.employmentEpisodeId,
          )
        )
          blockers.push(
            "Dokument onboardingu wymaga źródła uzgodnionego zakresu tej sprawy i współpracy.",
          );
        if (source.status === "cancelled")
          blockers.push("Powiązana sprawa jest anulowana.");
      } catch {
        blockers.push("Powiązana sprawa jest niedostępna.");
      }
    }
    const ready = blockers.length === 0;
    return {
      documentId: e.id,
      entityVersion: e.version,
      revision: Number(e.data.revision),
      contract: row?.context_hash ? String(e.data.sourceContract) : "legacy",
      integrity,
      references,
      attachments,
      blockers,
      readyForReview: ready,
      approvalCurrent:
        ready &&
        e.status === "approved" &&
        row?.status === "approved" &&
        !!row.decided_by &&
        !!row.approved_by,
      contentHash: row?.content_hash ? String(row.content_hash) : null,
      contextHash: row?.context_hash ? String(row.context_hash) : null,
    };
  }
  assertReady(tenant: string, e: Entity) {
    const state = this.assessment(tenant, e);
    if (!state.readyForReview)
      fail("DOCUMENT_NOT_READY", state.blockers.join(" "));
  }
}
