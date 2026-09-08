import { useCallback, useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Badge, Loading, Notice, Sheet } from "./ui";

export interface PurchaseView {
  legacy: boolean;
  request: Entity | null;
  quotes: {
    quote: Entity;
    supplierName: string;
    eligible: boolean;
    problem: string | null;
  }[];
  costDecisionCurrent: boolean;
  problems: string[];
}
const value = (data: Record<string, unknown>, key: string) =>
  String(data[key] ?? "");
const record = (data: unknown): Record<string, unknown> =>
  data && typeof data === "object" ? (data as Record<string, unknown>) : {};
export const purchaseMoney = (minor: unknown, currency: unknown) =>
  typeof minor === "number" &&
  Number.isSafeInteger(minor) &&
  ["PLN", "EUR", "USD"].includes(String(currency))
    ? new Intl.NumberFormat("pl-PL", {
        style: "currency",
        currency: String(currency),
      }).format(minor / 100)
    : "Brak kwoty";
const editMoney = (minor: unknown) =>
  typeof minor === "number" ? (minor / 100).toFixed(2) : "";
function minor(input: string) {
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(input.trim()))
    throw Error("Podaj kwotę z najwyżej dwoma miejscami po przecinku.");
  const [whole, fraction = ""] = input.trim().replace(",", ".").split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > 100_000_000_000)
    throw Error("Kwota przekracza dopuszczalny zakres.");
  return result;
}
const open = (item: Entity) =>
  ["draft", "awaiting_budget", "approved", "needs_changes"].includes(
    item.status,
  );
export function purchasingSidebarAction(item: Entity, action: string) {
  if (item.data.kind === "request") return action === "cancel" && open(item);
  if (item.data.kind === "quote") return false;
  if (item.data.kind === "supplier")
    return action === "deactivate" && item.status === "active";
  if (item.data.kind === "order")
    return (
      (action === "acknowledge" && item.status === "ordered") ||
      (action === "recordDelivery" &&
        ["acknowledged", "part_received"].includes(item.status)) ||
      (action === "cancel" &&
        ["draft", "ordered", "acknowledged"].includes(item.status))
    );
  return false;
}
async function submitPlan(
  toolId: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
) {
  const { run } = await post<{ run: Run }>("/api/commands", {
    toolId,
    input,
    idempotencyKey,
  });
  navigate(`runs/${run.id}`);
}
type FormMode =
  | "create"
  | "quote"
  | "reviseRequest"
  | "reviseQuote"
  | "selectQuote"
  | "decideCost"
  | "withdrawQuote";
export function PurchaseForm({
  mode,
  item,
  request,
  quote,
  context,
  onClose,
}: {
  mode: FormMode;
  item?: Entity;
  request?: Entity;
  quote?: Entity;
  context: Context;
  onClose: () => void;
}) {
  const [idempotencyKey] = useState(requestKey);
  const plan = (toolId: string, input: Record<string, unknown>) =>
    submitPlan(toolId, input, idempotencyKey);
  const source =
    mode === "reviseQuote"
      ? (quote ?? item)
      : mode === "reviseRequest"
        ? item
        : undefined;
  const data = source?.data ?? {};
  const [v, set] = useState<Record<string, string>>(() => ({
    kind: "request",
    title: source?.title ?? "",
    description: value(data, "description"),
    quantity:
      value(data, "quantity") || value(request?.data ?? {}, "quantity") || "1",
    budget: editMoney(data.budgetMinor),
    currency:
      value(data, "currency") ||
      value(request?.data ?? {}, "currency") ||
      "PLN",
    priceBasis:
      value(data, "priceBasis") ||
      value(request?.data ?? {}, "priceBasis") ||
      "gross",
    requiredBy: value(data, "requiredBy"),
    assetType: value(data, "assetType"),
    supplierEmail: value(data, "supplierEmail"),
    caseId: value(data, "caseId"),
    supplierId: value(data, "supplierId"),
    quoteReference: value(data, "quoteReference"),
    unitPrice: editMoney(data.unitPriceMinor),
    shipping: editMoney(data.shippingMinor),
    validUntil: value(data, "validUntil"),
    expectedDelivery: value(data, "expectedDelivery"),
    terms: value(data, "terms"),
    reason: "",
    note: "",
    decision: "approved",
    confirmed: "",
  }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const quoteMode = mode === "quote" || mode === "reviseQuote";
  const requestMode =
    mode === "reviseRequest" || (mode === "create" && v.kind === "request");
  const canCases = context.principal.scopes?.some(
    (x) => x === "*" || x === "cases",
  );
  const suppliers = useResource<{ items: Entity[] }>(
    quoteMode ? "/api/workspace/purchases" : null,
  );
  const cases = useResource<{ items: Entity[] }>(
    requestMode && canCases ? "/api/workspace/cases" : null,
  );
  const caseItem = cases.data?.items.find((x) => x.id === v.caseId);
  const supplier = suppliers.data?.items.find(
    (x) =>
      x.id === v.supplierId &&
      x.data.kind === "supplier" &&
      x.status === "active",
  );
  const titles: Record<FormMode, string> = {
    create: "Zapotrzebowanie lub dostawca",
    quote: "Dodaj ofertę dostawcy",
    reviseRequest: "Nowa rewizja zapotrzebowania",
    reviseQuote: "Nowa wersja oferty",
    selectQuote: "Wybierz ofertę do decyzji",
    decideCost: "Decyzja kosztowa",
    withdrawQuote: "Wycofaj ofertę dostawcy",
  };
  const field = (
    key: string,
    label: string,
    type = "text",
    required = true,
  ) => (
    <label className="field" key={key}>
      <span>{label}</span>
      {type === "textarea" ? (
        <textarea
          required={required}
          value={v[key]}
          disabled={busy}
          onChange={(e) => set((c) => ({ ...c, [key]: e.target.value }))}
        />
      ) : (
        <input
          type={type}
          required={required}
          value={v[key]}
          min={type === "number" ? 1 : undefined}
          step={type === "number" ? 1 : undefined}
          disabled={busy}
          onChange={(e) => set((c) => ({ ...c, [key]: e.target.value }))}
        />
      )}
    </label>
  );
  const select = (
    key: string,
    label: string,
    options: [string, string][],
    required = true,
  ) => (
    <label className="field">
      <span>{label}</span>
      <select
        value={v[key]}
        required={required}
        disabled={busy}
        onChange={(e) => set((c) => ({ ...c, [key]: e.target.value }))}
      >
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "withdrawQuote") {
        if (!quote || !request) throw Error("Brak aktualnej oferty.");
        await plan("ops.purchases.withdrawQuote", {
          id: quote.id,
          expectedVersion: quote.version,
          expectedRequestVersion: request.version,
          reason: v.reason,
        });
      } else if (mode === "selectQuote" || mode === "decideCost") {
        if (!request || !quote) throw Error("Brak aktualnego wyboru oferty.");
        await plan(`ops.purchases.${mode}`, {
          id: request.id,
          expectedVersion: request.version,
          quoteId: quote.id,
          expectedQuoteVersion: quote.version,
          ...(mode === "selectQuote"
            ? { selectionReason: v.reason }
            : {
                decision: v.decision,
                note: v.note,
                humanDecision: v.confirmed === "yes",
              }),
        });
      } else if (quoteMode) {
        if (!request || !supplier) throw Error("Wybierz aktywnego dostawcę.");
        const terms = {
          supplierId: supplier.id,
          expectedSupplierVersion: supplier.version,
          expectedRequestVersion: request.version,
          quoteReference: v.quoteReference,
          description: v.description,
          quantity: Number(v.quantity),
          unitPriceMinor: minor(v.unitPrice!),
          shippingMinor: minor(v.shipping!),
          currency: v.currency,
          priceBasis: v.priceBasis,
          validUntil: v.validUntil,
          expectedDelivery: v.expectedDelivery,
          terms: v.terms,
        };
        if (mode === "quote")
          await plan("ops.purchases.create", {
            title: v.title,
            data: { kind: "quote", requestId: request.id, ...terms },
          });
        else if (quote)
          await plan("ops.purchases.reviseQuote", {
            id: quote.id,
            expectedVersion: quote.version,
            ...terms,
            reason: v.reason,
          });
      } else if (requestMode) {
        if (v.caseId && !caseItem)
          throw Error("Brak dostępu do bieżącej sprawy. Odśwież dane.");
        const fields = {
          description: v.description,
          quantity: Number(v.quantity),
          budgetMinor: minor(v.budget!),
          currency: v.currency,
          priceBasis: v.priceBasis,
          requiredBy: v.requiredBy,
          ...(v.assetType ? { assetType: v.assetType } : {}),
          ...(caseItem
            ? { caseScopeRevision: Number(caseItem.data.scopeRevision) }
            : {}),
        };
        if (mode === "create")
          await plan("ops.purchases.create", {
            title: v.title,
            data: {
              kind: "request",
              ...fields,
              ...(caseItem ? { caseId: caseItem.id } : {}),
            },
          });
        else if (item)
          await plan("ops.purchases.reviseRequest", {
            id: item.id,
            expectedVersion: item.version,
            ...fields,
            reason: v.reason,
          });
      } else
        await plan("ops.purchases.create", {
          title: v.title,
          data: {
            kind: "supplier",
            description: v.description,
            ...(v.supplierEmail ? { supplierEmail: v.supplierEmail } : {}),
          },
        });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <Sheet title={titles[mode]} onClose={onClose}>
      <form className="command-form" onSubmit={submit}>
        <div className="sheet-body purchase-form">
          {error && <Notice tone="error">{error}</Notice>}
          {mode === "create" &&
            select("kind", "Rodzaj wpisu", [
              ["request", "Zapotrzebowanie"],
              ["supplier", "Dostawca"],
            ])}
          {(mode === "create" || mode === "quote") && field("title", "Nazwa")}
          {(mode === "create" || mode === "reviseRequest" || quoteMode) &&
            field("description", "Opis potrzeby lub oferty", "textarea")}
          {requestMode && (
            <>
              <div className="form-grid">
                {field("quantity", "Liczba sztuk", "number")}
                {field("budget", "Budżet")}
                {select("currency", "Waluta", [
                  ["PLN", "PLN"],
                  ["EUR", "EUR"],
                  ["USD", "USD"],
                ])}
                {select("priceBasis", "Podstawa porównania cen", [
                  ["gross", "Brutto"],
                  ["net", "Netto"],
                ])}
                {field("requiredBy", "Potrzebne do", "date")}
                {select(
                  "assetType",
                  "Rodzaj wyposażenia",
                  [
                    ["", "Zakup ogólny"],
                    ["laptop", "Laptop"],
                    ["desktop", "Komputer stacjonarny"],
                    ["phone", "Telefon"],
                    ["monitor", "Monitor"],
                    ["accessory", "Akcesoria"],
                    ["other", "Inne"],
                  ],
                  false,
                )}
              </div>
              {mode === "create" &&
                canCases &&
                select(
                  "caseId",
                  "Powiązana sprawa",
                  [
                    ["", "Bez powiązanej sprawy"],
                    ...(cases.data?.items ?? [])
                      .filter((x) =>
                        [
                          "open",
                          "needs_changes",
                          "awaiting_acceptance",
                        ].includes(x.status),
                      )
                      .map((x) => [x.id, x.title] as [string, string]),
                  ],
                  false,
                )}
              {Boolean(item?.data.caseId) && (
                <p className="muted">
                  Powiązana sprawa pozostaje ta sama. Nowa rewizja przypnie jej
                  bieżący zakres.
                </p>
              )}
              {cases.error && <Notice tone="error">{cases.error}</Notice>}
            </>
          )}
          {mode === "create" &&
            v.kind === "supplier" &&
            field("supplierEmail", "E-mail dostawcy", "email", false)}
          {quoteMode && (
            <>
              <p>
                Oferta dla: <strong>{request?.title}</strong>
              </p>
              {suppliers.error && (
                <Notice tone="error">{suppliers.error}</Notice>
              )}
              {select("supplierId", "Dostawca", [
                ["", "Wybierz dostawcę"],
                ...(suppliers.data?.items ?? [])
                  .filter(
                    (x) => x.data.kind === "supplier" && x.status === "active",
                  )
                  .map((x) => [x.id, x.title] as [string, string]),
              ])}
              {field("quoteReference", "Numer oferty dostawcy")}
              <div className="form-grid">
                {field("quantity", "Oferowana liczba sztuk", "number")}
                {field("unitPrice", "Cena jednostkowa")}
                {field("shipping", "Koszt dostawy")}
                {select("currency", "Waluta oferty", [
                  ["PLN", "PLN"],
                  ["EUR", "EUR"],
                  ["USD", "USD"],
                ])}
                {select("priceBasis", "Podstawa ceny oferty", [
                  ["gross", "Brutto"],
                  ["net", "Netto"],
                ])}
                {field("validUntil", "Oferta ważna do", "date")}
                {field("expectedDelivery", "Termin dostawy", "date")}
              </div>
              {field("terms", "Warunki oferty", "textarea")}
              <p className="small muted">
                Kwoty wpisujesz w wybranej walucie. Koszt dostawy wymaga jawnej
                wartości, również gdy wynosi zero.
              </p>
            </>
          )}
          {(mode === "reviseRequest" ||
            mode === "reviseQuote" ||
            mode === "selectQuote" ||
            mode === "withdrawQuote") &&
            field(
              "reason",
              mode === "selectQuote"
                ? "Uzasadnienie wyboru"
                : mode === "withdrawQuote"
                  ? "Powód wycofania"
                  : "Powód nowej wersji",
              "textarea",
            )}
          {(mode === "selectQuote" || mode === "decideCost") && (
            <div>
              <p>
                <strong>{quote?.title}</strong> ·{" "}
                {purchaseMoney(quote?.data.totalMinor, quote?.data.currency)} ·{" "}
                {quote?.data.priceBasis === "net" ? "netto" : "brutto"}
              </p>
              <p>
                Wersja {quote?.version} · dostawa{" "}
                {dateLabel(String(quote?.data.expectedDelivery))} · oferta ważna
                do {dateLabel(String(quote?.data.validUntil))}
              </p>
              <p>{String(quote?.data.description)}</p>
              <p>{String(quote?.data.terms)}</p>
            </div>
          )}
          {mode === "decideCost" && (
            <>
              {select("decision", "Decyzja właściciela", [
                ["approved", "Zatwierdzam koszt"],
                ["rejected", "Odrzucam wybór"],
              ])}
              {field("note", "Uzasadnienie decyzji", "textarea")}
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  required
                  checked={v.confirmed === "yes"}
                  onChange={(e) =>
                    set((c) => ({
                      ...c,
                      confirmed: e.target.checked ? "yes" : "",
                    }))
                  }
                  disabled={busy}
                />{" "}
                Podejmuję decyzję dotyczącą pokazanej wersji oferty i kosztu.
              </label>
            </>
          )}
          <Notice>
            Przygotujesz plan do sprawdzenia. Zapis wymaga osobnej zgody na
            konkretny zakres.
          </Notice>
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Anuluj
          </button>
          <button
            className="button primary"
            disabled={busy || (quoteMode && suppliers.loading)}
          >
            Przygotuj operację
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function PurchaseComparison({
  view,
  onSelect,
}: {
  view: PurchaseView;
  onSelect?: (quote: Entity) => void;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Dostawca i oferta</th>
            <th>Ilość i ceny</th>
            <th>Razem</th>
            <th>Terminy</th>
            <th>Ocena</th>
          </tr>
        </thead>
        <tbody>
          {view.quotes.map(({ quote, supplierName, eligible, problem }) => (
            <tr key={quote.id}>
              <td>
                <button
                  className="text-button"
                  onClick={() => navigate(`module/purchases/${quote.id}`)}
                >
                  {supplierName}
                </button>
                <div>
                  {String(quote.data.quoteReference)} · wersja {quote.version}
                </div>
                <details className="purchase-terms">
                  <summary>Opis i warunki</summary>
                  <p>{String(quote.data.description)}</p>
                  <p>{String(quote.data.terms)}</p>
                </details>
              </td>
              <td>
                {String(quote.data.quantity)} szt. ×{" "}
                {purchaseMoney(quote.data.unitPriceMinor, quote.data.currency)}
                <div className="small muted">
                  Dostawa:{" "}
                  {purchaseMoney(quote.data.shippingMinor, quote.data.currency)}
                </div>
              </td>
              <td>
                <strong>
                  {purchaseMoney(quote.data.totalMinor, quote.data.currency)}
                </strong>
                <div>
                  {quote.data.priceBasis === "net" ? "netto" : "brutto"}
                </div>
              </td>
              <td>
                Ważna: {dateLabel(String(quote.data.validUntil))}
                <div>
                  Dostawa: {dateLabel(String(quote.data.expectedDelivery))}
                </div>
              </td>
              <td>
                {problem ? <div>{problem}</div> : <div>Spełnia warunki</div>}
                {onSelect && (
                  <button
                    className="button secondary"
                    disabled={!eligible}
                    onClick={() => onSelect(quote)}
                  >
                    Wybierz: {supplierName}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!view.quotes.length && (
        <p className="muted">
          Brak ofert do porównania. Dodaj ofertę z ceną, warunkami i datą
          ważności.
        </p>
      )}
    </div>
  );
}
export function PurchaseWorkflow({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const [idempotencyKey] = useState(requestKey);
  const resource = useResource<{ purchasing: PurchaseView }>(
    item.data.kind === "supplier"
      ? null
      : `/api/purchases/${encodeURIComponent(item.id)}/workflow`,
    revision + item.version,
  );
  const [form, setForm] = useState<{ mode: FormMode; quote?: Entity } | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const close = useCallback(() => setForm(null), []);
  if (item.data.kind === "supplier") return null;
  if (resource.loading) return <Loading />;
  if (resource.error) return <Notice tone="error">{resource.error}</Notice>;
  const view = resource.data?.purchasing,
    request = view?.request;
  if (!view) return null;
  if (!request)
    return (
      <Notice>
        Zamówienie historyczne. Nie ma przypiętej decyzji z nowego obiegu
        kosztowego. Dawny szkic wymaga nowego zapotrzebowania.
      </Notice>
    );
  const may = (action: string) =>
    open(request) &&
    context.principal.roles.includes("operator") &&
    context.tools.some((t) => t.id === `ops.purchases.${action}`);
  const selection = record(request.data.selection),
    decision = record(request.data.costDecision),
    chosen = view.quotes.find((x) => x.quote.id === selection.quoteId)?.quote;
  const command = async (action: string, input: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await submitPlan(`ops.purchases.${action}`, input, idempotencyKey);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  };
  return (
    <section className="card" aria-label="Obieg zakupowy">
      {form && (
        <PurchaseForm
          mode={form.mode}
          item={form.mode === "reviseRequest" ? request : item}
          request={request}
          quote={form.quote}
          context={context}
          onClose={close}
        />
      )}
      <span className="eyebrow">
        ZAPOTRZEBOWANIE → OFERTY → DECYZJA → ZAMÓWIENIE
      </span>
      <h2>{request.title}</h2>
      <p>{String(request.data.description)}</p>
      <p>
        <strong>Budżet:</strong>{" "}
        {purchaseMoney(request.data.budgetMinor, request.data.currency)}{" "}
        {request.data.priceBasis === "net" ? "netto" : "brutto"} ·{" "}
        {String(request.data.quantity)} szt. · <strong>Potrzebne do:</strong>{" "}
        {dateLabel(String(request.data.requiredBy))}
      </p>
      <p className="muted">
        Właściciel decyzji: {String(request.data.ownerPrincipalId)} · rewizja
        potrzeby {String(request.data.requestRevision)}
      </p>
      {Boolean(request.data.caseId) && (
        <button
          className="text-button"
          onClick={() => navigate(`module/cases/${request.data.caseId}`)}
        >
          Otwórz powiązaną sprawę
        </button>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="purchase-actions">
        {may("create") && (
          <button
            className="button primary"
            onClick={() => setForm({ mode: "quote" })}
          >
            Dodaj ofertę
          </button>
        )}
        {may("reviseRequest") && (
          <button
            className="button secondary"
            onClick={() => setForm({ mode: "reviseRequest" })}
          >
            Zmień potrzebę lub budżet
          </button>
        )}
        {item.data.kind === "quote" && may("reviseQuote") && (
          <button
            className="button secondary"
            onClick={() => setForm({ mode: "reviseQuote", quote: item })}
          >
            Nowa wersja tej oferty
          </button>
        )}
        {item.data.kind === "quote" &&
          item.status === "active" &&
          may("withdrawQuote") && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => setForm({ mode: "withdrawQuote", quote: item })}
            >
              Wycofaj tę ofertę
            </button>
          )}
      </div>
      <h3>Porównanie ofert</h3>
      <PurchaseComparison
        view={view}
        onSelect={
          may("selectQuote")
            ? (quote) => setForm({ mode: "selectQuote", quote })
            : undefined
        }
      />
      <h3>Wybór i decyzja</h3>
      {chosen ? (
        <p>
          Wybrana oferta: <strong>{chosen.title}</strong>, wersja{" "}
          {String(selection.quoteVersion)}. Uzasadnienie:{" "}
          {String(selection.reason)}.
        </p>
      ) : (
        <p className="muted">Oferta nie została wybrana.</p>
      )}
      {Boolean(decision.id) && (
        <p>
          Decyzja:{" "}
          {decision.decision === "approved"
            ? "koszt zatwierdzony"
            : "wybór odrzucony"}
          . {String(decision.note)} · autor {String(decision.decidedBy)}, zgoda{" "}
          {String(decision.approvedBy)}.
        </p>
      )}
      {open(request) &&
        view.problems.map((problem) => (
          <Notice key={problem}>{problem}</Notice>
        ))}
      {request.status === "awaiting_budget" &&
        chosen &&
        may("decideCost") &&
        context.principal.id === request.data.ownerPrincipalId && (
          <button
            className="button primary"
            onClick={() => setForm({ mode: "decideCost", quote: chosen })}
          >
            Podejmij decyzję kosztową
          </button>
        )}
      {request.status === "approved" &&
        view.costDecisionCurrent &&
        may("placeOrder") && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() =>
              void command("placeOrder", {
                id: request.id,
                expectedVersion: request.version,
                costDecisionHash: decision.hash,
                expectedSupplierVersion: decision.supplierVersion,
              })
            }
          >
            Zarejestruj zatwierdzone zamówienie
          </button>
        )}
      {Boolean(request.data.orderId) && (
        <p>
          <Badge status="ordered" />{" "}
          <button
            className="text-button"
            onClick={() => navigate(`module/purchases/${request.data.orderId}`)}
          >
            Otwórz zamówienie
          </button>
        </p>
      )}
      {item.data.kind === "order" && (
        <p>
          Wartość zamówienia:{" "}
          <strong>
            {purchaseMoney(item.data.totalMinor, item.data.currency)}
          </strong>{" "}
          · odebrano {String(item.data.receivedQuantity ?? 0)} z{" "}
          {String(item.data.quantity)} szt.
        </p>
      )}
      <p className="small muted">
        Rejestracja zamówienia nie wysyła go do dostawcy. Potwierdzenie
        dostawcy, przyjęcie dostawy i wydanie wyposażenia są osobnymi
        zdarzeniami.
      </p>
    </section>
  );
}
