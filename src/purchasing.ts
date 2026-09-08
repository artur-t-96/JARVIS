import { randomUUID } from "node:crypto";
import {
  DomainError,
  type JsonObject,
  type Principal,
  type ToolContext,
} from "./contracts.js";
import { hash } from "./engine.js";
import type { Entity } from "./workspace.js";
import {
  purchaseCreateSchema,
  purchasingActions,
  type PurchaseCreate,
} from "./purchasing-models.js";

export interface PurchasingServices {
  ctx: ToolContext;
  now: string;
  day: string;
  principal(id: string): Principal | undefined;
  read(id: string): Entity;
  sourceProblem(data: JsonObject): string | null;
  save(entity: Entity): Entity;
  insert(title: string, data: JsonObject, status: string): Entity;
}
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const object = (value: unknown) => value as JsonObject;
const ids = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : [];
const open = ["draft", "awaiting_budget", "approved", "needs_changes"];
const is = (e: Entity, kind: string) =>
  e.module === "purchases" && e.data.kind === kind;
const state = (e: Entity, allowed: string[]) => {
  if (!allowed.includes(e.status))
    fail(
      "INVALID_TRANSITION",
      "Ta operacja nie jest dozwolona w bieżącym stanie zakupu.",
    );
};
const requireKind = (e: Entity, kind: string) => {
  if (!is(e, kind))
    fail("WRONG_RECORD_KIND", "Wybierz właściwe zapotrzebowanie lub ofertę.");
};
export function purchasingAuthority(s: PurchasingServices) {
  for (const [id, role] of [
    [s.ctx.actorId, "operator"],
    [s.ctx.approvedBy, "approver"],
  ]) {
    const p = id ? s.principal(id) : undefined;
    if (
      !p ||
      !p.roles.includes(role as "operator" | "approver") ||
      !p.scopes?.some((x) => x === "*" || x === "purchases")
    )
      fail(
        "PURCHASE_AUTHORITY_REQUIRED",
        "Zakup wymaga aktywnego operatora i zatwierdzającego z dostępem do zakupów.",
        403,
      );
  }
}
function supplier(s: PurchasingServices, id: string, version?: number) {
  const entity = s.read(id);
  requireKind(entity, "supplier");
  if (entity.status !== "active")
    fail("SUPPLIER_INACTIVE", "Dostawca nie jest aktywny.");
  if (version !== undefined && entity.version !== version)
    fail(
      "SUPPLIER_CHANGED",
      "Dostawca zmienił się. Odśwież ofertę przed decyzją.",
    );
  return entity;
}
function owner(s: PurchasingServices, request: Entity, requireActor = false) {
  const p = s.principal(String(request.data.ownerPrincipalId));
  if (
    !p?.roles.includes("operator") ||
    !p.scopes?.some((x) => x === "*" || x === "purchases")
  )
    fail(
      "PURCHASE_OWNER_UNAVAILABLE",
      "Właściciel decyzji zakupowej nie ma aktywnego dostępu.",
      403,
    );
  if (requireActor && p.id !== s.ctx.actorId)
    fail(
      "PURCHASE_OWNER_REQUIRED",
      "Decyzję kosztową podejmuje właściciel zapotrzebowania.",
      403,
    );
}
function source(s: PurchasingServices, data: JsonObject) {
  const problem = s.sourceProblem(data);
  if (problem) fail("PURCHASE_SOURCE_CHANGED", problem);
}
export function quoteTotal(data: JsonObject): number {
  const total =
    Number(data.quantity) * Number(data.unitPriceMinor) +
    Number(data.shippingMinor);
  if (!Number.isSafeInteger(total) || total < 0 || total > 100_000_000_000)
    fail(
      "PURCHASE_AMOUNT_OUT_OF_RANGE",
      "Wartość oferty przekracza dopuszczalny zakres.",
    );
  return total;
}
function quoteProblem(
  s: PurchasingServices,
  request: Entity,
  quote: Entity,
): string | null {
  if (!is(quote, "quote") || quote.data.requestId !== request.id)
    return "Oferta nie należy do tego zapotrzebowania.";
  if (quote.status !== "active") return "Oferta jest wycofana.";
  if (quote.data.requestRevision !== request.data.requestRevision)
    return "Oferta dotyczy wcześniejszej rewizji zapotrzebowania.";
  if (
    quote.data.currency !== request.data.currency ||
    quote.data.priceBasis !== request.data.priceBasis
  )
    return "Inna waluta lub podstawa ceny — brak porównywalności.";
  if (quote.data.quantity !== request.data.quantity)
    return "Oferta obejmuje inną ilość.";
  if (String(quote.data.validUntil) < s.day) return "Oferta wygasła.";
  if (String(quote.data.expectedDelivery) > String(request.data.requiredBy))
    return "Dostawa jest późniejsza od wymaganego terminu.";
  if (quoteTotal(quote.data) > Number(request.data.budgetMinor))
    return "Oferta przekracza budżet zapotrzebowania.";
  try {
    supplier(
      s,
      String(quote.data.supplierId),
      Number(quote.data.supplierVersion),
    );
  } catch (error) {
    if (error instanceof DomainError) return error.message;
    throw error;
  }
  return s.sourceProblem(request.data);
}
function selected(s: PurchasingServices, request: Entity, input?: JsonObject) {
  const selection = request.data.selection as JsonObject | null;
  if (!selection)
    fail("QUOTE_SELECTION_REQUIRED", "Najpierw wybierz konkretną ofertę.");
  const quote = s.read(String(selection.quoteId));
  if (
    quote.version !== selection.quoteVersion ||
    (input &&
      (input.quoteId !== quote.id ||
        input.expectedQuoteVersion !== quote.version))
  )
    fail(
      "QUOTE_CHANGED",
      "Wybrana oferta zmieniła się. Wybierz i zatwierdź aktualną wersję.",
    );
  const problem = quoteProblem(s, request, quote);
  if (problem) fail("QUOTE_NOT_ELIGIBLE", problem);
  return quote;
}
function invalidate(s: PurchasingServices, request: Entity, reason: string) {
  request.status = "draft";
  request.data.selection = null;
  request.data.costDecision = null;
  request.data.lastChange = { at: s.now, reason, actorId: s.ctx.actorId! };
  s.save(request);
}
function quoteData(
  s: PurchasingServices,
  request: Entity,
  input: JsonObject,
): JsonObject {
  supplier(s, String(input.supplierId), Number(input.expectedSupplierVersion));
  if (
    String(input.validUntil) < s.day ||
    String(input.expectedDelivery) < s.day
  )
    fail(
      "QUOTE_DATE_INVALID",
      "Nowa oferta wymaga bieżącej ważności i terminu dostawy.",
    );
  const {
    expectedSupplierVersion,
    expectedRequestVersion: _request,
    id: _id,
    expectedVersion: _version,
    reason: _reason,
    kind: _kind,
    requestId: _parent,
    ...terms
  } = input;
  const data: JsonObject = {
    ...terms,
    kind: "quote",
    requestId: request.id,
    requestRevision: request.data.requestRevision!,
    supplierVersion: Number(expectedSupplierVersion),
    referenceKey: String(input.quoteReference).normalize("NFKC").toLowerCase(),
    quotedAt: s.now,
    quotedBy: s.ctx.actorId!,
  };
  data.totalMinor = quoteTotal(data);
  return data;
}
function uniqueQuote(
  s: PurchasingServices,
  request: Entity,
  data: JsonObject,
  except?: string,
) {
  for (const id of ids(request.data.quoteIds)) {
    if (id === except) continue;
    const other = s.read(id);
    if (
      other.data.supplierId === data.supplierId &&
      other.data.referenceKey === data.referenceKey
    )
      fail(
        "DUPLICATE_QUOTE",
        "Ta oferta dostawcy już istnieje. Utwórz jej nową wersję.",
      );
  }
}
export function createPurchase(
  s: PurchasingServices,
  title: string,
  raw: JsonObject,
): Entity {
  const data = purchaseCreateSchema.parse(raw) as PurchaseCreate;
  if (data.kind === "supplier") return s.insert(title, object(data), "active");
  purchasingAuthority(s);
  if (data.kind === "request") {
    if (data.requiredBy < s.day)
      fail(
        "PURCHASE_DATE_INVALID",
        "Termin nowego zapotrzebowania nie może być w przeszłości.",
      );
    source(s, object(data));
    return s.insert(
      title,
      {
        ...data,
        requestRevision: 1,
        ownerPrincipalId: s.ctx.actorId!,
        quoteIds: [],
        selection: null,
        costDecision: null,
        orderId: null,
        procurementVersion: 1,
      },
      "draft",
    );
  }
  const request = s.read(data.requestId);
  requireKind(request, "request");
  state(request, open);
  if (request.version !== data.expectedRequestVersion)
    fail("VERSION_CONFLICT", "Zapotrzebowanie zmieniło się.");
  if (ids(request.data.quoteIds).length >= 50)
    fail(
      "QUOTE_LIMIT",
      "Limit 50 ofert. Aktualizuj istniejącą ofertę przez nową wersję.",
    );
  const terms = quoteData(s, request, object(data));
  uniqueQuote(s, request, terms);
  const quote = s.insert(title, terms, "active");
  request.data.quoteIds = [...ids(request.data.quoteIds), quote.id];
  invalidate(s, request, "Dodano ofertę do porównania.");
  return quote;
}
export function changePurchase(
  s: PurchasingServices,
  e: Entity,
  action: string,
  raw: JsonObject,
): Entity {
  purchasingAuthority(s);
  const schema = purchasingActions[action as keyof typeof purchasingActions];
  if (!schema) fail("PURCHASE_ACTION_REQUIRED", "Nieznana operacja zakupu.");
  const input = object(schema.parse(raw));
  if (["reviseQuote", "withdrawQuote"].includes(action)) {
    requireKind(e, "quote");
    const request = s.read(String(e.data.requestId));
    requireKind(request, "request");
    state(request, open);
    if (request.version !== input.expectedRequestVersion)
      fail("VERSION_CONFLICT", "Zapotrzebowanie zmieniło się.");
    if (action === "withdrawQuote") {
      state(e, ["active"]);
      e.status = "withdrawn";
      e.data.withdrawalReason = String(input.reason);
    } else {
      const data = quoteData(s, request, input);
      if (
        data.supplierId !== e.data.supplierId ||
        data.referenceKey !== e.data.referenceKey
      )
        fail(
          "QUOTE_SOURCE_CHANGED",
          "Nowa wersja musi zachować dostawcę i numer oferty. Inną ofertę dodaj osobno.",
        );
      uniqueQuote(s, request, data, e.id);
      e.data = data;
      e.status = "active";
    }
    s.save(e);
    invalidate(s, request, String(input.reason));
    return e;
  }
  requireKind(e, "request");
  state(e, open);
  owner(s, e);
  if (action === "reviseRequest") {
    const {
      id: _id,
      expectedVersion: _version,
      reason: _reason,
      ...data
    } = input;
    if (String(data.requiredBy) < s.day)
      fail("PURCHASE_DATE_INVALID", "Podaj bieżący termin zapotrzebowania.");
    if (!!e.data.caseId !== !!data.caseScopeRevision)
      fail(
        "PURCHASE_SOURCE_REQUIRED",
        "Powiązane zapotrzebowanie wymaga bieżącej rewizji sprawy.",
      );
    delete e.data.assetType;
    e.data = {
      ...e.data,
      ...data,
      requestRevision: Number(e.data.requestRevision) + 1,
    };
    source(s, e.data);
    invalidate(s, e, String(input.reason));
    return e;
  }
  source(s, e.data);
  if (action === "selectQuote") {
    const quote = s.read(String(input.quoteId));
    if (quote.version !== input.expectedQuoteVersion)
      fail("QUOTE_CHANGED", "Wersja oferty zmieniła się.");
    const problem = quoteProblem(s, e, quote);
    if (problem) fail("QUOTE_NOT_ELIGIBLE", problem);
    e.data.selection = {
      quoteId: quote.id,
      quoteVersion: quote.version,
      requestRevision: e.data.requestRevision!,
      reason: String(input.selectionReason),
      selectedBy: s.ctx.actorId!,
      selectedAt: s.now,
    };
    e.data.costDecision = null;
    e.status = "awaiting_budget";
    return s.save(e);
  }
  if (action === "decideCost") {
    state(e, ["awaiting_budget"]);
    owner(s, e, true);
    const quote = selected(s, e, input);
    const decision: JsonObject = {
      id: randomUUID(),
      decision: String(input.decision),
      requestId: e.id,
      requestRevision: e.data.requestRevision!,
      quoteId: quote.id,
      quoteVersion: quote.version,
      quoteHash: hash(quote.data),
      supplierId: quote.data.supplierId!,
      supplierVersion: quote.data.supplierVersion!,
      totalMinor: quote.data.totalMinor!,
      currency: quote.data.currency!,
      priceBasis: quote.data.priceBasis!,
      note: String(input.note),
      decidedBy: s.ctx.actorId!,
      approvedBy: s.ctx.approvedBy!,
      at: s.now,
    };
    e.data.costDecision = { ...decision, hash: hash(decision) };
    e.status = input.decision === "approved" ? "approved" : "needs_changes";
    return s.save(e);
  }
  state(e, ["approved"]);
  const quote = selected(s, e),
    decision = e.data.costDecision as JsonObject | null;
  if (!decision || decision.decision !== "approved")
    fail("COST_APPROVAL_REQUIRED", "Wymagana zaakceptowana decyzja kosztowa.");
  const { hash: decisionHash, ...body } = decision;
  if (
    hash(body) !== decisionHash ||
    decisionHash !== input.costDecisionHash ||
    decision.quoteVersion !== quote.version ||
    decision.quoteHash !== hash(quote.data) ||
    decision.requestRevision !== e.data.requestRevision ||
    decision.decidedBy !== e.data.ownerPrincipalId
  )
    fail(
      "COST_APPROVAL_CHANGED",
      "Zgoda kosztowa nie odpowiada bieżącemu zakresowi i ofercie.",
    );
  const costApprover = s.principal(String(decision.approvedBy));
  if (
    !costApprover?.roles.includes("approver") ||
    !costApprover.scopes?.some((x) => x === "*" || x === "purchases")
  )
    fail(
      "COST_APPROVER_UNAVAILABLE",
      "Zatwierdzający decyzję kosztową nie ma już uprawnienia. Wymagana nowa decyzja.",
      403,
    );
  supplier(
    s,
    String(quote.data.supplierId),
    Number(input.expectedSupplierVersion),
  );
  if (input.expectedSupplierVersion !== quote.data.supplierVersion)
    fail("SUPPLIER_CHANGED", "Oferta wskazuje wcześniejszą wersję dostawcy.");
  if (e.data.orderId)
    fail("PURCHASE_ALREADY_ORDERED", "Z tej decyzji utworzono już zamówienie.");
  const order = s.insert(
    `Zamówienie: ${e.title}`,
    {
      kind: "order",
      procurementVersion: 1,
      requestId: e.id,
      requestRevision: e.data.requestRevision!,
      supplierId: quote.data.supplierId!,
      supplierVersion: quote.data.supplierVersion!,
      description: e.data.description!,
      quantity: quote.data.quantity!,
      receivedQuantity: 0,
      deliveries: [],
      expectedDelivery: quote.data.expectedDelivery!,
      currency: quote.data.currency!,
      priceBasis: quote.data.priceBasis!,
      totalMinor: quote.data.totalMinor!,
      budgetMinor: e.data.budgetMinor!,
      costDecision: decision,
      quotation: { id: quote.id, version: quote.version, ...quote.data },
      ...(e.data.assetType ? { assetType: e.data.assetType } : {}),
      orderedAt: s.now,
      dispatch: "not_sent_local_record",
    },
    "ordered",
  );
  e.data.orderId = order.id;
  e.status = "ordered";
  return s.save(e);
}

/** Read-only comparison. No synthetic prices or automatic choice. */
export function purchaseProjection(s: PurchasingServices, entity: Entity) {
  const request = is(entity, "request")
    ? entity
    : entity.data.requestId
      ? s.read(String(entity.data.requestId))
      : null;
  if (!request)
    return {
      kind: entity.data.kind,
      legacy: is(entity, "order"),
      request: null,
      quotes: [],
      costDecisionCurrent: false,
      problems: ["Historyczne zamówienie bez nowego obiegu kosztowego."],
    };
  requireKind(request, "request");
  const quotes = ids(request.data.quoteIds).map((id) => {
    const quote = s.read(id),
      problem = quoteProblem(s, request, quote);
    return {
      quote,
      eligible: !problem,
      problem,
      supplierName: s.read(String(quote.data.supplierId)).title,
    };
  });
  const problems: string[] = [];
  if (request.status === "cancelled")
    problems.push("Zapotrzebowanie zostało anulowane.");
  try {
    owner(s, request);
    source(s, request.data);
    const quote = selected(s, request),
      decision = request.data.costDecision as JsonObject | null;
    if (!decision || decision.decision !== "approved")
      problems.push("Brak zatwierdzonej decyzji kosztowej.");
    else {
      const { hash: savedHash, ...body } = decision;
      if (
        hash(body) !== savedHash ||
        decision.quoteHash !== hash(quote.data) ||
        decision.quoteVersion !== quote.version ||
        decision.requestRevision !== request.data.requestRevision
      )
        problems.push("Decyzja kosztowa dotyczy innej wersji.");
      const approver = s.principal(String(decision.approvedBy));
      if (
        !approver?.roles.includes("approver") ||
        !approver.scopes?.some((x) => x === "*" || x === "purchases")
      )
        problems.push(
          "Brak aktualnego uprawnienia zatwierdzającego decyzję kosztową.",
        );
    }
  } catch (error) {
    if (error instanceof DomainError) problems.push(error.message);
    else throw error;
  }
  return {
    kind: entity.data.kind,
    legacy: false,
    request,
    quotes,
    costDecisionCurrent: problems.length === 0,
    problems,
  };
}

export function purchaseIntegrity(entity: Entity): boolean {
  try {
    const d = entity.data;
    if (d.kind === "quote")
      return (
        quoteTotal(d) === d.totalMinor &&
        typeof d.supplierVersion === "number" &&
        d.referenceKey ===
          String(d.quoteReference).normalize("NFKC").toLowerCase()
      );
    if (d.kind === "order" && d.procurementVersion === 1) {
      const decision = d.costDecision as JsonObject,
        { hash: saved, ...body } = decision;
      const {
        id: quoteId,
        version: quoteVersion,
        ...quotation
      } = d.quotation as JsonObject;
      return (
        hash(body) === saved &&
        decision.requestId === d.requestId &&
        decision.quoteId === quoteId &&
        decision.quoteVersion === quoteVersion &&
        decision.quoteHash === hash(quotation) &&
        quoteTotal(quotation) === d.totalMinor &&
        d.totalMinor === decision.totalMinor &&
        d.quantity === quotation.quantity &&
        d.currency === quotation.currency &&
        d.priceBasis === quotation.priceBasis &&
        d.supplierId === quotation.supplierId
      );
    }
    if (d.kind === "request")
      return (
        ids(d.quoteIds).length === new Set(ids(d.quoteIds)).size &&
        Number.isSafeInteger(d.requestRevision) &&
        Number(d.requestRevision) > 0
      );
    return true;
  } catch {
    return false;
  }
}
