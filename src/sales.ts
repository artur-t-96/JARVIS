import type { DatabaseSync } from "node:sqlite";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "./contracts.js";
import { hash } from "./engine.js";
import {
  calculateOffer,
  offerTermsSchema,
  SALES_CONTRACT,
  salesActions,
  salesCreateSchema,
} from "./sales-models.js";
import type { Entity } from "./workspace.js";

export interface SalesServices {
  ctx: ToolContext;
  now: string;
  day: string;
  dayOf(instant: string): string;
  principal(id: string): Principal | undefined;
  save(e: Entity): Entity;
  insert(title: string, data: JsonObject, status: string): Entity;
  deliver(offer: Entity, input: JsonObject): Entity;
}
const obj = (v: unknown): JsonObject =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {};
const rows = (v: unknown): JsonObject[] =>
  Array.isArray(v) ? (v as JsonObject[]) : [];
const json = (v: unknown): JsonObject => JSON.parse(JSON.stringify(v));
function fail(message: string, code = "SALES_CONFLICT", status = 409): never {
  throw new DomainError(code, message, status);
}
export function salesAuthority(s: SalesServices) {
  for (const [id, role] of [
    [s.ctx.actorId, "operator"],
    [s.ctx.approvedBy, "approver"],
  ] as const) {
    const p = id ? s.principal(id) : undefined;
    if (
      !p ||
      p.tenantId !== s.ctx.tenantId ||
      !p.roles.includes(role) ||
      !p.scopes?.some((scope) => scope === "*" || scope === "sales")
    )
      fail(
        "Wymagane aktywne konta operatora i zatwierdzającego z dostępem do sprzedaży.",
        "SALES_AUTHORITY_REQUIRED",
        403,
      );
  }
}
export function migrateSales(db: DatabaseSync) {
  // Historical conflicts stay visible; never manufacture or rewrite their decisions.
  db.exec(`CREATE UNIQUE INDEX ops_one_current_sales_offer ON ops_entities(tenant_id,json_extract(data_json,'$.parentId'))
    WHERE module='sales' AND json_extract(data_json,'$.salesContract')='p10a1'
    AND json_extract(data_json,'$.kind')='offer' AND status IN ('accepted','handed_over');
    CREATE UNIQUE INDEX ops_one_open_sales_step ON ops_entities(tenant_id,json_extract(data_json,'$.parentId'))
    WHERE module='sales' AND json_extract(data_json,'$.kind')='next_step' AND status IN ('assigned','accepted');
    CREATE INDEX ops_sales_parent ON ops_entities(tenant_id,json_extract(data_json,'$.parentId')) WHERE module='sales';`);
}
function proof(s: SalesServices, body: JsonObject) {
  const content = {
    ...body,
    actorId: s.ctx.actorId!,
    approvedBy: s.ctx.approvedBy!,
    recordedAt: s.now,
    recordedOn: s.day,
  };
  return { ...content, hash: hash(content) };
}
function proofValid(p: JsonObject, offerHash?: string) {
  const { hash: stored, ...body } = p;
  return (
    !!p.actorId &&
    !!p.approvedBy &&
    !!p.recordedAt &&
    stored === hash(body) &&
    (offerHash === undefined || p.offerHash === offerHash)
  );
}
function event(
  s: SalesServices,
  e: Entity,
  action: string,
  detail: JsonObject = {},
) {
  e.data.history = [
    ...rows(e.data.history),
    {
      action,
      actorId: s.ctx.actorId!,
      approvedBy: s.ctx.approvedBy!,
      at: s.now,
      ...detail,
    },
  ];
}

/** Local sales writes share Workspace's transaction, immutable versions and effect ledger. */
export class Sales {
  constructor(private readonly db: DatabaseSync) {}
  version(tenant: string, id: string, version: number): Entity {
    this.read(tenant, id);
    const row = this.db
      .prepare(
        "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
      )
      .get(tenant, id, version);
    if (!row)
      fail("Nie ma takiej wersji rekordu sprzedaży.", "ENTITY_NOT_FOUND", 404);
    const snapshot = JSON.parse(String(row.snapshot_json)) as Entity;
    if (
      snapshot.id !== id ||
      snapshot.module !== "sales" ||
      snapshot.version !== version ||
      hash(snapshot) !== row.snapshot_hash ||
      !this.snapshotValid(snapshot)
    )
      fail(
        "Wersja sprzedaży nie ma zgodnego dowodu.",
        "SALES_STATE_INCONSISTENT",
      );
    return snapshot;
  }
  read(tenant: string, id: string): Entity {
    const row = this.db
      .prepare(
        "SELECT * FROM ops_entities WHERE tenant_id=? AND module='sales' AND id=?",
      )
      .get(tenant, id);
    if (!row)
      fail(
        "Nie ma takiego rekordu sprzedaży w tej firmie.",
        "ENTITY_NOT_FOUND",
        404,
      );
    const e: Entity = {
      id: String(row.id),
      module: "sales",
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
        "Dane sprzedaży nie odpowiadają zapisanej historii.",
        "SALES_STATE_INCONSISTENT",
      );
    if (e.data.salesContract === SALES_CONTRACT) {
      if (
        e.data.kind === "offer" &&
        ["accepted", "handed_over"].includes(e.status)
      ) {
        const deal = this.db
          .prepare(
            "SELECT status,data_json FROM ops_entities WHERE tenant_id=? AND module='sales' AND id=?",
          )
          .get(tenant, String(e.data.parentId));
        const d = deal ? JSON.parse(String(deal.data_json)) : {};
        if (
          d.kind !== "deal" ||
          d.acceptedOfferId !== e.id ||
          (e.status === "handed_over" &&
            (deal?.status !== "won" ||
              d.deliveryCaseId !== e.data.deliveryCaseId))
        )
          fail(
            "Oferta i szansa wskazują różne zobowiązania.",
            "SALES_STATE_INCONSISTENT",
          );
      }
      if (e.data.kind === "deal" && e.data.acceptedOfferId) {
        const offer = this.db
          .prepare(
            "SELECT status,data_json FROM ops_entities WHERE tenant_id=? AND module='sales' AND id=?",
          )
          .get(tenant, String(e.data.acceptedOfferId));
        const d = offer ? JSON.parse(String(offer.data_json)) : {};
        if (
          d.kind !== "offer" ||
          d.parentId !== e.id ||
          !["accepted", "handed_over"].includes(String(offer?.status))
        )
          fail(
            "Szansa nie ma zgodnej zaakceptowanej oferty.",
            "SALES_STATE_INCONSISTENT",
          );
      }
    }
    return e;
  }
  snapshotValid(e: Entity): boolean {
    if (e.data.salesContract !== SALES_CONTRACT) return true;
    if (e.data.kind === "offer") {
      const offer = obj(e.data.offer),
        { hash: stored, ...body } = offer;
      const terms = offerTermsSchema.safeParse(offer.terms);
      if (
        !terms.success ||
        offer.revision !== e.data.revision ||
        stored !== hash(body) ||
        offer.dealId !== e.data.parentId ||
        offer.title !== e.title ||
        e.data.scope !== terms.data.scope
      )
        return false;
      try {
        if (hash(calculateOffer(terms.data)) !== hash(offer.pricing))
          return false;
      } catch {
        return false;
      }
      for (const value of rows(e.data.revisionHistory)) {
        const prior = obj(value.offer),
          { hash: priorHash, ...priorBody } = prior;
        if (priorHash !== hash(priorBody)) return false;
        for (const key of [
          "review",
          "dispatch",
          "acceptance",
          "decline",
          "cancellation",
        ])
          if (value[key] && !proofValid(obj(value[key]), String(priorHash)))
            return false;
      }
      for (const key of [
        "review",
        "dispatch",
        "acceptance",
        "decline",
        "cancellation",
      ])
        if (e.data[key] && !proofValid(obj(e.data[key]), String(stored)))
          return false;
      if (
        ["approved", "sent", "accepted", "handed_over", "declined"].includes(
          e.status,
        ) &&
        obj(e.data.review).decision !== "approved"
      )
        return false;
      if (
        ["sent", "accepted", "handed_over", "declined"].includes(e.status) &&
        !e.data.dispatch
      )
        return false;
      if (["accepted", "handed_over"].includes(e.status) && !e.data.acceptance)
        return false;
    }
    if (e.data.kind === "next_step") {
      if (!e.data.ownerPrincipalId || !e.data.dueDate || !e.data.parentId)
        return false;
      for (const key of [
        "ownerAcceptance",
        "completion",
        "cancellation",
        "decline",
      ])
        if (e.data[key] && !proofValid(obj(e.data[key]))) return false;
      if (
        ["accepted", "completed"].includes(e.status) &&
        !e.data.ownerAcceptance
      )
        return false;
      if (e.status === "completed" && !e.data.completion) return false;
    }
    return true;
  }
  consistent(tenant: string, e: Entity) {
    try {
      this.read(tenant, e.id);
      return true;
    } catch (error) {
      if (error instanceof DomainError) return false;
      throw error;
    }
  }
  requireCommitted(
    tenant: string,
    changes: { module: string; id: string; version: number; hash: string }[],
  ) {
    const salesChanges = changes.filter((c) => c.module === "sales");
    if (!salesChanges.length)
      fail("Brak zapisanego skutku sprzedaży.", "SALES_STATE_INCONSISTENT");
    for (const change of salesChanges) {
      this.read(tenant, change.id);
      const snapshot = this.db
        .prepare(
          "SELECT snapshot_json,snapshot_hash FROM ops_entity_versions WHERE tenant_id=? AND entity_id=? AND version=?",
        )
        .get(tenant, change.id, change.version);
      if (
        !snapshot ||
        snapshot.snapshot_hash !== change.hash ||
        hash(JSON.parse(String(snapshot.snapshot_json))) !==
          snapshot.snapshot_hash ||
        !this.snapshotValid(JSON.parse(String(snapshot.snapshot_json)))
      )
        fail(
          "Zapisany skutek sprzedaży nie ma zgodnego dowodu.",
          "SALES_STATE_INCONSISTENT",
        );
    }
  }
  private state(e: Entity, ...allowed: string[]) {
    if (!allowed.includes(e.status))
      fail(
        "Ta operacja nie jest dozwolona w obecnym stanie sprzedaży.",
        "INVALID_TRANSITION",
      );
  }
  private kind(e: Entity, ...allowed: string[]) {
    if (!allowed.includes(String(e.data.kind)))
      fail("Wybierz właściwy rodzaj rekordu sprzedaży.", "WRONG_RECORD_KIND");
  }
  private owner(s: SalesServices, owner: unknown, required = true) {
    const p = typeof owner === "string" ? s.principal(owner) : undefined;
    if (
      !p ||
      p.tenantId !== s.ctx.tenantId ||
      !p.roles.includes("operator") ||
      !p.scopes?.some((v) => v === "*" || v === "sales")
    )
      fail(
        "Właściciel nie ma aktywnego konta z dostępem do sprzedaży.",
        "SALES_OWNER_UNAVAILABLE",
        403,
      );
    if (required && p.id !== s.ctx.actorId)
      fail(
        "Operację wykonuje wskazany właściciel.",
        "SALES_OWNER_REQUIRED",
        403,
      );
  }
  private deal(s: SalesServices, e: Entity) {
    const d =
      e.data.kind === "deal"
        ? e
        : this.read(s.ctx.tenantId, String(e.data.parentId));
    this.kind(d, "deal");
    return d;
  }
  private contact(s: SalesServices, id: unknown, clientId: string) {
    const e = this.read(s.ctx.tenantId, String(id));
    this.kind(e, "contact");
    this.state(e, "active");
    if (e.data.parentId !== clientId)
      fail("Kontakt należy do innego klienta.", "SALES_CONTACT_MISMATCH");
    return e;
  }
  private accepted(s: SalesServices, dealId: string, except?: string) {
    return this.db
      .prepare(
        "SELECT id FROM ops_entities WHERE tenant_id=? AND module='sales' AND json_extract(data_json,'$.kind')='offer' AND json_extract(data_json,'$.parentId')=? AND status IN ('accepted','handed_over') AND id!=?",
      )
      .all(s.ctx.tenantId, dealId, except ?? "");
  }
  private noAccepted(s: SalesServices, deal: Entity, except?: string) {
    if (this.accepted(s, deal.id, except).length)
      fail(
        "Szansa ma już zaakceptowaną ofertę. Najpierw rozstrzygnij istniejące zobowiązanie.",
        "ACCEPTED_OFFER_EXISTS",
      );
  }
  private snapshot(
    s: SalesServices,
    deal: Entity,
    title: string,
    raw: JsonObject,
    revision: number,
  ): JsonObject {
    this.state(deal, "open", "qualified");
    this.owner(s, deal.data.ownerPrincipalId);
    const client = this.read(s.ctx.tenantId, String(deal.data.parentId));
    this.kind(client, "client");
    this.state(client, "active");
    const contact = this.contact(s, deal.data.contactId, client.id);
    if (
      raw.expectedDealVersion !== deal.version ||
      raw.expectedClientVersion !== client.version ||
      raw.expectedContactVersion !== contact.version
    )
      fail(
        "Klient, kontakt lub szansa zmieniły się. Odczytaj aktualne dane.",
        "SALES_SOURCE_CHANGED",
      );
    const terms = offerTermsSchema.parse(raw.terms);
    if (terms.validUntil < s.day)
      fail("Oferta wygasła. Ustal aktualny termin ważności.", "OFFER_EXPIRED");
    let pricing: ReturnType<typeof calculateOffer>;
    try {
      pricing = calculateOffer(terms);
    } catch (error) {
      fail(
        error instanceof Error ? error.message : "Niepoprawna kalkulacja.",
        "OFFER_PRICE_INVALID",
        400,
      );
    }
    const body = json({
      contract: SALES_CONTRACT,
      tenantId: s.ctx.tenantId,
      dealId: deal.id,
      title,
      revision,
      terms,
      pricing,
      createdAt: s.now,
      client: {
        id: client.id,
        version: client.version,
        hash: hash(client),
        title: client.title,
        organizationName: client.data.organizationName,
      },
      contact: {
        id: contact.id,
        version: contact.version,
        hash: hash(contact),
        title: contact.title,
        contactEmail: contact.data.contactEmail ?? null,
        phone: contact.data.phone ?? null,
        jobTitle: contact.data.jobTitle ?? null,
      },
    });
    return { ...body, hash: hash(body) };
  }
  private sourcesCurrent(s: SalesServices, offer: Entity) {
    const o = obj(offer.data.offer),
      deal = this.deal(s, offer);
    for (const key of ["client", "contact"]) {
      const source = obj(o[key]),
        current = this.read(s.ctx.tenantId, String(source.id));
      if (
        current.version !== source.version ||
        hash(current) !== source.hash ||
        current.status !== "active"
      )
        return false;
    }
    return (
      deal.data.parentId === obj(o.client).id &&
      deal.data.contactId === obj(o.contact).id
    );
  }
  private eligible(
    s: SalesServices,
    e: Entity,
    unaccepted = true,
    effectiveDay = s.day,
  ) {
    if (e.data.salesContract !== SALES_CONTRACT)
      fail(
        "Historyczna oferta nie ma pełnego obiegu decyzji. Przygotuj nową ofertę; wcześniejsze potwierdzenia pozostają w historii.",
        "SALES_LEGACY_OFFER",
      );
    const deal = this.deal(s, e);
    this.owner(s, deal.data.ownerPrincipalId);
    this.state(deal, "qualified");
    if (unaccepted) {
      if (!this.sourcesCurrent(s, e))
        fail(
          "Zmieniły się dane klienta lub kontaktu. Przygotuj nową rewizję oferty.",
          "SALES_SOURCE_CHANGED",
        );
      if (String(obj(obj(e.data.offer).terms).validUntil) < effectiveDay)
        fail(
          "Data zdarzenia przypada po terminie ważności oferty.",
          "OFFER_EXPIRED",
        );
    }
    return deal;
  }
  create(s: SalesServices, title: string, raw: JsonObject): Entity {
    salesAuthority(s);
    const input = salesCreateSchema.parse(raw),
      d = json(input);
    d.salesContract = SALES_CONTRACT;
    d.createdOn = s.day;
    d.history = [];
    let status = "active";
    if (input.kind === "contact") {
      const client = this.read(s.ctx.tenantId, input.parentId);
      this.kind(client, "client");
      this.state(client, "active");
      d.organizationName = client.data.organizationName!;
    }
    if (input.kind === "deal") {
      const client = this.read(s.ctx.tenantId, input.parentId);
      this.kind(client, "client");
      this.state(client, "active");
      const owner = input.ownerPrincipalId ?? s.ctx.actorId!;
      this.owner(s, owner, false);
      if (input.contactId) this.contact(s, input.contactId, client.id);
      d.organizationName = client.data.organizationName!;
      d.ownerPrincipalId = owner;
      d.acceptedOfferId = null;
      d.nextStepId = null;
      status = "open";
    }
    if (input.kind === "offer") {
      const deal = this.read(s.ctx.tenantId, input.parentId);
      this.kind(deal, "deal");
      const offer = this.snapshot(s, deal, title, json(input), 1);
      for (const key of [
        "terms",
        "expectedDealVersion",
        "expectedClientVersion",
        "expectedContactVersion",
      ])
        delete d[key];
      d.offer = offer;
      d.revision = 1;
      d.revisionHistory = [];
      d.organizationName = deal.data.organizationName!;
      d.scope = input.terms.scope;
      status = "draft";
    }
    d.history = [
      {
        action: "create",
        actorId: s.ctx.actorId!,
        approvedBy: s.ctx.approvedBy!,
        at: s.now,
      },
    ];
    return s.insert(title, d, status);
  }
  change(
    s: SalesServices,
    current: Entity,
    action: string,
    raw: JsonObject,
  ): Entity {
    salesAuthority(s);
    const input = json(
      salesActions[action as keyof typeof salesActions].parse(raw),
    );
    const e = this.read(s.ctx.tenantId, current.id),
      d = e.data;
    if (e.version !== input.expectedVersion)
      fail("Rekord zmienił się. Odczytaj aktualną wersję.", "VERSION_CONFLICT");
    if (action === "assignSalesOwner") {
      this.kind(e, "deal");
      this.state(e, "open", "qualified", "won");
      this.owner(s, input.ownerPrincipalId, false);
      event(s, e, action, {
        previousOwnerId: d.ownerPrincipalId ?? null,
        ownerPrincipalId: input.ownerPrincipalId!,
        reason: input.reason!,
      });
      d.ownerPrincipalId = input.ownerPrincipalId!;
      return s.save(e);
    }
    if (
      ["qualify", "setDealContact", "lose", "scheduleNextStep"].includes(action)
    ) {
      this.kind(e, "deal");
      this.owner(s, d.ownerPrincipalId);
      this.state(
        e,
        ...(action === "scheduleNextStep"
          ? ["open", "qualified", "won"]
          : ["open", "qualified"]),
      );
      if (action === "qualify") {
        this.state(e, "open");
        e.status = "qualified";
        d.qualification = input.qualification!;
      }
      if (action === "setDealContact") {
        this.noAccepted(s, e);
        const contact = this.contact(s, input.contactId, String(d.parentId));
        if (contact.version !== input.expectedContactVersion)
          fail("Kontakt zmienił się.", "SALES_SOURCE_CHANGED");
        d.contactId = contact.id;
      }
      if (action === "lose") {
        this.noAccepted(s, e);
        if (this.openStep(s, e.id))
          fail(
            "Najpierw zamknij oczekujący następny krok.",
            "SALES_NEXT_STEP_OPEN",
          );
        e.status = "lost";
        d.lossReason = input.reason!;
      }
      if (action === "scheduleNextStep") {
        if (this.openStep(s, e.id))
          fail("Szansa ma już otwarty następny krok.", "SALES_NEXT_STEP_OPEN");
        this.owner(s, input.ownerPrincipalId, false);
        if (String(input.dueDate) < s.day)
          fail(
            "Ustal termin następnego kroku od dzisiaj.",
            "SALES_STEP_OVERDUE",
          );
        const step = s.insert(
          String(input.title),
          {
            kind: "next_step",
            salesContract: SALES_CONTRACT,
            parentId: e.id,
            description: input.description!,
            ownerPrincipalId: input.ownerPrincipalId!,
            dueDate: input.dueDate!,
            requestedBy: s.ctx.actorId!,
            history: [
              {
                action,
                actorId: s.ctx.actorId!,
                approvedBy: s.ctx.approvedBy!,
                at: s.now,
              },
            ],
          },
          "assigned",
        );
        d.nextStepId = step.id;
      }
      event(s, e, action, {
        note: input.reason ?? input.qualification ?? input.description ?? "",
      });
      return s.save(e);
    }
    if (
      [
        "acceptNextStep",
        "completeNextStep",
        "cancelNextStep",
        "declineNextStep",
      ].includes(action)
    ) {
      this.kind(e, "next_step");
      this.state(e, "assigned", "accepted");
      const deal = this.deal(s, e);
      if (deal.data.nextStepId !== e.id)
        fail(
          "Następny krok nie odpowiada szansie.",
          "SALES_STATE_INCONSISTENT",
        );
      this.owner(
        s,
        action === "cancelNextStep"
          ? deal.data.ownerPrincipalId
          : d.ownerPrincipalId,
      );
      if (action === "acceptNextStep") {
        this.state(e, "assigned");
        d.ownerAcceptance = proof(s, {
          stepId: e.id,
          dueDate: d.dueDate!,
          ownerPrincipalId: d.ownerPrincipalId!,
        });
        e.status = "accepted";
      } else {
        if (action === "completeNextStep") {
          this.state(e, "accepted");
          if (
            String(input.completedOn) > s.day ||
            String(input.completedOn) <
              String(obj(d.ownerAcceptance).recordedOn)
          )
            fail(
              "Data wykonania musi przypadać po przyjęciu zadania i nie może być przyszła.",
              "SALES_INVALID_EVENT_DATE",
            );
          d.completion = proof(s, {
            stepId: e.id,
            completedOn: input.completedOn!,
            evidenceReference: input.evidenceReference!,
            note: input.note!,
          });
          e.status = "completed";
        } else if (action === "declineNextStep") {
          this.state(e, "assigned");
          d.decline = proof(s, { stepId: e.id, reason: input.reason! });
          e.status = "declined";
        } else {
          d.cancellation = proof(s, { stepId: e.id, reason: input.reason! });
          e.status = "cancelled";
        }
        deal.data.nextStepId = null;
        event(s, deal, action, { stepId: e.id });
        s.save(deal);
      }
      event(s, e, action);
      return s.save(e);
    }
    this.kind(e, "offer");
    const deal = this.deal(s, e);
    this.owner(s, deal.data.ownerPrincipalId);
    if (action === "cancelOffer") {
      this.state(
        e,
        "draft",
        "proposed",
        "approved",
        "sent",
        "rejected",
        "declined",
        "accepted",
      );
      if (
        String(input.cancelledOn) > s.day ||
        String(input.cancelledOn) < s.dayOf(e.createdAt)
      )
        fail(
          "Data anulowania jest poza okresem oferty.",
          "SALES_INVALID_EVENT_DATE",
        );
      if (e.status === "accepted") {
        const dependencies = this.db
          .prepare(
            "SELECT id FROM ops_employment WHERE tenant_id=? AND engagement_key=? AND status NOT IN ('ended','cancelled')",
          )
          .get(s.ctx.tenantId, `sales:${deal.id}`);
        if (dependencies || d.deliveryCaseId || deal.data.deliveryCaseId)
          fail(
            "Uzgodniona oferta ma powiązaną realizację lub współpracę. Wymaga zmiany zakresu tego zobowiązania.",
            "SALES_ACTIVE_COMMITMENT",
          );
        if (deal.data.acceptedOfferId === e.id) {
          deal.data.acceptedOfferId = null;
          event(s, deal, action, { offerId: e.id });
          s.save(deal);
        }
      }
      d.cancellation = proof(s, {
        offerHash: obj(d.offer).hash ?? null,
        cancelledOn: input.cancelledOn!,
        evidenceReference: input.evidenceReference!,
        note: input.note!,
      });
      e.status = "cancelled";
      event(s, e, action);
      return s.save(e);
    }
    if (d.salesContract !== SALES_CONTRACT)
      fail(
        "Historyczna oferta pozostaje do odczytu. Przygotuj nową wersjonowaną ofertę.",
        "SALES_LEGACY_OFFER",
      );
    if (action === "reviseOffer") {
      this.state(
        e,
        "draft",
        "proposed",
        "approved",
        "sent",
        "rejected",
        "declined",
        "cancelled",
      );
      if (rows(d.revisionHistory).length >= 49)
        fail(
          "Oferta ma już 50 rewizji. Przygotuj osobną ofertę.",
          "SALES_REVISION_LIMIT",
        );
      const next = this.snapshot(
        s,
        deal,
        String(input.title),
        input,
        Number(d.revision) + 1,
      );
      d.revisionHistory = [
        ...rows(d.revisionHistory),
        {
          offer: d.offer!,
          review: d.review ?? null,
          dispatch: d.dispatch ?? null,
          acceptance: d.acceptance ?? null,
          decline: d.decline ?? null,
          cancellation: d.cancellation ?? null,
          reason: input.reason!,
        },
      ];
      d.offer = next;
      d.revision = next.revision!;
      e.title = String(input.title);
      d.scope = obj(next.terms).scope!;
      for (const key of [
        "review",
        "dispatch",
        "acceptance",
        "decline",
        "cancellation",
      ])
        delete d[key];
      e.status = "draft";
    } else {
      this.eligible(
        s,
        e,
        action !== "handoff",
        action === "acceptOffer"
          ? String(input.acceptedOn)
          : action === "recordDispatch"
            ? String(input.dispatchedOn)
            : action === "declineOffer"
              ? String(obj(obj(d.offer).terms).validUntil)
              : s.day,
      );
      const offerHash = String(obj(d.offer).hash);
      if (action === "submitOffer") {
        this.state(e, "draft");
        e.status = "proposed";
      }
      if (action === "reviewOffer") {
        this.state(e, "proposed");
        d.review = proof(s, {
          offerHash,
          decision: input.decision!,
          note: input.note!,
        });
        e.status = input.decision === "approved" ? "approved" : "rejected";
      }
      if (action === "recordDispatch") {
        this.state(e, "approved");
        if (
          String(input.dispatchedOn) > s.day ||
          String(input.dispatchedOn) < String(obj(d.review).recordedOn)
        )
          fail(
            "Przekazanie musi nastąpić po decyzji wewnętrznej i nie może być przyszłe.",
            "SALES_INVALID_EVENT_DATE",
          );
        d.dispatch = proof(s, {
          offerHash,
          dispatchedOn: input.dispatchedOn!,
          channel: input.channel!,
          evidenceReference: input.evidenceReference!,
          note: input.note!,
          method: "human_attestation",
        });
        e.status = "sent";
      }
      if (action === "acceptOffer" || action === "declineOffer") {
        this.state(e, "sent");
        const day = String(
          action === "acceptOffer" ? input.acceptedOn : input.decidedOn,
        );
        if (day > s.day || day < String(obj(d.dispatch).dispatchedOn))
          fail(
            "Decyzja klienta musi przypadać po przekazaniu i nie może być przyszła.",
            "SALES_INVALID_EVENT_DATE",
          );
        if (action === "acceptOffer") {
          this.noAccepted(s, deal, e.id);
          d.acceptance = proof(s, {
            offerHash,
            acceptedOn: day,
            note: input.acceptanceNote!,
            evidenceReference: input.evidenceReference!,
            contactId: obj(obj(d.offer).contact).id!,
            method: "human_attestation",
          });
          e.status = "accepted";
          deal.data.acceptedOfferId = e.id;
          event(s, deal, action, { offerId: e.id, offerHash });
          s.save(deal);
        } else {
          d.decline = proof(s, {
            offerHash,
            decidedOn: day,
            note: input.note!,
            evidenceReference: input.evidenceReference!,
          });
          e.status = "declined";
        }
      }
      if (action === "handoff") {
        this.state(e, "accepted");
        this.noAccepted(s, deal, e.id);
        if (deal.data.acceptedOfferId !== e.id)
          fail(
            "Szansa nie wskazuje tej akceptacji.",
            "SALES_STATE_INCONSISTENT",
          );
        const step = this.openStep(s, deal.id);
        if (!step || step.status !== "accepted")
          fail(
            "Następny krok musi mieć właściciela, termin i jego potwierdzenie.",
            "SALES_NEXT_STEP_REQUIRED",
          );
        this.owner(s, step.data.ownerPrincipalId, false);
        if (String(step.data.dueDate) < s.day)
          fail(
            "Następny krok jest zaległy. Rozstrzygnij termin przed przekazaniem.",
            "SALES_STEP_OVERDUE",
          );
        const c = s.deliver(e, input);
        d.deliveryCaseId = c.id;
        e.status = "handed_over";
        deal.status = "won";
        deal.data.deliveryCaseId = c.id;
        event(s, deal, action, { offerId: e.id, deliveryCaseId: c.id });
        s.save(deal);
      }
    }
    event(s, e, action, {
      revision: d.revision!,
      note: input.reason ?? input.note ?? input.acceptanceNote ?? "",
    });
    return s.save(e);
  }
  private openStep(s: SalesServices, dealId: string) {
    const row = this.db
      .prepare(
        "SELECT id FROM ops_entities WHERE tenant_id=? AND module='sales' AND json_extract(data_json,'$.kind')='next_step' AND json_extract(data_json,'$.parentId')=? AND status IN ('assigned','accepted')",
      )
      .get(s.ctx.tenantId, dealId);
    return row ? this.read(s.ctx.tenantId, String(row.id)) : null;
  }
  list(
    tenant: string,
    page: {
      kind?: string;
      parentId?: string;
      search: string;
      limit: number;
      offset: number;
    },
  ) {
    const clauses = ["tenant_id=?", "module='sales'"],
      values: (string | number)[] = [tenant];
    if (page.kind) {
      clauses.push("json_extract(data_json,'$.kind')=?");
      values.push(page.kind);
    }
    if (page.parentId) {
      clauses.push("json_extract(data_json,'$.parentId')=?");
      values.push(page.parentId);
    }
    if (page.search) {
      clauses.push("title LIKE ? ESCAPE '\\'");
      values.push(`%${page.search.replace(/[\\%_]/g, "\\$&")}%`);
    }
    const where = clauses.join(" AND ");
    const records = this.db
      .prepare(
        `SELECT id FROM ops_entities WHERE ${where} ORDER BY title,id LIMIT ? OFFSET ?`,
      )
      .all(...values, page.limit + 1, page.offset);
    return {
      items: records
        .slice(0, page.limit)
        .map((r) => this.read(tenant, String(r.id))),
      limit: page.limit,
      offset: page.offset,
      hasMore: records.length > page.limit,
    };
  }
  view(s: SalesServices, id: string, limit = 30, offset = 0) {
    const record = this.read(s.ctx.tenantId, id);
    const children = this.db
      .prepare(
        "SELECT id FROM ops_entities WHERE tenant_id=? AND module='sales' AND json_extract(data_json,'$.parentId')=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(s.ctx.tenantId, id, limit + 1, offset);
    const deal = ["offer", "next_step", "deal"].includes(
      String(record.data.kind),
    )
      ? this.deal(s, record)
      : null;
    let sourceCurrent: boolean | null = null,
      sourceProblem: string | null = null;
    if (
      record.data.kind === "offer" &&
      record.data.salesContract === SALES_CONTRACT
    ) {
      try {
        sourceCurrent = this.sourcesCurrent(s, record);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        sourceCurrent = false;
        sourceProblem = error.message;
      }
    }
    return {
      record,
      deal,
      children: children
        .slice(0, limit)
        .map((c) => this.read(s.ctx.tenantId, String(c.id))),
      limit,
      offset,
      hasMore: children.length > limit,
      legacy: record.data.salesContract !== SALES_CONTRACT,
      currentDay: s.day,
      sourceCurrent,
      sourceProblem,
      acceptanceCurrent:
        record.data.kind === "offer" &&
        record.data.salesContract === SALES_CONTRACT &&
        ["accepted", "handed_over"].includes(record.status) &&
        deal?.data.acceptedOfferId === record.id,
      nextStep: deal ? this.openStep(s, deal.id) : null,
      ownerActive: deal
        ? !!s
            .principal(String(deal.data.ownerPrincipalId))
            ?.roles.includes("operator") &&
          !!s
            .principal(String(deal.data.ownerPrincipalId))
            ?.scopes?.some((scope) => scope === "*" || scope === "sales")
        : null,
    };
  }
}
