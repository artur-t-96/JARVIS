import { useEffect, useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Entity, type Run } from "./types";
import { Icon, Loading, Notice, Sheet } from "./ui";
import type {
  OperationalReportSnapshot,
  ReportDefinition,
} from "../../src/operational-reports";

type Catalog = {
  kinds: {
    id: ReportDefinition["kind"];
    title: string;
    period: string | null;
  }[];
  maxRows: number;
};
const names = {
  equipment: "Wyposażenie i rozbieżności",
  starts: "Gotowość rozpoczęcia współpracy",
  deliveries: "Dostawy i rozbieżności",
  commitments: "Zobowiązania zakupowe i licencyjne",
};
const money = (v: OperationalReportSnapshot["summary"]["money"][number]) =>
  `${(v.minor / 100).toLocaleString("pl-PL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${v.currency} ${v.basis === "net" ? "netto" : "brutto"}`;
const value = (v: string | number | boolean | null) =>
  v === null
    ? "Brak potwierdzonych danych"
    : typeof v === "boolean"
      ? v
        ? "Tak"
        : "Nie"
      : String(v);
export function ReportSnapshot({
  snapshot,
}: {
  snapshot: OperationalReportSnapshot;
}) {
  const [page, setPage] = useState(0),
    size = 5,
    pages = Math.max(1, Math.ceil(snapshot.rows.length / size)),
    current = Math.min(page, pages - 1);
  return (
    <div className="operational-report">
      <h3>{names[snapshot.definition.kind]}</h3>
      <p>
        {snapshot.companyName} · {dateLabel(snapshot.capturedAt, true)} ·{" "}
        {snapshot.timezone}
      </p>
      <p>
        {"from" in snapshot.definition
          ? `Okres: ${dateLabel(snapshot.definition.from)} – ${dateLabel(snapshot.definition.to)}`
          : `Lokalizacja: ${snapshot.definition.location ?? "wszystkie"}`}
      </p>
      <div className="report-summary">
        <strong>{snapshot.summary.rows} pozycji</strong>
        <span>{snapshot.summary.withWarnings} z brakami lub uwagami</span>
      </div>
      {snapshot.summary.money.length > 0 && (
        <ul>
          {snapshot.summary.money.map((m) => (
            <li key={`${m.category}:${m.currency}:${m.basis}`}>
              {m.category === "purchase_order"
                ? "Pełna kwota zamówień"
                : "Pełna kwota poświadczonych umów licencji"}
              : <strong>{money(m)}</strong>
            </li>
          ))}
        </ul>
      )}
      {snapshot.definition.kind === "commitments" && (
        <p className="small muted">
          Pełne kwoty aktualnych zamówień i poświadczonych umów pasujących do
          zakresu. Bez proporcjonalnego naliczania okresu; waluty i netto/brutto
          są rozdzielone. Zapis nie potwierdza płatności.
        </p>
      )}
      {!snapshot.rows.length && (
        <Notice>Brak lokalnych rekordów w wybranym zakresie.</Notice>
      )}
      {snapshot.rows
        .slice(current * size, (current + 1) * size)
        .map((row, i) => (
          <details className="report-row" key={row.key} open={i === 0}>
            <summary>
              {current * size + i + 1}. {row.title}
              {row.warnings.length > 0 && (
                <span className="badge warning">Wymaga uwagi</span>
              )}
            </summary>
            <dl className="data-grid">
              {row.fields.map((f) => (
                <div key={f.label}>
                  <dt>{f.label}</dt>
                  <dd>{value(f.value)}</dd>
                </div>
              ))}
            </dl>
            {row.warnings.length > 0 && (
              <ul className="report-warnings">
                {row.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <details className="technical-details">
              <summary>Źródła i wersje ({row.references.length})</summary>
              <ul>
                {row.references.map((ref) => (
                  <li key={`${ref.module}:${ref.id}`}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => navigate(`module/${ref.module}/${ref.id}`)}
                    >
                      Otwórz źródło · wersja {ref.version}
                    </button>
                    <small>{dateLabel(ref.updatedAt, true)}</small>
                    <code>{ref.hash}</code>
                  </li>
                ))}
              </ul>
            </details>
          </details>
        ))}
      {pages > 1 && (
        <div className="report-pagination" aria-label="Strony raportu">
          <button
            type="button"
            className="button secondary"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            Poprzednie pozycje
          </button>
          <span>
            Strona {current + 1} z {pages}
          </span>
          <button
            type="button"
            className="button secondary"
            disabled={current === pages - 1}
            onClick={() => setPage(current + 1)}
          >
            Następne pozycje
          </button>
        </div>
      )}
      <p className="small muted">
        Raport obejmuje lokalną ewidencję JARVIS. Pozycje bez wymaganych danych
        pozostają oznaczone.
      </p>
    </div>
  );
}
export function ReportComposer({
  item,
  onClose,
}: {
  item?: Entity;
  onClose: () => void;
}) {
  const catalog = useResource<Catalog>("/api/operational-reports"),
    previous = item?.data.operationalReport as
      OperationalReportSnapshot | undefined;
  const [kind, setKind] = useState<ReportDefinition["kind"]>(
    previous?.definition.kind ?? "equipment",
  );
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(
      previous && "from" in previous.definition
        ? previous.definition.from
        : today.slice(0, 7) + "-01",
    ),
    [to, setTo] = useState(
      previous && "to" in previous.definition ? previous.definition.to : today,
    );
  const [location, setLocation] = useState(
      previous?.definition.kind === "equipment"
        ? (previous.definition.location ?? "")
        : "",
    ),
    [status, setStatus] = useState(
      previous?.definition.kind === "equipment"
        ? (previous.definition.status ?? "")
        : "",
    );
  const [title, setTitle] = useState(item?.title ?? "Raport wyposażenia"),
    [changeNote, setChangeNote] = useState("");
  const [preview, setPreview] = useState<OperationalReportSnapshot | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(requestKey);
  const invalidate = () => {
    setPreview(null);
    setError("");
    setKey(requestKey());
  };
  useEffect(() => {
    if (
      catalog.data &&
      !catalog.data.kinds.some((k) => k.id === kind) &&
      catalog.data.kinds[0]
    ) {
      setKind(catalog.data.kinds[0].id);
      setTitle(catalog.data.kinds[0].title);
      setPreview(null);
    }
  }, [catalog.data, kind]);
  const definition = (): ReportDefinition =>
    kind === "equipment"
      ? {
          kind,
          ...(location.trim() ? { location: location.trim() } : {}),
          ...(status
            ? {
                status: status as
                  | "available"
                  | "reserved"
                  | "issued"
                  | "maintenance"
                  | "retired",
              }
            : {}),
        }
      : { kind, from, to };
  async function inspect(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await post<{ preview: OperationalReportSnapshot }>(
        "/api/operational-reports/preview",
        definition(),
      );
      setPreview(result.preview);
      setKey(requestKey());
    } catch (e) {
      setPreview(null);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ run: Run }>(
        "/api/operational-reports/prepare",
        {
          title,
          definition: preview.definition,
          previewHash: preview.previewHash,
          profileVersion: preview.profileVersion,
          idempotencyKey: key,
          ...(item
            ? { id: item.id, expectedVersion: item.version, changeNote }
            : {}),
        },
      );
      onClose();
      navigate(`runs/${result.run.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={item ? "Odśwież raport" : "Przygotuj raport operacyjny"}
      subtitle={
        item
          ? `Nowa rewizja dokumentu: ${item.title}`
          : "Zakres → podgląd → zgoda → osobny odbiór"
      }
      onClose={onClose}
    >
      <form className="command-form" onSubmit={(event) => void inspect(event)}>
        <div className="sheet-body">
          {(error || catalog.error) && (
            <Notice tone="error">{error || catalog.error}</Notice>
          )}
          <label className="field">
            <span>Tytuł raportu</span>
            <input
              required
              maxLength={160}
              value={title}
              disabled={busy}
              onChange={(e) => {
                setTitle(e.target.value);
                setKey(requestKey());
              }}
            />
          </label>
          <label className="field">
            <span>Rodzaj raportu</span>
            <select
              value={kind}
              disabled={busy || catalog.loading}
              onChange={(e) => {
                setKind(e.target.value as typeof kind);
                setTitle(names[e.target.value as typeof kind]);
                invalidate();
              }}
            >
              {catalog.data?.kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.title}
                </option>
              ))}
            </select>
          </label>
          {kind === "equipment" ? (
            <>
              <label className="field">
                <span>Lokalizacja (opcjonalnie, dokładna nazwa)</span>
                <input
                  maxLength={200}
                  disabled={busy}
                  value={location}
                  onChange={(e) => {
                    setLocation(e.target.value);
                    invalidate();
                  }}
                />
              </label>
              <label className="field">
                <span>Stan wyposażenia</span>
                <select
                  disabled={busy}
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value as typeof status);
                    invalidate();
                  }}
                >
                  <option value="">Wszystkie stany</option>
                  {Object.entries({
                    available: "Dostępny",
                    reserved: "Zarezerwowany",
                    issued: "Wydany",
                    maintenance: "W serwisie",
                    retired: "Wycofany",
                  }).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <p className="muted">
                {catalog.data?.kinds.find((k) => k.id === kind)?.period}. Brak
                daty pozostanie jawnym brakiem w raporcie.
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>Okres od</span>
                  <input
                    type="date"
                    required
                    disabled={busy}
                    value={from}
                    onChange={(e) => {
                      setFrom(e.target.value);
                      invalidate();
                    }}
                  />
                </label>
                <label className="field">
                  <span>Okres do</span>
                  <input
                    type="date"
                    required
                    disabled={busy}
                    value={to}
                    min={from}
                    onChange={(e) => {
                      setTo(e.target.value);
                      invalidate();
                    }}
                  />
                </label>
              </div>
            </>
          )}
          {item && (
            <label className="field">
              <span>Powód odświeżenia</span>
              <textarea
                required
                maxLength={2000}
                disabled={busy}
                value={changeNote}
                onChange={(e) => {
                  setChangeNote(e.target.value);
                  setKey(requestKey());
                }}
              />
            </label>
          )}
          <p className="small muted">
            Maksymalnie {catalog.data?.maxRows ?? 200} pozycji. Większy zakres
            wymaga zawężenia; raport nie pomija nadmiarowych rekordów.
          </p>
          <button
            className="button secondary"
            disabled={busy || !catalog.data?.kinds.some((k) => k.id === kind)}
          >
            {busy ? "Przygotowywanie…" : "Pokaż aktualny podgląd"}
          </button>
          {preview && (
            <ReportSnapshot key={preview.previewHash} snapshot={preview} />
          )}
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
            type="button"
            className="button primary"
            disabled={
              busy ||
              !preview ||
              !title.trim() ||
              (!!item && !changeNote.trim())
            }
            onClick={() => void prepare()}
          >
            Przygotuj zgodę na zapis
          </button>
        </div>
      </form>
    </Sheet>
  );
}
export function ReportToolbar({ canWrite }: { canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canWrite) return null;
  return (
    <>
      <section className="card document-template-callout">
        <div>
          <h2>Raporty operacyjne</h2>
          <p className="muted">
            Wyposażenie, gotowość startów, dostawy i zobowiązania. Aktualny
            zakres, widoczne braki i odbiór konkretnej rewizji.
          </p>
        </div>
        <button className="button secondary" onClick={() => setOpen(true)}>
          <Icon name="documents" size={17} />
          Przygotuj raport
        </button>
      </section>
      {open && <ReportComposer onClose={() => setOpen(false)} />}
    </>
  );
}
export function GeneratedReport({
  item,
  canRefresh,
}: {
  item: Entity;
  canRefresh: boolean;
}) {
  const [open, setOpen] = useState(false),
    snapshot = item.data.operationalReport as
      OperationalReportSnapshot | undefined;
  if (!snapshot) return null;
  return (
    <>
      <section className="card">
        <div className="card-heading">
          <h2>Raport · rewizja {String(item.data.revision)}</h2>
          {canRefresh && item.status !== "archived" && (
            <button className="button secondary" onClick={() => setOpen(true)}>
              Odśwież raport
            </button>
          )}
        </div>
        <ReportSnapshot key={snapshot.previewHash} snapshot={snapshot} />
      </section>
      {open && <ReportComposer item={item} onClose={() => setOpen(false)} />}
    </>
  );
}
export function ReportOperation({
  runId,
  step,
}: {
  runId: string;
  step: Run["steps"][number];
}) {
  const state = useResource<{
      proposal: {
        snapshot: OperationalReportSnapshot;
        current: boolean;
        expiresAt: string;
        documentId: string | null;
      };
    }>(
      `/api/runs/${runId}/operational-report/${step.id}`,
      0,
      step.status === "succeeded" ? 0 : 5000,
    ),
    p = state.error ? null : state.data?.proposal;
  return (
    <>
      {state.loading && <Loading />}
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {p && (
        <>
          <Notice
            tone={p.documentId ? "success" : p.current ? undefined : "error"}
          >
            {p.documentId
              ? "Ten podgląd ma zapisane potwierdzenie utworzenia dokumentu."
              : p.current
                ? "Podgląd odpowiada aktualnym danym. Zgoda zapisze szkic do osobnego odbioru."
                : "Dane zmieniły się albo podgląd wygasł. Zapis tego zakresu będzie zablokowany; przygotuj nowy podgląd i zlecenie."}
          </Notice>
          <ReportSnapshot snapshot={p.snapshot} />
          {p.documentId && (
            <button
              className="button secondary"
              onClick={() => navigate(`module/documents/${p.documentId}`)}
            >
              Otwórz zapisany raport
            </button>
          )}
        </>
      )}
    </>
  );
}
