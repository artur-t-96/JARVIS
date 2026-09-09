import { useState, type FormEvent } from "react";
import { calculateOffer, type OfferTerms } from "../../src/sales-models";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Badge, Loading, Notice, Sheet } from "./ui";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
export const salesLabels: Record<string, string> = {
  create: "Dodaj do sprzedaży",
  qualify: "Potwierdź kwalifikację szansy",
  setDealContact: "Wskaż kontakt klienta",
  assignSalesOwner: "Przekaż odpowiedzialność",
  reviseOffer: "Przygotuj nową rewizję",
  submitOffer: "Przekaż do decyzji wewnętrznej",
  reviewOffer: "Podejmij decyzję wewnętrzną",
  recordDispatch: "Potwierdź przekazanie klientowi",
  acceptOffer: "Zapisz akceptację klienta",
  declineOffer: "Zapisz odmowę klienta",
  cancelOffer: "Potwierdź wycofanie oferty",
  scheduleNextStep: "Zaplanuj następny krok",
  acceptNextStep: "Przyjmij odpowiedzialność za krok",
  declineNextStep: "Odmów przyjęcia kroku",
  completeNextStep: "Potwierdź rezultat kroku",
  cancelNextStep: "Anuluj następny krok",
  handoff: "Utwórz sprawę realizacji",
  lose: "Zamknij utraconą szansę",
};
const kinds: Record<string, string> = {
  client: "Klient",
  contact: "Kontakt",
  deal: "Szansa",
  offer: "Oferta",
  next_step: "Następny krok",
};
const units: Record<string, string> = {
  hour: "godzina",
  md: "MD",
  month: "miesiąc",
  item: "sztuka",
  fixed: "ryczałt",
};
export function SalesPage({
  context,
  revision,
}: {
  context: Context;
  revision: number;
}) {
  const [kind, setKind] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [creating, setCreating] = useState(false);
  const result = useResource<{ items: Entity[]; hasMore: boolean }>(
    `/api/sales/records?limit=20&offset=${offset}&search=${encodeURIComponent(search)}${kind ? `&kind=${kind}` : ""}`,
    revision,
  );
  const allowed =
    context.principal.roles.includes("operator") &&
    context.tools.some((t) => t.id === "ops.sales.create");
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">FIRMA I KLIENCI</span>
          <h1>Sprzedaż</h1>
          <p>
            Klienci, kontakty, uzgodnione oferty i zobowiązania do kolejnych
            działań.
          </p>
        </div>
        {allowed && (
          <button className="button primary" onClick={() => setCreating(true)}>
            Dodaj do sprzedaży
          </button>
        )}
      </div>
      <section className="card">
        <div className="form-grid">
          <label className="field">
            <span>Szukaj w sprzedaży</span>
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <label className="field">
            <span>Rodzaj wpisu</span>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Wszystkie</option>
              {Object.entries(kinds).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {result.error ? (
          <Notice tone="error">{result.error}</Notice>
        ) : result.loading ? (
          <Loading />
        ) : (
          <>
            {!result.data?.items.length && <p>Brak wpisów w tym zakresie.</p>}
            {result.data?.items.map((e) => (
              <button
                key={e.id}
                className="action-row"
                onClick={() => navigate(`module/sales/${e.id}`)}
              >
                <span>
                  <strong>{e.title}</strong> · {kinds[String(e.data.kind)]}
                </span>
                <Badge status={e.status} />
              </button>
            ))}
          </>
        )}
        <div className="button-row">
          <button
            className="text-button"
            disabled={!offset}
            onClick={() => setOffset((n) => Math.max(0, n - 20))}
          >
            Poprzednia strona
          </button>
          <span>Strona {offset / 20 + 1}</span>
          <button
            className="text-button"
            disabled={!result.data?.hasMore || result.loading}
            onClick={() => setOffset((n) => n + 20)}
          >
            Następna strona
          </button>
        </div>
      </section>
      {creating && (
        <SalesForm context={context} onClose={() => setCreating(false)} />
      )}
    </>
  );
}
export function salesAmount(n: unknown, currency: unknown) {
  return typeof n === "number"
    ? `${(n / 100).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${String(currency)}`
    : "Brak kalkulacji";
}
export function salesScaled(text: string, places: number) {
  if (!new RegExp(`^\\d{1,10}(?:[.,]\\d{1,${places}})?$`).test(text.trim()))
    throw Error(`Podaj liczbę z najwyżej ${places} miejscami po przecinku.`);
  const [whole, fraction = ""] = text.trim().replace(",", ".").split(".");
  const value =
    Number(whole) * 10 ** places + Number(fraction.padEnd(places, "0"));
  if (!Number.isSafeInteger(value)) throw Error("Liczba przekracza zakres.");
  return value;
}
export interface SalesView {
  record: Entity;
  deal: Entity | null;
  children: Entity[];
  hasMore: boolean;
  currentDay: string;
  legacy: boolean;
  sourceCurrent: boolean | null;
  sourceProblem: string | null;
  acceptanceCurrent: boolean;
  nextStep: Entity | null;
  ownerActive: boolean | null;
}
export function salesAvailable(record: Entity, legacy: boolean): string[] {
  const kind = String(record.data.kind),
    state = record.status;
  if (kind === "deal")
    return [
      ...(["open", "qualified", "won"].includes(state)
        ? ["assignSalesOwner", "scheduleNextStep"]
        : []),
      ...(state === "open" ? ["qualify"] : []),
      ...(["open", "qualified"].includes(state)
        ? ["setDealContact", "lose"]
        : []),
    ];
  if (kind === "next_step")
    return state === "assigned"
      ? ["acceptNextStep", "declineNextStep", "cancelNextStep"]
      : state === "accepted"
        ? ["completeNextStep", "cancelNextStep"]
        : [];
  if (kind !== "offer" || state === "handed_over") return [];
  const cancel = [
    "draft",
    "proposed",
    "approved",
    "sent",
    "rejected",
    "declined",
    "accepted",
  ].includes(state)
    ? ["cancelOffer"]
    : [];
  if (legacy) return cancel;
  const primary: Record<string, string[]> = {
    draft: ["submitOffer"],
    proposed: ["reviewOffer"],
    approved: ["recordDispatch"],
    sent: ["acceptOffer", "declineOffer"],
    accepted: ["handoff"],
  };
  return [
    ...(primary[state] ?? []),
    ...(!["accepted", "handed_over"].includes(state) ? ["reviseOffer"] : []),
    ...cancel,
  ];
}
export function SalesPicker({
  kind,
  label,
  parentId,
  value,
  onChange,
  allowOffers = false,
}: {
  allowOffers?: boolean;
  kind: string;
  label: string;
  parentId?: string;
  value: Entity | null;
  onChange(e: Entity): void;
}) {
  const [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0);
  const source = useResource<{ items: Entity[]; hasMore: boolean }>(
    `/api/sales/records?kind=${kind}&limit=10&offset=${offset}&search=${encodeURIComponent(search)}${parentId ? `&parentId=${parentId}` : ""}`,
  );
  return (
    <fieldset className="sales-picker">
      <legend>{label}</legend>
      {value && (
        <p role="status">
          Wybrano: <strong>{value.title}</strong> · wersja {value.version}
        </p>
      )}
      <label className="field">
        <span>Wyszukaj: {label.toLocaleLowerCase("pl")}</span>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      </label>
      {source.error ? (
        <Notice tone="error">{source.error}</Notice>
      ) : source.loading ? (
        <Loading />
      ) : (
        <div className="sales-picker-options">
          {source.data?.items.map((e) => (
            <button
              type="button"
              key={e.id}
              className={`button ${value?.id === e.id ? "primary" : "secondary"}`}
              disabled={
                allowOffers
                  ? e.data.salesContract !== "p10a1"
                  : !["active", "open", "qualified"].includes(e.status)
              }
              onClick={() => onChange(e)}
            >
              {e.title} · {kinds[String(e.data.kind)]}
            </button>
          ))}
        </div>
      )}
      {!source.loading && source.data?.items.length === 0 && (
        <p className="muted">Brak wpisów w tym zakresie.</p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="text-button"
          disabled={!offset}
          onClick={() => setOffset((n) => Math.max(0, n - 10))}
        >
          Poprzednie
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!source.data?.hasMore || source.loading}
          onClick={() => setOffset((n) => n + 10)}
        >
          Następne
        </button>
      </div>
    </fieldset>
  );
}
export function OfferSnapshot({ value }: { value: unknown }) {
  const offer = rec(value),
    terms = rec(offer.terms),
    pricing = rec(offer.pricing),
    client = rec(offer.client),
    contact = rec(offer.contact);
  return (
    <section className="sales-offer-snapshot">
      <h3>
        Rewizja {String(offer.revision)} · {String(offer.title)}
      </h3>
      <p>
        {String(client.organizationName)} · kontakt: {String(contact.title)}
      </p>
      <p className="preserve-lines">{String(terms.scope)}</p>
      <p>
        Ważna do {dateLabel(String(terms.validUntil))} · ceny{" "}
        {terms.priceBasis === "net" ? "netto" : "brutto"}
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Pozycja</th>
              <th>Ilość</th>
              <th>Jednostka</th>
              <th>Cena jednostkowa</th>
              <th>Wartość</th>
            </tr>
          </thead>
          <tbody>
            {list(pricing.lines).map((l, i) => (
              <tr key={i}>
                <td>{String(l.label)}</td>
                <td>
                  {(Number(l.quantityMilli) / 1000).toLocaleString("pl-PL")}
                </td>
                <td>{units[String(l.unit)]}</td>
                <td>{salesAmount(l.unitPriceMinor, pricing.currency)}</td>
                <td>{salesAmount(l.totalMinor, pricing.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        <strong>
          Łącznie: {salesAmount(pricing.totalMinor, pricing.currency)}{" "}
          {pricing.priceBasis === "net" ? "netto" : "brutto"}
        </strong>
      </p>
      <details>
        <summary>Źródła i odcisk wersji</summary>
        <p>
          Klient: {String(client.id)} · wersja {String(client.version)}.
          Kontakt: {String(contact.id)} · wersja {String(contact.version)}.
        </p>
        <code className="sales-hash">{String(offer.hash)}</code>
      </details>
    </section>
  );
}
type LineInput = {
  label: string;
  unit: string;
  quantity: string;
  price: string;
};
type Spec = { action: string; kind?: string; parent?: Entity };
export function SalesWorkflow({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const [offset, setOffset] = useState(0),
    [spec, setSpec] = useState<Spec | null>(null);
  const result = useResource<{ workflow: SalesView }>(
    `/api/sales/${item.id}/workflow?limit=10&offset=${offset}`,
    revision + item.version,
    5000,
  );
  if (result.error) return <Notice tone="error">{result.error}</Notice>;
  if (!result.data || result.loading) return <Loading />;
  const view = result.data.workflow,
    e = view.record,
    kind = String(e.data.kind);
  const allowed = (action: string) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((t) => t.id === `ops.sales.${action}`);
  const actorOwns =
    context.principal.id ===
    (kind === "next_step"
      ? e.data.ownerPrincipalId
      : view.deal?.data.ownerPrincipalId);
  const link = (e: Entity) => (
    <button
      className="action-row"
      key={e.id}
      onClick={() => navigate(`module/sales/${e.id}`)}
    >
      <span>
        {kinds[String(e.data.kind)]}: {e.title}
      </span>
      <Badge status={e.status} />
    </button>
  );
  return (
    <section className="card sales-workflow">
      <div className="card-heading">
        <h2>{kinds[kind] ?? "Sprzedaż"} · obieg sprawy</h2>
      </div>
      {view.legacy && (
        <Notice>
          Historyczny wpis. Brakujące decyzje i poświadczenia nie zostały
          dopisane. Nowa oferta wymaga pełnego obiegu.
        </Notice>
      )}
      {view.deal && (
        <p>
          Odpowiedzialny za szansę:{" "}
          <strong>
            {String(view.deal.data.ownerPrincipalId ?? "Nieprzypisany")}
          </strong>
          {!view.ownerActive && " · konto niedostępne"}
        </p>
      )}
      {kind === "offer" && !!e.data.offer && (
        <>
          <OfferSnapshot value={e.data.offer} />
          {view.sourceCurrent === false && (
            <Notice>
              {view.acceptanceCurrent
                ? "Dane kontaktowe zmieniły się po uzgodnieniu. Zachowana akceptacja dotyczy wyłącznie widocznej migawki oferty."
                : "Klient lub kontakt zmienił się. Przygotuj nową rewizję przed kolejną decyzją."}{" "}
              {view.sourceProblem}
            </Notice>
          )}
          <p>
            Akceptacja klienta:{" "}
            <strong>
              {view.acceptanceCurrent
                ? "potwierdzona dla tej rewizji"
                : "brak obowiązującej akceptacji"}
            </strong>
          </p>
          {[
            ["review", "Decyzja wewnętrzna"],
            ["dispatch", "Przekazanie klientowi"],
            ["acceptance", "Decyzja klienta"],
            ["decline", "Odmowa klienta"],
            ["cancellation", "Wycofanie ustaleń"],
          ].map(([key, label]) => {
            const p = rec(e.data[key!]);
            return Object.keys(p).length ? (
              <div className="sales-proof" key={key}>
                <strong>{label}</strong>
                <p>{String(p.note ?? "")}</p>
                <p>
                  {String(p.evidenceReference ?? p.decision ?? "")} ·{" "}
                  {String(p.actorId)} · {dateLabel(String(p.recordedOn))}
                </p>
              </div>
            ) : null;
          })}
          {list(e.data.revisionHistory).map((r, i) => (
            <details key={i}>
              <summary>
                Historia rewizji {String(rec(r.offer).revision)} ·{" "}
                {String(r.reason)}
              </summary>
              <OfferSnapshot value={r.offer} />
              <p>
                Wcześniejsza akceptacja:{" "}
                {r.acceptance ? "zachowana historycznie" : "brak"}. Wcześniejsze
                przekazanie: {r.dispatch ? "poświadczone" : "brak"}.
              </p>
            </details>
          ))}
        </>
      )}
      {kind === "next_step" && (
        <>
          <p>{String(e.data.description)}</p>
          <p>
            Właściciel: {String(e.data.ownerPrincipalId)} · termin{" "}
            {dateLabel(String(e.data.dueDate))}
          </p>
          {["assigned", "accepted"].includes(e.status) &&
            String(e.data.dueDate) < view.currentDay && (
              <Notice>Termin minął. Krok nadal wymaga rozstrzygnięcia.</Notice>
            )}
          {!!e.data.ownerAcceptance && (
            <p>Przyjęte przez: {String(rec(e.data.ownerAcceptance).actorId)}</p>
          )}
          {!!e.data.completion && (
            <p>
              Rezultat: {String(rec(e.data.completion).note)} · dowód{" "}
              {String(rec(e.data.completion).evidenceReference)}
            </p>
          )}
          {!!e.data.decline && (
            <Notice>
              Odmowa właściciela: {String(rec(e.data.decline).reason)}
            </Notice>
          )}
        </>
      )}
      {view.nextStep && kind !== "next_step" && (
        <div>
          <h3>Następny krok</h3>
          {link(view.nextStep)}
          <p>
            {String(view.nextStep.data.ownerPrincipalId)} ·{" "}
            {dateLabel(String(view.nextStep.data.dueDate))}
          </p>
        </div>
      )}
      {view.deal && !view.nextStep && kind !== "next_step" && (
        <p className="muted">Brak otwartego następnego kroku.</p>
      )}
      <div className="button-row">
        {allowed("create") && kind === "client" && (
          <>
            <button
              className="button secondary"
              onClick={() =>
                setSpec({ action: "create", kind: "contact", parent: e })
              }
            >
              Dodaj kontakt
            </button>
            <button
              className="button secondary"
              onClick={() =>
                setSpec({ action: "create", kind: "deal", parent: e })
              }
            >
              Otwórz szansę
            </button>
          </>
        )}
        {allowed("create") &&
          kind === "deal" &&
          ["open", "qualified"].includes(e.status) && (
            <button
              className="button secondary"
              disabled={!actorOwns}
              onClick={() =>
                setSpec({ action: "create", kind: "offer", parent: e })
              }
            >
              Przygotuj ofertę
            </button>
          )}
        {salesAvailable(e, view.legacy)
          .filter(allowed)
          .map((action) => (
            <button
              key={action}
              className="button secondary"
              disabled={
                action !== "assignSalesOwner" &&
                !(action === "cancelNextStep"
                  ? context.principal.id === view.deal?.data.ownerPrincipalId
                  : actorOwns)
              }
              onClick={() => setSpec({ action })}
            >
              {salesLabels[action]}
            </button>
          ))}
      </div>
      {view.deal && kind !== "deal" && link(view.deal)}
      {view.children.length > 0 && (
        <div>
          <h3>Powiązane wpisy</h3>
          {view.children.map(link)}
        </div>
      )}
      {(offset > 0 || view.hasMore) && (
        <div className="button-row">
          <button
            className="text-button"
            disabled={!offset}
            onClick={() => setOffset((n) => Math.max(0, n - 10))}
          >
            Poprzednie wpisy
          </button>
          <button
            className="text-button"
            disabled={!view.hasMore}
            onClick={() => setOffset((n) => n + 10)}
          >
            Dalsze wpisy
          </button>
        </div>
      )}
      {spec && (
        <SalesForm
          key={`${e.id}-${spec.action}-${spec.kind}`}
          spec={spec}
          view={view}
          context={context}
          onClose={() => setSpec(null)}
        />
      )}
    </section>
  );
}
export function SalesForm({
  spec = { action: "create" },
  view,
  context,
  onClose,
}: {
  spec?: Spec;
  view?: SalesView;
  context: Context;
  onClose(): void;
}) {
  const { action } = spec,
    creating = action === "create",
    editing = creating || action === "reviseOffer";
  const record = view?.record,
    old = rec(rec(record?.data.offer).terms);
  const [kind, setKind] = useState(spec.kind ?? "client"),
    [parent, setParent] = useState<Entity | null>(
      spec.parent ?? view?.deal ?? null,
    );
  const [contact, setContact] = useState<Entity | null>(null);
  const [values, setValues] = useState<Record<string, string>>({
    title: action === "reviseOffer" ? (record?.title ?? "") : "",
    organizationName: "",
    scope: String(old.scope ?? ""),
    validUntil: String(old.validUntil ?? ""),
    currency: String(old.currency ?? "PLN"),
    priceBasis: String(old.priceBasis ?? "net"),
    ownerPrincipalId: String(
      view?.deal?.data.ownerPrincipalId ?? context.principal.id,
    ),
    decision: "approved",
    channel: "email",
  });
  const [lines, setLines] = useState<LineInput[]>(() =>
    list(old.lines).length
      ? list(old.lines).map((l) => ({
          label: String(l.label),
          unit: String(l.unit),
          quantity: String(Number(l.quantityMilli) / 1000),
          price: (Number(l.unitPriceMinor) / 100).toFixed(2),
        }))
      : [{ label: "", unit: "fixed", quantity: "1", price: "" }],
  );
  const offerEditing =
    action === "reviseOffer" || (creating && kind === "offer");
  const owners = useResource<{ owners: { id: string; label: string }[] }>(
    "/api/sales/owners",
  );
  const clientSource = useResource<{ item: Entity }>(
    offerEditing && parent
      ? `/api/workspace/sales/${String(parent.data.parentId)}`
      : null,
  );
  const contactSource = useResource<{ item: Entity }>(
    offerEditing && parent?.data.contactId
      ? `/api/workspace/sales/${String(parent.data.contactId)}`
      : null,
  );
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [key] = useState(requestKey);
  const set = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const field = (
    key: string,
    label: string,
    type = "text",
    options?: Record<string, string>,
    required = true,
  ) => (
    <label className={`field ${type === "textarea" ? "wide" : ""}`} key={key}>
      <span>{label}</span>
      {type === "textarea" ? (
        <textarea
          required={required}
          maxLength={2000}
          value={values[key] ?? ""}
          onChange={(e) => set(key, e.target.value)}
        />
      ) : options ? (
        <select
          required={required}
          value={values[key] ?? ""}
          onChange={(e) => set(key, e.target.value)}
        >
          <option value="">Wybierz…</option>
          {Object.entries(options).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          required={required}
          maxLength={key === "title" ? 160 : 200}
          value={values[key] ?? ""}
          onChange={(e) => set(key, e.target.value)}
        />
      )}
    </label>
  );
  const ownerField = () =>
    field(
      "ownerPrincipalId",
      "Odpowiedzialny",
      "select",
      Object.fromEntries(
        (owners.data?.owners ?? []).map((o) => [o.id, o.label]),
      ),
    );
  const terms = (): OfferTerms => ({
    scope: values.scope!,
    validUntil: values.validUntil!,
    currency: values.currency as OfferTerms["currency"],
    priceBasis: values.priceBasis as OfferTerms["priceBasis"],
    lines: lines.map((l) => ({
      label: l.label,
      unit: l.unit as OfferTerms["lines"][number]["unit"],
      quantityMilli: salesScaled(l.quantity, 3),
      unitPriceMinor: salesScaled(l.price, 2),
    })),
  });
  let preview = "Uzupełnij pozycje i termin, aby zobaczyć kalkulację.";
  if (offerEditing) {
    try {
      const p = calculateOffer(terms());
      preview = `${salesAmount(p.totalMinor, p.currency)} ${p.priceBasis === "net" ? "netto" : "brutto"}`;
    } catch {
      /* Incomplete form, validated at submission. */
    }
  }
  const needsHuman = [
    "reviewOffer",
    "recordDispatch",
    "acceptOffer",
    "declineOffer",
    "cancelOffer",
    "acceptNextStep",
    "declineNextStep",
    "completeNextStep",
    "cancelNextStep",
    "lose",
  ].includes(action);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (needsHuman && !confirmed)
        throw Error("Potwierdź decyzję lub wykonane zdarzenie.");
      const input: Record<string, unknown> = creating
        ? { title: values.title }
        : { id: record!.id, expectedVersion: record!.version };
      let sourcePins: Record<string, number> = {};
      if (offerEditing) {
        if (
          !parent ||
          clientSource.loading ||
          contactSource.loading ||
          clientSource.error ||
          contactSource.error ||
          clientSource.data?.item.id !== parent.data.parentId ||
          contactSource.data?.item.id !== parent.data.contactId
        )
          throw Error(
            "Wybierz szansę z aktualnym klientem i kontaktem. Najpierw przypisz brakujący kontakt do szansy.",
          );
        sourcePins = {
          expectedDealVersion: parent.version,
          expectedClientVersion: clientSource.data!.item.version,
          expectedContactVersion: contactSource.data!.item.version,
        };
        calculateOffer(terms());
      }
      if (creating) {
        const data: Record<string, unknown> = { kind };
        if (kind === "client") {
          data.organizationName = values.organizationName;
          if (values.contactEmail) data.contactEmail = values.contactEmail;
        } else {
          if (!parent) throw Error("Wybierz powiązany wpis.");
          data.parentId = parent.id;
          if (kind === "contact")
            for (const name of ["contactEmail", "phone", "jobTitle"]) {
              if (values[name]) data[name] = values[name];
            }
          if (kind === "deal") {
            data.ownerPrincipalId = values.ownerPrincipalId;
            if (contact) data.contactId = contact.id;
          }
          if (kind === "offer")
            Object.assign(data, sourcePins, { terms: terms() });
        }
        input.data = data;
      } else if (action === "reviseOffer")
        Object.assign(input, sourcePins, {
          terms: terms(),
          title: values.title,
          reason: values.reason,
        });
      else if (action === "qualify") input.qualification = values.qualification;
      else if (action === "setDealContact") {
        if (!contact) throw Error("Wybierz kontakt tej firmy.");
        Object.assign(input, {
          contactId: contact.id,
          expectedContactVersion: contact.version,
          reason: values.reason,
        });
      } else if (action === "assignSalesOwner")
        Object.assign(input, {
          ownerPrincipalId: values.ownerPrincipalId,
          reason: values.reason,
        });
      else if (action === "reviewOffer")
        Object.assign(input, {
          decision: values.decision,
          note: values.note,
          humanDecision: true,
        });
      else if (action === "recordDispatch")
        Object.assign(input, {
          channel: values.channel,
          dispatchedOn: values.dispatchedOn,
          evidenceReference: values.evidenceReference,
          note: values.note,
          humanConfirmed: true,
        });
      else if (action === "acceptOffer")
        Object.assign(input, {
          acceptedOn: values.acceptedOn,
          acceptanceNote: values.acceptanceNote,
          evidenceReference: values.evidenceReference,
          humanDecision: true,
        });
      else if (
        ["declineOffer", "cancelOffer", "completeNextStep"].includes(action)
      ) {
        const day =
          action === "declineOffer"
            ? "decidedOn"
            : action === "cancelOffer"
              ? "cancelledOn"
              : "completedOn";
        Object.assign(input, {
          [day]: values[day],
          evidenceReference: values.evidenceReference,
          note: values.note,
          humanConfirmed: true,
        });
      } else if (action === "scheduleNextStep")
        Object.assign(input, {
          title: values.title,
          description: values.description,
          ownerPrincipalId: values.ownerPrincipalId,
          dueDate: values.dueDate,
        });
      else if (action === "acceptNextStep") input.humanConfirmed = true;
      else if (["lose", "cancelNextStep", "declineNextStep"].includes(action))
        Object.assign(input, { reason: values.reason, humanDecision: true });
      else if (action === "handoff")
        input.acceptanceCriteria = values.acceptanceCriteria;
      const response = await post<{ run: Run }>("/api/commands", {
        toolId: `ops.sales.${action}`,
        input,
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${response.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={salesLabels[action] ?? action} onClose={onClose}>
      <form className="command-form" onSubmit={(e) => void submit(e)}>
        <div className="sheet-body">
          {record &&
            !offerEditing &&
            record.data.kind === "offer" &&
            !!record.data.offer && <OfferSnapshot value={record.data.offer} />}
          {action === "cancelOffer" && (
            <Notice>
              Wycofanie uzgodnionej oferty wymaga rzeczywistego porozumienia i
              wskazania dowodu. Powiązana realizacja lub aktywna współpraca
              blokuje tę operację.
            </Notice>
          )}
          {creating && (
            <label className="field">
              <span>Rodzaj wpisu</span>
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setParent(null);
                  setContact(null);
                }}
              >
                {Object.entries(kinds)
                  .filter(([k]) => k !== "next_step")
                  .map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <div className="form-grid">
            {(editing || action === "scheduleNextStep") &&
              field("title", "Nazwa")}
            {creating && kind === "client" && (
              <>
                {field("organizationName", "Pełna nazwa firmy")}
                {field(
                  "contactEmail",
                  "E-mail ogólny",
                  "email",
                  undefined,
                  false,
                )}
              </>
            )}
            {creating && kind === "contact" && (
              <>
                {field(
                  "contactEmail",
                  "E-mail kontaktu",
                  "email",
                  undefined,
                  false,
                )}
                {field("phone", "Telefon", "text", undefined, false)}
                {field("jobTitle", "Rola u klienta", "text", undefined, false)}
              </>
            )}
            {((creating && kind === "deal") ||
              ["assignSalesOwner", "scheduleNextStep"].includes(action)) &&
              ownerField()}
          </div>
          {creating && kind !== "client" && (
            <SalesPicker
              key={kind}
              kind={kind === "offer" ? "deal" : "client"}
              label={kind === "offer" ? "Szansa" : "Klient"}
              value={parent}
              onChange={(e) => {
                setParent(e);
                setContact(null);
              }}
            />
          )}
          {((creating && kind === "deal" && parent) ||
            action === "setDealContact") && (
            <SalesPicker
              kind="contact"
              label="Kontakt klienta"
              parentId={String(creating ? parent!.id : record!.data.parentId)}
              value={contact}
              onChange={setContact}
            />
          )}
          {offerEditing && (
            <>
              <div className="form-grid">
                {field("scope", "Uzgadniany zakres", "textarea")}
                {field("validUntil", "Oferta ważna do", "date")}
                {field("currency", "Waluta", "select", {
                  PLN: "PLN",
                  EUR: "EUR",
                  USD: "USD",
                })}
                {field("priceBasis", "Podstawa cen", "select", {
                  net: "Netto",
                  gross: "Brutto",
                })}
              </div>
              <h3>Pozycje kalkulacji</h3>
              {lines.map((line, index) => (
                <fieldset className="sales-line" key={index}>
                  <legend>Pozycja {index + 1}</legend>
                  <div className="form-grid">
                    {(
                      [
                        ["label", "Opis"],
                        ["quantity", "Ilość"],
                        ["price", "Cena jednostkowa"],
                      ] as const
                    ).map(([key, label]) => (
                      <label className="field" key={key}>
                        <span>{label}</span>
                        <input
                          required
                          maxLength={key === "label" ? 200 : 16}
                          inputMode={key === "label" ? "text" : "decimal"}
                          value={line[key]}
                          onChange={(e) =>
                            setLines((current) =>
                              current.map((l, i) =>
                                i === index
                                  ? { ...l, [key]: e.target.value }
                                  : l,
                              ),
                            )
                          }
                        />
                      </label>
                    ))}
                    <label className="field">
                      <span>Jednostka</span>
                      <select
                        value={line.unit}
                        onChange={(e) =>
                          setLines((current) =>
                            current.map((l, i) =>
                              i === index
                                ? {
                                    ...l,
                                    unit: e.target.value,
                                    ...(e.target.value === "fixed"
                                      ? { quantity: "1" }
                                      : {}),
                                  }
                                : l,
                            ),
                          )
                        }
                      >
                        {Object.entries(units).map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={lines.length === 1}
                    onClick={() =>
                      setLines((ls) => ls.filter((_, i) => i !== index))
                    }
                  >
                    Usuń pozycję {index + 1}
                  </button>
                </fieldset>
              ))}
              <button
                type="button"
                className="button secondary"
                disabled={lines.length >= 40}
                onClick={() =>
                  setLines((ls) => [
                    ...ls,
                    { label: "", unit: "hour", quantity: "1", price: "" },
                  ])
                }
              >
                Dodaj pozycję
              </button>
              <p role="status">
                <strong>{preview}</strong>
              </p>
              {parent && (
                <p>
                  Szansa: {parent.title}. Kontakt:{" "}
                  {contactSource.data?.item.title ??
                    "Brak przypisanego kontaktu"}
                  .
                </p>
              )}
              {(clientSource.error || contactSource.error) && (
                <Notice tone="error">
                  {clientSource.error || contactSource.error}
                </Notice>
              )}
            </>
          )}
          <div className="form-grid">
            {[
              "reviseOffer",
              "setDealContact",
              "assignSalesOwner",
              "lose",
              "cancelNextStep",
              "declineNextStep",
            ].includes(action) && field("reason", "Powód", "textarea")}
            {action === "qualify" &&
              field(
                "qualification",
                "Potrzeba i potwierdzone warunki",
                "textarea",
              )}
            {action === "reviewOffer" && (
              <>
                {field("decision", "Decyzja wewnętrzna", "select", {
                  approved: "Zatwierdzam",
                  rejected: "Odrzucam",
                })}
                {field("note", "Uzasadnienie", "textarea")}
              </>
            )}
            {action === "recordDispatch" && (
              <>
                {field("channel", "Sposób przekazania", "select", {
                  email: "E-mail",
                  meeting: "Spotkanie",
                  portal: "Portal klienta",
                  other: "Inny",
                })}
                {field("dispatchedOn", "Rzeczywista data przekazania", "date")}
              </>
            )}
            {action === "acceptOffer" && (
              <>
                {field("acceptedOn", "Data decyzji klienta", "date")}
                {field(
                  "acceptanceNote",
                  "Treść potwierdzenia klienta",
                  "textarea",
                )}
              </>
            )}
            {action === "declineOffer" &&
              field("decidedOn", "Data odmowy klienta", "date")}
            {action === "cancelOffer" &&
              field("cancelledOn", "Data wycofania ustaleń", "date")}
            {action === "completeNextStep" &&
              field("completedOn", "Rzeczywista data wykonania", "date")}
            {[
              "recordDispatch",
              "acceptOffer",
              "declineOffer",
              "cancelOffer",
              "completeNextStep",
            ].includes(action) &&
              field("evidenceReference", "Oznaczenie dowodu / dokumentu")}
            {[
              "recordDispatch",
              "declineOffer",
              "cancelOffer",
              "completeNextStep",
            ].includes(action) &&
              field("note", "Co potwierdza dowód", "textarea")}
            {action === "scheduleNextStep" && (
              <>
                {field("description", "Oczekiwany rezultat", "textarea")}
                {field("dueDate", "Termin", "date")}
              </>
            )}
            {action === "handoff" &&
              field(
                "acceptanceCriteria",
                "Kryteria odbioru realizacji",
                "textarea",
              )}
          </div>
          {needsHuman && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                required
              />
              Potwierdzam własną decyzję lub sprawdzone zdarzenie opisane
              powyżej.
            </label>
          )}
          {owners.error && <Notice tone="error">{owners.error}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="sheet-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Wróć
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Przygotowywanie…" : "Przygotuj do zgody"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
