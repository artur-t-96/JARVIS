import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { purchaseMoney } from "./Purchasing";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Badge, Loading, Notice, Sheet } from "./ui";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
export interface LicenseView {
  pool: Entity;
  terms: {
    record: Entity;
    problem: string | null;
    costDecisionCurrent: boolean;
  }[];
  costKnown: boolean;
  usedSeats: number;
  currentDay: string;
  truncated: boolean;
}
type Action =
  | "proposeTerms"
  | "reviseTerms"
  | "decideTerms"
  | "confirmTerms"
  | "cancelTerms"
  | "assignOwner";
const labels: Record<Action, string> = {
  proposeTerms: "Zaproponuj warunki licencji",
  reviseTerms: "Zmień propozycję warunków",
  decideTerms: "Decyzja kosztowa",
  confirmTerms: "Potwierdź umowę i limit miejsc",
  cancelTerms: "Anuluj propozycję",
  assignOwner: "Przekaż odpowiedzialność",
};
export function licenseSidebarAction(item: Entity, action: string) {
  if (item.data.kind === "license_terms" || action in labels) return false;
  return (
    !["renew", "resize"].includes(action) || !item.data.contractWorkflowVersion
  );
}
export function licenseMinor(input: string) {
  if (!/^\d{1,10}(?:[.,]\d{1,2})?$/.test(input.trim()))
    throw Error("Podaj kwotę z najwyżej dwoma miejscami po przecinku.");
  const [whole, fraction = ""] = input.trim().replace(",", ".").split(".");
  const n = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(n) || n > 100_000_000_000)
    throw Error("Kwota przekracza dopuszczalny zakres.");
  return n;
}
export function LicenseForm({
  action,
  view,
  term,
  context,
  onClose,
}: {
  action: Action;
  view: LicenseView;
  term?: Entity;
  context: Context;
  onClose(): void;
}) {
  const source = rec(
    (
      term ??
      view.terms.find((t) => t.record.id === view.pool.data.activeTermsId)
        ?.record
    )?.data.terms,
  );
  const [values, setValues] = useState<Record<string, string>>(() => ({
    supplierId: String(source.supplierId ?? view.pool.data.supplierId ?? ""),
    agreementReference: String(source.agreementReference ?? ""),
    ownerPrincipalId: String(
      view.pool.data.ownerPrincipalId ?? context.principal.id,
    ),
    validFrom: String(source.validFrom ?? ""),
    expiresOn: String(source.expiresOn ?? ""),
    totalSeats: String(source.totalSeats ?? view.pool.data.totalSeats),
    amount:
      typeof source.totalCostMinor === "number"
        ? (source.totalCostMinor / 100).toFixed(2)
        : "",
    currency: String(source.currency ?? "PLN"),
    priceBasis: String(source.priceBasis ?? "gross"),
    renewalLeadDays: String(source.renewalLeadDays ?? 30),
    description: String(source.description ?? ""),
    reason: "",
    note: "",
    decision: "approved",
    confirmationReference: "",
    confirmationLine: "1",
    confirmedOn: "",
    evidenceNote: "",
  }));
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [key] = useState(requestKey);
  const editing = action === "proposeTerms" || action === "reviseTerms";
  const owners = useResource<{ owners: { id: string; label: string }[] }>(
    editing || action === "assignOwner" ? "/api/licenses/owners" : null,
  );
  const suppliers = useResource<{ items: Entity[] }>(
    editing ? "/api/workspace/purchases" : null,
  );
  const set = (key: string, value: string) =>
    setValues((v) => ({ ...v, [key]: value }));
  const field = (
    key: string,
    label: string,
    type = "text",
    options?: { id: string; label: string }[],
  ) => (
    <label className={type === "textarea" ? "field wide" : "field"} key={key}>
      <span>{label}</span>
      {options ? (
        <select
          required
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
        >
          <option value="">Wybierz</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          required
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
          maxLength={2000}
        />
      ) : (
        <input
          required
          type={type}
          value={values[key]}
          onChange={(e) => set(key, e.target.value)}
          maxLength={200}
          min={
            type === "number" ? (key === "renewalLeadDays" ? 0 : 1) : undefined
          }
          max={
            type === "number"
              ? key === "renewalLeadDays"
                ? 365
                : 100000
              : undefined
          }
        />
      )}
    </label>
  );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const target =
        action === "proposeTerms" || action === "assignOwner"
          ? view.pool
          : term;
      if (!target) throw Error("Wybierz propozycję warunków.");
      const input: Record<string, unknown> = {
        id: target.id,
        expectedVersion: target.version,
      };
      if (editing) {
        const supplier = suppliers.data?.items.find(
          (s) =>
            s.id === values.supplierId &&
            s.data.kind === "supplier" &&
            s.status === "active",
        );
        if (!supplier)
          throw Error("Wybierz aktywnego dostawcę z aktualnego katalogu.");
        if (!owners.data?.owners.some((o) => o.id === values.ownerPrincipalId))
          throw Error("Wybierz aktywnego właściciela licencji.");
        if (values.validFrom! > values.expiresOn!)
          throw Error("Koniec okresu poprzedza jego początek.");
        input.terms = {
          supplierId: supplier.id,
          supplierVersion: supplier.version,
          agreementReference: values.agreementReference,
          ownerPrincipalId: values.ownerPrincipalId,
          validFrom: values.validFrom,
          expiresOn: values.expiresOn,
          totalSeats: Number(values.totalSeats),
          totalCostMinor: licenseMinor(values.amount!),
          currency: values.currency,
          priceBasis: values.priceBasis,
          renewalLeadDays: Number(values.renewalLeadDays),
          description: values.description,
        };
        if (action === "reviseTerms") input.reason = values.reason;
      } else if (action === "decideTerms") {
        if (!confirmed)
          throw Error("Potwierdź własną decyzję o kosztach i zakresie.");
        Object.assign(input, {
          decision: values.decision,
          note: values.note,
          humanDecision: true,
        });
      } else if (action === "confirmTerms") {
        if (!confirmed) throw Error("Potwierdź sprawdzenie dokumentu umowy.");
        Object.assign(input, {
          costDecisionHash: rec(term?.data.costDecision).hash,
          confirmationReference: values.confirmationReference,
          confirmationLine: Number(values.confirmationLine),
          confirmedOn: values.confirmedOn,
          evidenceNote: values.evidenceNote,
          humanConfirmed: true,
        });
      } else {
        input.reason = values.reason;
        if (action === "assignOwner")
          input.ownerPrincipalId = values.ownerPrincipalId;
      }
      setBusy(true);
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: `ops.licenses.${action}`,
        input,
        idempotencyKey: key,
      });
      navigate(`runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Sheet title={labels[action]} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <p>
          Licencja: <strong>{view.pool.title}</strong>. Przydzielono{" "}
          {view.usedSeats} z {String(view.pool.data.totalSeats)} miejsc.
        </p>
        {editing && (
          <Notice>
            Kwota obejmuje cały podany okres i wszystkie miejsca. Propozycja
            zachowa bieżące uprawnienie do czasu osobnej decyzji i potwierdzenia
            umowy.
          </Notice>
        )}
        {term && !editing && <LicenseTerms record={term} />}
        <div className="form-grid">
          {editing && (
            <>
              {field(
                "supplierId",
                "Dostawca",
                "select",
                (suppliers.data?.items ?? [])
                  .filter(
                    (e) => e.data.kind === "supplier" && e.status === "active",
                  )
                  .map((e) => ({ id: e.id, label: e.title })),
              )}
              {field("agreementReference", "Numer umowy / warunków")}
              {field(
                "ownerPrincipalId",
                "Właściciel decyzji i odnowienia",
                "select",
                owners.data?.owners ?? [],
              )}
              {field("validFrom", "Początek okresu", "date")}
              {field("expiresOn", "Koniec okresu", "date")}
              {field("totalSeats", "Uzgodniona liczba miejsc", "number")}
              {field("amount", "Koszt całego okresu")}
              {field(
                "currency",
                "Waluta",
                "select",
                ["PLN", "EUR", "USD"].map((s) => ({ id: s, label: s })),
              )}
              {field("priceBasis", "Podstawa ceny", "select", [
                { id: "gross", label: "Brutto" },
                { id: "net", label: "Netto" },
              ])}
              {field(
                "renewalLeadDays",
                "Przypomnienie przed końcem — dni",
                "number",
              )}
              {field("description", "Zakres i podstawa warunków", "textarea")}
            </>
          )}
          {action === "assignOwner" &&
            field(
              "ownerPrincipalId",
              "Nowy właściciel",
              "select",
              owners.data?.owners ?? [],
            )}
          {["reviseTerms", "cancelTerms", "assignOwner"].includes(action) &&
            field("reason", "Uzasadnienie", "textarea")}
          {action === "decideTerms" && (
            <>
              {field("decision", "Decyzja", "select", [
                { id: "approved", label: "Zatwierdzam koszt i zakres" },
                { id: "rejected", label: "Odrzucam warunki" },
              ])}
              {field("note", "Uzasadnienie decyzji", "textarea")}
            </>
          )}
          {action === "confirmTerms" && (
            <>
              {field("confirmationReference", "Dokument potwierdzający umowę")}
              {field("confirmationLine", "Pozycja dokumentu", "number")}
              {field("confirmedOn", "Data potwierdzenia", "date")}
              {field("evidenceNote", "Co sprawdzono w dokumencie", "textarea")}
            </>
          )}
        </div>
        {["decideTerms", "confirmTerms"].includes(action) && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              {action === "decideTerms"
                ? "Podejmuję tę decyzję jako wskazany właściciel."
                : "Sprawdziłem dokument i potwierdzam obowiązywanie dokładnie tych warunków."}
            </span>
          </label>
        )}
        {action === "assignOwner" && (
          <Notice>
            Zmiana właściciela unieważni decyzję otwartej propozycji. Autorzy
            wcześniejszych umów pozostaną w historii.
          </Notice>
        )}
        {action === "confirmTerms" && (
          <Notice>
            Ta operacja zapisze lokalne uprawnienie. Nie wykonuje płatności,
            zakupu ani utworzenia kont w usłudze.
          </Notice>
        )}
        {(error || suppliers.error || owners.error) && (
          <Notice tone="error">
            {error || suppliers.error || owners.error}
          </Notice>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Anuluj
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Przygotowywanie…" : "Przygotuj plan do zgody"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
export function LicenseTerms({ record }: { record: Entity }) {
  const t = rec(record.data.terms),
    d = rec(record.data.costDecision),
    c = rec(record.data.confirmation);
  return (
    <div>
      <p>
        <strong>{String(t.agreementReference)}</strong> ·{" "}
        {dateLabel(String(t.validFrom))} – {dateLabel(String(t.expiresOn))} ·{" "}
        {String(t.totalSeats)} miejsc
      </p>
      <p>
        Koszt całego okresu:{" "}
        <strong>
          {purchaseMoney(t.totalCostMinor, t.currency)}{" "}
          {t.priceBasis === "net" ? "netto" : "brutto"}
        </strong>
      </p>
      <p>{String(t.description)}</p>
      <p>
        Właściciel warunków: {String(t.ownerPrincipalId)} · Przypomnienie{" "}
        {String(t.renewalLeadDays)} dni przed końcem.
      </p>
      {!!d.actorId && (
        <p>
          Decyzja: {d.decision === "approved" ? "zatwierdzona" : "odrzucona"} ·{" "}
          {String(d.actorId)} · {dateLabel(String(d.at), true)} ·{" "}
          {String(d.note)}. Zgodę na zapis wydał: {String(d.approvedBy)}.
        </p>
      )}
      {!!c.actorId && (
        <p>
          Dokument: {String(c.documentReference)}, pozycja {String(c.line)} ·{" "}
          {dateLabel(String(c.confirmedOn))} · {String(c.evidenceNote)}.
          Poświadczył: {String(c.actorId)}; zgodę na zapis wydał:{" "}
          {String(c.approvedBy)}.
        </p>
      )}
    </div>
  );
}
export function LicenseContracts({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const canRead = context.principal.scopes?.some(
    (s) => s === "*" || s === "purchases",
  );
  const resource = useResource<{ contracts: LicenseView }>(
    canRead ? `/api/licenses/${item.id}/contracts` : null,
    revision + item.version,
  );
  const [form, setForm] = useState<{ action: Action; term?: Entity } | null>(
    null,
  );
  if (!canRead)
    return (
      <Notice>
        Przydział miejsca i potwierdzenie konta w usłudze są osobnymi faktami.
        Odczyt warunków i kosztów wymaga również dostępu do zakupów.
      </Notice>
    );
  if (resource.loading) return <Loading />;
  if (resource.error) return <Notice tone="error">{resource.error}</Notice>;
  const view = resource.data?.contracts;
  if (!view) return null;
  const may = (a: Action) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((t) => t.id === `ops.licenses.${a}`);
  return (
    <section className="card" aria-label="Umowy, koszty i odnowienia licencji">
      {form && (
        <LicenseForm
          {...form}
          view={view}
          context={context}
          onClose={() => setForm(null)}
        />
      )}
      <span className="eyebrow">
        WARUNKI → DECYZJA KOSZTOWA → POTWIERDZENIE UMOWY
      </span>
      <h2>Umowy, koszty i odnowienia</h2>
      {item.id !== view.pool.id && (
        <button
          className="text-button"
          onClick={() => navigate(`module/licenses/${view.pool.id}`)}
        >
          Otwórz pulę miejsc
        </button>
      )}
      <p>
        <strong>
          {view.usedSeats} / {String(view.pool.data.totalSeats)}
        </strong>{" "}
        miejsc przydzielonych · właściciel:{" "}
        {String(view.pool.data.ownerPrincipalId ?? "Nie wyznaczono")}
      </p>
      {!view.costKnown && (
        <Notice>
          Brak potwierdzonej umowy i kosztu. Miejsca i daty pochodzą z lokalnego
          wpisu bez udokumentowanych warunków.
        </Notice>
      )}
      <p className="muted">
        Odnowienie zaczyna się od propozycji i decyzji właściciela. Przydział
        miejsca nie potwierdza utworzenia konta w usłudze.
      </p>
      <div className="form-actions">
        {may("proposeTerms") && !view.pool.data.pendingTermsId && (
          <button
            className="button primary"
            onClick={() => setForm({ action: "proposeTerms" })}
          >
            Zaproponuj warunki lub odnowienie
          </button>
        )}
        {may("assignOwner") && (
          <button
            className="button secondary"
            onClick={() => setForm({ action: "assignOwner" })}
          >
            Przekaż odpowiedzialność
          </button>
        )}
      </div>
      {view.terms.map(({ record, problem, costDecisionCurrent }) => (
        <article key={record.id} className="delivery-receipt">
          <h3>
            {record.id === view.pool.data.activeTermsId
              ? "Obowiązujące warunki"
              : record.id === view.pool.data.pendingTermsId
                ? "Propozycja do decyzji"
                : "Historia warunków"}{" "}
            · wersja {record.version}
          </h3>
          <Badge status={record.status} />
          <LicenseTerms record={record} />
          {problem && <Notice>{problem}</Notice>}
          {record.id === view.pool.data.pendingTermsId && (
            <div className="form-actions">
              {may("reviseTerms") && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setForm({ action: "reviseTerms", term: record })
                  }
                >
                  Zmień warunki
                </button>
              )}
              {may("decideTerms") &&
                view.pool.data.ownerPrincipalId === context.principal.id && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setForm({ action: "decideTerms", term: record })
                    }
                  >
                    Decyzja kosztowa
                  </button>
                )}
              {may("confirmTerms") && costDecisionCurrent && !problem && (
                <button
                  className="button primary"
                  onClick={() =>
                    setForm({ action: "confirmTerms", term: record })
                  }
                >
                  Potwierdź umowę
                </button>
              )}
              {may("cancelTerms") && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setForm({ action: "cancelTerms", term: record })
                  }
                >
                  Anuluj propozycję
                </button>
              )}
            </div>
          )}
        </article>
      ))}
      {view.truncated && (
        <Notice>
          Pokazano 500 najnowszych propozycji. Starsze rekordy zachowano w
          historii.
        </Notice>
      )}
    </section>
  );
}
