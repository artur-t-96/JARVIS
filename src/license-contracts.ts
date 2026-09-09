import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "./contracts.js";
import { hash } from "./engine.js";
import {
  licenseContractActions,
  licenseTermsSchema,
  type LicenseTerms,
} from "./license-models.js";
import type { Entity } from "./workspace.js";

export interface LicenseServices {
  ctx: ToolContext;
  now: string;
  day: string;
  principal(id: string): Principal | undefined;
  save(entity: Entity): Entity;
  insert(title: string, data: JsonObject, status: string): Entity;
}
const obj = (v: unknown) => v as JsonObject;
const termKind = "license_terms";
export const licenseDocumentKey = (value: string) =>
  value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
const termsHash = (e: Entity) =>
  hash({
    licenseId: e.data.licenseId,
    baseTermsId: e.data.baseTermsId,
    terms: e.data.terms,
  });
function fail(
  message: string,
  code = "LICENSE_TERMS_CONFLICT",
  status = 409,
): never {
  throw new DomainError(code, message, status);
}
export function licenseAuthority(s: LicenseServices) {
  for (const [id, role] of [
    [s.ctx.actorId, "operator"],
    [s.ctx.approvedBy, "approver"],
  ] as const) {
    const p = id ? s.principal(id) : undefined;
    if (
      !p ||
      !p.roles.includes(role) ||
      !["licenses", "purchases"].every((scope) =>
        p.scopes?.some((v) => v === "*" || v === scope),
      )
    )
      fail(
        "Warunki licencji wymagają aktywnego operatora i zatwierdzającego z dostępem do licencji oraz zakupów.",
        "LICENSE_AUTHORITY_REQUIRED",
        403,
      );
  }
}
export function migrateLicenseContracts(db: DatabaseSync) {
  db.exec(`CREATE INDEX ops_license_terms_pool ON ops_entities(tenant_id,json_extract(data_json,'$.licenseId'))
    WHERE module='licenses' AND json_extract(data_json,'$.kind')='license_terms';
    CREATE UNIQUE INDEX ops_license_confirmation_source ON ops_entities(
    tenant_id,json_extract(data_json,'$.terms.supplierId'),json_extract(data_json,'$.confirmation.documentKey'),json_extract(data_json,'$.confirmation.line'))
    WHERE module='licenses' AND json_extract(data_json,'$.kind')='license_terms' AND status IN ('active','superseded');`);
}

/** Domain changes share the Workspace transaction and receipt ledger; no network effects. */
export class LicenseContracts {
  constructor(private readonly db: DatabaseSync) {}
  read(tenant: string, id: string, module = "licenses"): Entity {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND id=? AND module=?",
      )
      .get(tenant, id, module);
    if (!row)
      fail("Brak źródła licencji w tej organizacji.", "ENTITY_NOT_FOUND", 404);
    const e: Entity = {
      id: String(row.id),
      module: module as Entity["module"],
      title: String(row.title),
      status: String(row.status),
      version: Number(row.version),
      data: JSON.parse(String(row.data_json)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    const snapshot = this.db
      .prepare(
        "SELECT snapshot_hash,snapshot_json FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, id, e.version);
    if (
      !snapshot ||
      snapshot.snapshot_hash !== hash(e) ||
      hash(JSON.parse(String(snapshot.snapshot_json))) !==
        snapshot.snapshot_hash ||
      !this.snapshotValid(e)
    )
      fail(
        "Dane licencji nie odpowiadają zapisanej historii.",
        "LICENSE_STATE_INCONSISTENT",
      );
    return e;
  }
  snapshotValid(e: Entity) {
    if (e.module !== "licenses" || e.data.kind !== termKind) return true;
    if (
      !licenseTermsSchema.safeParse(e.data.terms).success ||
      typeof e.data.licenseId !== "string" ||
      !(e.data.baseTermsId === null || typeof e.data.baseTermsId === "string")
    )
      return false;
    if (["approved", "active", "superseded"].includes(e.status)) {
      const d = obj(e.data.costDecision);
      if (
        !d ||
        d.decision !== "approved" ||
        d.termsHash !== termsHash(e) ||
        !d.actorId ||
        !d.approvedBy
      )
        return false;
      const { hash: storedHash, ...body } = d;
      if (storedHash !== hash(body)) return false;
      if (["active", "superseded"].includes(e.status)) {
        const c = obj(e.data.confirmation);
        if (
          !c ||
          c.costDecisionHash !== storedHash ||
          !c.actorId ||
          !c.approvedBy ||
          !c.documentKey ||
          !c.line
        )
          return false;
        const { hash: confirmationHash, ...content } = c;
        if (confirmationHash !== hash(content)) return false;
      }
    }
    return true;
  }
  pool(tenant: string, id: string) {
    const e = this.read(tenant, id);
    if (e.data.kind === termKind || e.status !== "active")
      fail("Wybierz aktywną pulę miejsc licencji.");
    const rows = this.db
      .prepare(
        "SELECT id,person_id AS personId,employment_episode_id AS employmentEpisodeId,case_id AS caseId,status,assigned_at AS assignedAt,revoked_at AS revokedAt FROM ops_license_seats WHERE tenant_id=? AND license_id=? ORDER BY rowid",
      )
      .all(tenant, id);
    if (hash(rows) !== hash(e.data.assignments))
      fail(
        "Przydziały licencji są niespójne z historią.",
        "LICENSE_STATE_INCONSISTENT",
      );
    if (e.data.activeTermsId) {
      const active = this.read(tenant, String(e.data.activeTermsId));
      const t = obj(active.data.terms);
      if (
        active.data.kind !== termKind ||
        active.data.licenseId !== e.id ||
        active.status !== "active" ||
        e.data.activeTermsHash !== termsHash(active) ||
        e.data.totalSeats !== t.totalSeats ||
        e.data.expiresOn !== t.expiresOn ||
        e.data.validFrom !== t.validFrom
      )
        fail(
          "Bieżące uprawnienie nie odpowiada potwierdzonej umowie.",
          "LICENSE_STATE_INCONSISTENT",
        );
    }
    if (e.data.pendingTermsId) {
      const pending = this.read(tenant, String(e.data.pendingTermsId));
      if (
        pending.data.kind !== termKind ||
        pending.data.licenseId !== id ||
        !["draft", "approved", "rejected"].includes(pending.status)
      )
        fail(
          "Otwarta propozycja warunków jest niespójna.",
          "LICENSE_STATE_INCONSISTENT",
        );
    }
    return e;
  }
  consistent(tenant: string, entity: Entity): boolean {
    try {
      if (entity.data.kind === termKind) this.read(tenant, entity.id);
      else this.pool(tenant, entity.id);
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }
  private owner(s: LicenseServices, id: string, actorRequired = false) {
    const p = s.principal(id);
    if (
      !p?.roles.includes("operator") ||
      !["licenses", "purchases"].every((scope) =>
        p.scopes?.some((v) => v === "*" || v === scope),
      )
    )
      fail(
        "Właściciel licencji nie ma aktywnego dostępu do licencji i zakupów.",
        "LICENSE_OWNER_UNAVAILABLE",
        403,
      );
    if (actorRequired && p.id !== s.ctx.actorId)
      fail(
        "Decyzję kosztową podejmuje wskazany właściciel licencji.",
        "LICENSE_OWNER_REQUIRED",
        403,
      );
  }
  private supplier(tenant: string, terms: LicenseTerms) {
    const e = this.read(tenant, terms.supplierId, "purchases");
    if (
      e.data.kind !== "supplier" ||
      e.status !== "active" ||
      e.version !== terms.supplierVersion
    )
      fail(
        "Dostawca zmienił się lub jest nieaktywny. Zaktualizuj propozycję warunków.",
        "LICENSE_SUPPLIER_CHANGED",
      );
    return e;
  }
  private pending(s: LicenseServices, e: Entity) {
    if (e.data.kind !== termKind) fail("Wybierz propozycję warunków licencji.");
    const pool = this.pool(s.ctx.tenantId, String(e.data.licenseId));
    if (
      pool.data.pendingTermsId !== e.id ||
      (pool.data.activeTermsId ?? null) !== e.data.baseTermsId
    )
      fail("Propozycja nie dotyczy bieżącej umowy lub została zamknięta.");
    return pool;
  }
  private eligible(
    s: LicenseServices,
    e: Entity,
    pool: Entity,
    activation: boolean,
  ) {
    const terms = licenseTermsSchema.parse(e.data.terms);
    this.owner(s, terms.ownerPrincipalId);
    this.supplier(s.ctx.tenantId, terms);
    if (pool.data.ownerPrincipalId !== terms.ownerPrincipalId)
      fail("Zmienił się właściciel. Zaktualizuj warunki i decyzję.");
    if (terms.expiresOn < s.day) fail("Proponowany okres już wygasł.");
    if (activation && terms.validFrom > s.day)
      fail(
        `Okres zaczyna się ${terms.validFrom}. Warunki mogą pozostać zatwierdzone do tego dnia.`,
        "LICENSE_PERIOD_NOT_STARTED",
      );
    const used = this.db
      .prepare(
        "SELECT count(*) AS n FROM ops_license_seats WHERE tenant_id=? AND license_id=? AND status='assigned'",
      )
      .get(s.ctx.tenantId, pool.id)!.n;
    if (terms.totalSeats < Number(used))
      fail(
        "Liczba miejsc jest mniejsza od aktualnych przydziałów.",
        "SEAT_CAP_BELOW_USAGE",
      );
    return terms;
  }
  change(
    s: LicenseServices,
    current: Entity,
    action: string,
    raw: JsonObject,
  ): Entity {
    licenseAuthority(s);
    const schema =
      licenseContractActions[action as keyof typeof licenseContractActions];
    const input = obj(schema.parse(raw));
    const e = this.read(s.ctx.tenantId, current.id);
    if (action === "proposeTerms") {
      const pool = this.pool(s.ctx.tenantId, e.id),
        terms = licenseTermsSchema.parse(input.terms);
      if (pool.data.pendingTermsId)
        fail("Najpierw zmień lub zamknij istniejącą propozycję.");
      this.owner(s, terms.ownerPrincipalId);
      this.supplier(s.ctx.tenantId, terms);
      if (
        pool.data.ownerPrincipalId &&
        pool.data.ownerPrincipalId !== terms.ownerPrincipalId
      )
        fail("Najpierw jawnie przekaż odpowiedzialność za licencję.");
      pool.data.ownerPrincipalId = terms.ownerPrincipalId;
      const proposal = s.insert(
        `Warunki: ${pool.title}`,
        {
          kind: termKind,
          licenseId: pool.id,
          baseTermsId: pool.data.activeTermsId ?? null,
          terms: obj(terms),
          costDecision: null,
          confirmation: null,
        },
        "draft",
      );
      pool.data.pendingTermsId = proposal.id;
      pool.data.contractWorkflowVersion = 1;
      s.save(pool);
      return proposal;
    }
    if (action === "assignOwner") {
      const pool = this.pool(s.ctx.tenantId, e.id),
        owner = String(input.ownerPrincipalId);
      this.owner(s, owner);
      pool.data.ownerPrincipalId = owner;
      pool.data.ownerChange = {
        actorId: s.ctx.actorId!,
        approvedBy: s.ctx.approvedBy!,
        at: s.now,
        reason: input.reason!,
      };
      if (pool.data.pendingTermsId) {
        const pending = this.read(
          s.ctx.tenantId,
          String(pool.data.pendingTermsId),
        );
        pending.data.terms = {
          ...obj(pending.data.terms),
          ownerPrincipalId: owner,
        };
        pending.data.costDecision = null;
        pending.status = "draft";
        pending.data.revisionReason = input.reason!;
        s.save(pending);
      }
      return s.save(pool);
    }
    const pool = this.pending(s, e);
    if (action === "cancelTerms") {
      e.status = "cancelled";
      e.data.cancellationReason = input.reason!;
      pool.data.pendingTermsId = null;
      s.save(pool);
    }
    if (action === "reviseTerms") {
      const terms = licenseTermsSchema.parse(input.terms);
      this.owner(s, terms.ownerPrincipalId);
      this.supplier(s.ctx.tenantId, terms);
      if (pool.data.ownerPrincipalId !== terms.ownerPrincipalId)
        fail("Najpierw jawnie przekaż odpowiedzialność za licencję.");
      e.data.terms = obj(terms);
      e.data.costDecision = null;
      e.data.revisionReason = input.reason!;
      e.status = "draft";
    }
    if (action === "decideTerms") {
      this.owner(s, String(obj(e.data.terms).ownerPrincipalId), true);
      if (input.decision === "approved") this.eligible(s, e, pool, false);
      const decision = {
        decision: input.decision!,
        termsHash: termsHash(e),
        note: input.note!,
        at: s.now,
        actorId: s.ctx.actorId!,
        approvedBy: s.ctx.approvedBy!,
        runId: s.ctx.runId,
        stepId: s.ctx.stepId,
      };
      e.data.costDecision = { ...decision, hash: hash(decision) };
      e.status = String(input.decision);
    }
    if (action === "confirmTerms") {
      if (
        e.status !== "approved" ||
        obj(e.data.costDecision)?.hash !== input.costDecisionHash
      )
        fail(
          "Brak aktualnej decyzji kosztowej dla tych warunków.",
          "LICENSE_COST_DECISION_REQUIRED",
        );
      const terms = this.eligible(s, e, pool, true);
      if (String(input.confirmedOn) > s.day)
        fail("Potwierdzenie nie może mieć przyszłej daty.");
      const documentKey = licenseDocumentKey(
        String(input.confirmationReference),
      );
      if (
        this.db
          .prepare(
            "SELECT id FROM ops_entities WHERE tenant_id=? AND module='licenses' AND json_extract(data_json,'$.kind')='license_terms' AND status IN ('active','superseded') AND json_extract(data_json,'$.terms.supplierId')=? AND json_extract(data_json,'$.confirmation.documentKey')=? AND json_extract(data_json,'$.confirmation.line')=?",
          )
          .get(
            s.ctx.tenantId,
            terms.supplierId,
            documentKey,
            Number(input.confirmationLine),
          )
      )
        fail(
          "Ten dokument i pozycja zostały już potwierdzone. Sprawdź istniejącą umowę.",
          "DUPLICATE_LICENSE_CONFIRMATION",
        );
      if (pool.data.activeTermsId) {
        const previous = this.read(
          s.ctx.tenantId,
          String(pool.data.activeTermsId),
        );
        previous.status = "superseded";
        s.save(previous);
      }
      const confirmation = {
        documentReference: input.confirmationReference!,
        documentKey,
        line: input.confirmationLine!,
        confirmedOn: input.confirmedOn!,
        evidenceNote: input.evidenceNote!,
        costDecisionHash: input.costDecisionHash!,
        at: s.now,
        actorId: s.ctx.actorId!,
        approvedBy: s.ctx.approvedBy!,
        runId: s.ctx.runId,
        stepId: s.ctx.stepId,
        operationKey: s.ctx.operationKey,
      };
      e.data.confirmation = { ...confirmation, hash: hash(confirmation) };
      e.status = "active";
      pool.data.activeTermsId = e.id;
      pool.data.activeTermsHash = termsHash(e);
      pool.data.pendingTermsId = null;
      pool.data.validFrom = terms.validFrom;
      pool.data.expiresOn = terms.expiresOn;
      pool.data.totalSeats = terms.totalSeats;
      pool.data.supplierId = terms.supplierId;
      pool.data.renewalLeadDays = terms.renewalLeadDays;
      s.save(pool);
    }
    return s.save(e);
  }
  view(s: LicenseServices, id: string) {
    const selected = this.read(s.ctx.tenantId, id);
    const pool = this.pool(
      s.ctx.tenantId,
      selected.data.kind === termKind ? String(selected.data.licenseId) : id,
    );
    const rows = this.db
      .prepare(
        "SELECT id FROM ops_entities WHERE tenant_id=? AND module='licenses' AND json_extract(data_json,'$.kind')='license_terms' AND json_extract(data_json,'$.licenseId')=? ORDER BY created_at DESC,id DESC LIMIT 501",
      )
      .all(s.ctx.tenantId, pool.id);
    const terms = rows.slice(0, 500).map((row) => {
      const e = this.read(s.ctx.tenantId, String(row.id));
      let problem: string | null = null;
      let costDecisionCurrent = false;
      if (["draft", "approved", "rejected"].includes(e.status)) {
        try {
          this.pending(s, e);
          this.eligible(s, e, pool, false);
          costDecisionCurrent = e.status === "approved";
          this.eligible(s, e, pool, true);
        } catch (error) {
          if (error instanceof DomainError) problem = error.message;
          else throw error;
        }
      }
      return { record: e, problem, costDecisionCurrent };
    });
    return {
      pool,
      terms,
      truncated: rows.length > 500,
      costKnown: !!pool.data.activeTermsId,
      currentDay: s.day,
      usedSeats: (pool.data.assignments as JsonObject[]).filter(
        (a) => a.status === "assigned",
      ).length,
    };
  }
  history(tenant: string, id: string, limit = 20, offset = 0) {
    const current = this.read(tenant, id);
    if (current.data.kind !== termKind)
      fail("Wybierz dokument warunków licencji.");
    const total = Number(
      this.db
        .prepare(
          "SELECT count(*) n FROM ops_entity_versions WHERE tenant_id=? AND entity_id=?",
        )
        .get(tenant, id)!.n,
    );
    const rows = this.db
      .prepare(
        "SELECT version,snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? ORDER BY version DESC LIMIT ? OFFSET ?",
      )
      .all(tenant, id, limit, offset);
    const items = rows.map((row) => {
      const record = JSON.parse(String(row.snapshot_json)) as Entity;
      const audits = this.db
        .prepare(
          "SELECT * FROM ops_audit WHERE tenant_id=? AND entity_id=? AND entity_version=? LIMIT 2",
        )
        .all(tenant, id, row.version!);
      const audit = audits[0];
      const ledger =
        audit &&
        this.db
          .prepare(
            "SELECT changes_json FROM ops_commands WHERE tenant_id=? AND operation_key=?",
          )
          .get(tenant, audit.operation_key!);
      if (
        record.id !== id ||
        record.version !== row.version ||
        record.module !== "licenses" ||
        record.data.kind !== termKind ||
        hash(record) !== row.snapshot_hash ||
        !this.snapshotValid(record) ||
        audits.length !== 1 ||
        !ledger ||
        !(
          JSON.parse(String(ledger.changes_json)) as {
            id: string;
            version: number;
            hash: string;
          }[]
        ).some(
          (c) =>
            c.id === id &&
            c.version === record.version &&
            c.hash === row.snapshot_hash,
        )
      )
        fail(
          "Historia warunków nie odpowiada zatwierdzonym zapisom.",
          "LICENSE_STATE_INCONSISTENT",
        );
      return {
        record,
        actorId: String(audit!.actor_id),
        runId: String(audit!.run_id),
        toolId: String(audit!.tool_id),
      };
    });
    return { items, total, limit, offset };
  }
  requireCommitted(
    tenant: string,
    changes: { id: string; version: number; hash: string }[],
  ) {
    if (!changes.length)
      fail("Brak zapisanego skutku licencji.", "LICENSE_STATE_INCONSISTENT");
    for (const c of changes) {
      const e = this.read(tenant, c.id);
      if (!this.consistent(tenant, e))
        fail(
          "Zapisany wynik licencji wymaga uzgodnienia.",
          "LICENSE_STATE_INCONSISTENT",
        );
      const row = this.db
        .prepare(
          "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
        )
        .get(tenant, c.id, c.version);
      if (
        !row ||
        row.snapshot_hash !== c.hash ||
        hash(JSON.parse(String(row.snapshot_json))) !== c.hash ||
        !this.snapshotValid(JSON.parse(String(row.snapshot_json)))
      )
        fail(
          "Zapisany wynik nie odpowiada historii warunków.",
          "LICENSE_STATE_INCONSISTENT",
        );
    }
  }
}
