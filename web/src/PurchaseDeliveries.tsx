import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Badge, Loading, Notice, Sheet } from "./ui";

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
export interface DeliveryView {
  order: Entity;
  receipts: Entity[];
  totals: {
    physicalQuantity: number;
    acceptedQuantity: number;
    confirmedQuantity: number;
    rejectedQuantity: number;
    unresolvedQuantity: number;
    unverifiedLegacyQuantity: number;
    outstandingQuantity: number;
  };
  proof: {
    version: number;
    hash: string;
    identity: {
      current: boolean;
      caseId: string | null;
      caseScopeRevision: number | null;
      caseRequirementId: string | null;
    };
  };
}
type Action =
  "recordDelivery" | "returnRejectedDelivery" | "registerDeliveredAssets";
function DeliveryForm({
  action,
  view,
  receipt,
  onClose,
}: {
  action: Action;
  view: DeliveryView;
  receipt?: Entity;
  onClose: () => void;
}) {
  const [key] = useState(requestKey),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [values, setValues] = useState<Record<string, string>>({
    documentNumber: "",
    documentLine: "1",
    quantityReceived: "1",
    quantityAccepted: "1",
    receivedOn: "",
    deliveryNote: "",
    rejectionReason: "",
    replacesLegacyQuantity: "0",
    returnedOn: "",
    returnReference: "",
    evidenceNote: "",
    serials: "",
    assetType: String(view.order.data.assetType ?? "laptop"),
    location: "",
    manufacturer: "",
    model: "",
  });
  const [confirmed, setConfirmed] = useState(false);
  const title =
    action === "recordDelivery"
      ? "Potwierdź przyjęcie dostawy"
      : action === "returnRejectedDelivery"
        ? "Potwierdź zwrot odrzuconych sztuk"
        : "Zarejestruj przyjęte wyposażenie";
  const field = (
    name: string,
    label: string,
    type = "text",
    required = true,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        value={values[name]}
        required={required}
        min={
          type === "number"
            ? name === "quantityAccepted" || name === "replacesLegacyQuantity"
              ? 0
              : 1
            : undefined
        }
        step={type === "number" ? 1 : undefined}
        onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
      />
    </label>
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const input: Record<string, unknown> = {
        id: view.order.id,
        expectedVersion: view.order.version,
        humanConfirmed: true,
      };
      if (action === "recordDelivery") {
        for (const name of ["documentNumber", "receivedOn", "deliveryNote"])
          input[name] = values[name];
        for (const name of [
          "documentLine",
          "quantityReceived",
          "quantityAccepted",
          "replacesLegacyQuantity",
        ])
          input[name] = Number(values[name]);
        if (Number(values.quantityReceived) < Number(values.quantityAccepted))
          throw Error("Przyjęta ilość nie może przekraczać otrzymanej.");
        if (values.rejectionReason)
          input.rejectionReason = values.rejectionReason;
      } else {
        if (!receipt) throw Error("Wybierz właściwą pozycję dostawy.");
        input.receiptId = receipt.id;
        input.expectedReceiptVersion = receipt.version;
        input.evidenceNote = values.evidenceNote;
        if (action === "returnRejectedDelivery") {
          input.returnedOn = values.returnedOn;
          input.returnReference = values.returnReference;
        } else {
          const serials = String(values.serials)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          const remaining =
            Number(rec(receipt.data.attestation).quantityAccepted) -
            (receipt.data.assetIds as string[]).length;
          if (!serials.length || serials.length > Math.min(100, remaining))
            throw Error(
              `Podaj od 1 do ${Math.min(100, remaining)} numerów seryjnych.`,
            );
          if (
            new Set(serials.map((s) => s.normalize("NFKC").toLowerCase()))
              .size !== serials.length
          )
            throw Error("Numery seryjne powtarzają się na liście.");
          input.assets = serials.map((serial) => ({
            title: `${view.order.title} · ${serial}`.slice(0, 160),
            serial,
            assetType: values.assetType,
            location: values.location,
            ...(values.manufacturer
              ? { manufacturer: values.manufacturer }
              : {}),
            ...(values.model ? { model: values.model } : {}),
          }));
        }
      }
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: `ops.purchases.${action}`,
        input,
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <Sheet title={title} subtitle={view.order.title} onClose={onClose}>
      <form className="command-form" onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          {action === "recordDelivery" ? (
            <>
              <p>
                Pozostaje do przyjęcia:{" "}
                <strong>{view.totals.outstandingQuantity} szt.</strong>{" "}
                Otrzymane uszkodzone lub nadmiarowe sztuki zapisz jako
                odrzucone.
              </p>
              {field("documentNumber", "Numer dokumentu dostawcy")}
              {field("documentLine", "Numer pozycji dokumentu", "number")}
              {field("receivedOn", "Data fizycznego odbioru", "date")}
              {field(
                "quantityReceived",
                "Otrzymano fizycznie (szt.)",
                "number",
              )}
              {field("quantityAccepted", "Przyjęto zgodne (szt.)", "number")}
              {Number(values.quantityReceived) >
                Number(values.quantityAccepted) &&
                field(
                  "rejectionReason",
                  "Przyczyna odrzucenia pozostałych sztuk",
                )}
              {field(
                "deliveryNote",
                "Poświadczenie odbioru i sprawdzenia dostawy",
              )}
              {view.totals.unverifiedLegacyQuantity > 0 && (
                <>
                  <Notice>
                    {view.totals.unverifiedLegacyQuantity} szt. zapisano dawniej
                    bez identyfikatora dokumentu. Potwierdź je dokumentem bez
                    ponownego naliczenia.
                  </Notice>
                  {field(
                    "replacesLegacyQuantity",
                    "W tym uzupełnienie historycznego wpisu (szt.)",
                    "number",
                  )}
                </>
              )}
            </>
          ) : action === "returnRejectedDelivery" ? (
            <>
              <p>
                Potwierdzasz rzeczywisty zwrot wszystkich odrzuconych sztuk z
                pozycji „{receipt?.title}”. Pozostałe braki zamówienia nadal
                wymagają dostawy.
              </p>
              {field("returnedOn", "Data fizycznego zwrotu", "date")}
              {field("returnReference", "Numer dokumentu zwrotu")}
              {field("evidenceNote", "Dowód i sposób potwierdzenia zwrotu")}
            </>
          ) : (
            <>
              <p>
                Wpisz numery seryjne przyjętych urządzeń. Każdy wiersz utworzy
                jedno dostępne urządzenie z pochodzeniem w tej dostawie.
              </p>
              <label className="field">
                <span>Numery seryjne — jeden w wierszu</span>
                <textarea
                  required
                  rows={5}
                  value={values.serials}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, serials: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>Typ wyposażenia</span>
                <select
                  disabled={Boolean(view.order.data.assetType)}
                  value={values.assetType}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, assetType: e.target.value }))
                  }
                >
                  {Object.entries({
                    laptop: "Laptop",
                    desktop: "Komputer stacjonarny",
                    phone: "Telefon",
                    monitor: "Monitor",
                    accessory: "Akcesorium",
                    other: "Inne",
                  }).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {field("location", "Lokalizacja przyjętego sprzętu")}
              {field("manufacturer", "Producent", "text", false)}
              {field("model", "Model", "text", false)}
              {field(
                "evidenceNote",
                "Potwierdzenie numerów i stanu wyposażenia",
              )}
            </>
          )}
          <label className="check-field">
            <input
              type="checkbox"
              checked={confirmed}
              required
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              Potwierdzam, że podane dane opisują sprawdzone zdarzenie i
              konkretne sztuki.
            </span>
          </label>
          <p className="small muted">
            Zapis otrzyma osobną zgodę. Przyjęcie do magazynu i wydanie osobie
            są odrębnymi zdarzeniami.
          </p>
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Anuluj
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={busy || !confirmed}
          >
            Przygotuj operację
          </button>
        </div>
      </form>
    </Sheet>
  );
}
export function DeliverySummary({ view }: { view: DeliveryView }) {
  return (
    <>
      <dl className="data-grid">
        <div>
          <dt>Zamówiono</dt>
          <dd>{String(view.order.data.quantity)} szt.</dd>
        </div>
        <div>
          <dt>Otrzymano fizycznie</dt>
          <dd>{view.totals.physicalQuantity} szt.</dd>
        </div>
        <div>
          <dt>Przyjęto zgodne</dt>
          <dd>{view.totals.acceptedQuantity} szt.</dd>
        </div>
        <div>
          <dt>Pozostaje do przyjęcia</dt>
          <dd>{view.totals.outstandingQuantity} szt.</dd>
        </div>
        <div>
          <dt>Odrzucono</dt>
          <dd>{view.totals.rejectedQuantity} szt.</dd>
        </div>
        <div>
          <dt>Odrzucone oczekujące zwrotu</dt>
          <dd>{view.totals.unresolvedQuantity} szt.</dd>
        </div>
      </dl>
      {view.totals.unverifiedLegacyQuantity > 0 && (
        <Notice>
          {view.totals.unverifiedLegacyQuantity} szt. z wcześniejszej historii
          wymaga dokumentu i poświadczenia. Nie stanowi dowodu kompletnego
          przyjęcia.
        </Notice>
      )}
    </>
  );
}
export function PurchaseDeliveries({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const orderId =
    item.data.kind === "order"
      ? item.id
      : item.data.kind === "receipt"
        ? String(item.data.orderId)
        : null;
  const resource = useResource<{ deliveries: DeliveryView }>(
    orderId ? `/api/purchases/${orderId}/deliveries` : null,
    revision + item.version,
  );
  const [form, setForm] = useState<{ action: Action; receipt?: Entity } | null>(
    null,
  );
  if (!orderId) return null;
  if (resource.loading) return <Loading />;
  if (resource.error) return <Notice tone="error">{resource.error}</Notice>;
  const view = resource.data?.deliveries;
  if (!view) return null;
  const may = (action: Action) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((t) => t.id === `ops.purchases.${action}`) &&
    (action !== "registerDeliveredAssets" ||
      context.principal.scopes?.some((s) => s === "*" || s === "assets"));
  return (
    <section className="card" aria-label="Dostawy i przyjęte wyposażenie">
      {form && (
        <DeliveryForm
          action={form.action}
          receipt={form.receipt}
          view={view}
          onClose={() => setForm(null)}
        />
      )}
      <span className="eyebrow">ODBIÓR DOSTAWY → EWIDENCJA → WYDANIE</span>
      <h2>Dostawy i przyjęte wyposażenie</h2>
      {item.data.kind === "receipt" && (
        <button
          className="text-button"
          onClick={() => navigate(`module/purchases/${orderId}`)}
        >
          Otwórz zamówienie
        </button>
      )}
      <DeliverySummary view={view} />
      {may("recordDelivery") &&
        [
          "acknowledged",
          "part_received",
          "needs_resolution",
          "received",
        ].includes(view.order.status) && (
          <button
            className="button primary"
            onClick={() => setForm({ action: "recordDelivery" })}
          >
            Potwierdź przyjęcie dostawy
          </button>
        )}
      {view.order.status === "ordered" && (
        <Notice>
          Najpierw poświadcz potwierdzenie zamówienia przez dostawcę.
        </Notice>
      )}
      {!view.receipts.length && (
        <p className="muted">Brak poświadczonych pozycji dostawy.</p>
      )}
      {view.receipts.map((receipt) => {
        const a = rec(receipt.data.attestation),
          r = rec(receipt.data.resolution),
          ids = receipt.data.assetIds as string[];
        return (
          <article className="delivery-receipt" key={receipt.id}>
            <h3>{receipt.title}</h3>
            <Badge status={receipt.status} />
            <p>
              {dateLabel(String(a.receivedOn))} · otrzymano{" "}
              {String(a.quantityReceived)}, przyjęto{" "}
              {String(a.quantityAccepted)} szt. · poświadczył{" "}
              {String(a.requestedBy)}, zatwierdził {String(a.approvedBy)}.
            </p>
            <p>{String(a.deliveryNote)}</p>
            {Boolean(a.rejectionReason) && (
              <p>Odrzucone: {String(a.rejectionReason)}</p>
            )}
            {Boolean(r.kind) && (
              <p>
                Zwrot: {dateLabel(String(r.returnedOn))},{" "}
                {String(r.returnReference)}. {String(r.evidenceNote)} ·
                poświadczył {String(r.requestedBy)}, zatwierdził{" "}
                {String(r.approvedBy)}.
              </p>
            )}
            <div className="purchase-actions">
              {receipt.status === "needs_resolution" &&
                may("returnRejectedDelivery") && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setForm({ action: "returnRejectedDelivery", receipt })
                    }
                  >
                    Potwierdź zwrot odrzuconych sztuk
                  </button>
                )}
              {ids.length < Number(a.quantityAccepted) &&
                may("registerDeliveredAssets") && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setForm({ action: "registerDeliveredAssets", receipt })
                    }
                  >
                    Zarejestruj przyjęte wyposażenie
                  </button>
                )}
            </div>
            <p>
              Zarejestrowane urządzenia: {ids.length} z{" "}
              {String(a.quantityAccepted)} przyjętych sztuk.
            </p>
            {context.principal.scopes?.some(
              (s) => s === "*" || s === "assets",
            ) &&
              ids.map((id, index) => (
                <button
                  key={id}
                  className="text-button"
                  onClick={() => navigate(`module/assets/${id}`)}
                >
                  Otwórz urządzenie {index + 1}
                </button>
              ))}
          </article>
        );
      })}
    </section>
  );
}
