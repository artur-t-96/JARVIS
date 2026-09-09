import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Badge, Empty, Loading, Notice, Sheet } from "./ui";

interface Asset {
  id: string;
  version: number;
  title: string;
  serial: string;
  location: string;
  condition: string;
  status: string;
}
interface Observation {
  id: string;
  hash: string;
  present: boolean;
  location: string | null;
  condition: string | null;
  observedOn: string;
  note: string;
  actorId: string;
  approvedBy: string;
  runId: string;
}
interface Line {
  baseline: Asset;
  current: Asset;
  observation: Observation | null;
  discrepancy: { id: string; reasons: string[] } | null;
  resolution: { reason: string; actorId: string; at: string } | null;
  stale: boolean;
  ready: boolean;
}
interface Report {
  record: Entity;
  lines: Line[];
  hash: string;
  ready: boolean;
  overdue: boolean;
  observed: number;
  unresolved: number;
  ownerPrincipalId: string;
  dueDate: string;
}
interface Options {
  profileVersion: number;
  today: string;
  timezone: string;
  assets: Asset[];
  owners: { id: string; label: string }[];
  occupancy: { assetId: string; stocktakeId: string }[];
  total: number;
  offset: number;
  limit: number;
}
interface Summary {
  id: string;
  title: string;
  status: string;
  version: number;
  ownerPrincipalId: string;
  dueDate: string;
  assets: number;
  observed: number;
  unresolved: number;
}
const condition = (value: string | null) =>
  value === "good"
    ? "Sprawny"
    : value === "repair"
      ? "Wymaga naprawy"
      : "Nie ustalono";
const actionNames: Record<string, string> = {
  create: "Otwórz spis sprzętu",
  reviseStocktake: "Zmień zakres spisu",
  recordObservation: "Zapisz obserwację",
  resolveDiscrepancy: "Wyjaśnij rozbieżność",
  assignStocktakeOwner: "Przekaż odpowiedzialność",
  acceptStocktake: "Odbierz spis",
  cancelStocktake: "Anuluj spis",
};
function StocktakeForm({
  action,
  report,
  line,
  onClose,
}: {
  action: string;
  report?: Report;
  line?: Line;
  onClose(): void;
}) {
  const [key] = useState(requestKey);
  const [assetOffset, setAssetOffset] = useState(0),
    [search, setSearch] = useState("");
  const options = useResource<Options>(
    `/api/inventory/context?limit=50&offset=${assetOffset}&search=${encodeURIComponent(search)}`,
  );
  const [selected, setSelected] = useState<Record<string, Asset>>(() =>
    Object.fromEntries(
      (action === "reviseStocktake" ? (report?.lines ?? []) : []).map((l) => [
        l.current.id,
        l.current,
      ]),
    ),
  );
  const [values, setValues] = useState<Record<string, string>>({
    title: "",
    ownerPrincipalId: report?.ownerPrincipalId ?? "",
    dueDate: report?.dueDate ?? "",
    present: "true",
    location: line?.current.location ?? "",
    condition: line?.current.condition ?? "good",
    observedOn: "",
    note: "",
    reason: "",
  });
  const [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const choosing = action === "create" || action === "reviseStocktake";
  const input = (
    key: string,
    label: string,
    type: "text" | "date" | "textarea" = "text",
  ) => (
    <label className="field">
      <span>{label}</span>
      {type === "textarea" ? (
        <textarea
          required
          value={values[key] ?? ""}
          onChange={(e) => setValues({ ...values, [key]: e.target.value })}
        />
      ) : (
        <input
          required
          type={type}
          value={values[key] ?? ""}
          onChange={(e) => setValues({ ...values, [key]: e.target.value })}
        />
      )}
    </label>
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      let args: Record<string, unknown> = report
        ? { id: report.record.id, expectedVersion: report.record.version }
        : {};
      const pins = Object.values(selected).map((a) => ({
        id: a.id,
        expectedVersion: a.version,
      }));
      if (choosing && (!pins.length || pins.length > 200))
        throw new Error("Wybierz od 1 do 200 urządzeń w tej partii.");
      if (action === "create") {
        if (!options.data) throw new Error("Brak aktualnej konfiguracji.");
        args = {
          title: values.title,
          data: {
            ownerPrincipalId: values.ownerPrincipalId,
            dueDate: values.dueDate,
            note: values.note,
            profileVersion: options.data.profileVersion,
            assetPins: pins,
          },
        };
      } else if (action === "reviseStocktake")
        args = { ...args, assetPins: pins, reason: values.reason };
      else if (action === "recordObservation" && line)
        args = {
          ...args,
          assetId: line.current.id,
          expectedAssetVersion: line.current.version,
          present: values.present === "true",
          ...(values.present === "true"
            ? { location: values.location, condition: values.condition }
            : {}),
          observedOn: values.observedOn,
          note: values.note,
          humanConfirmed: confirmed,
        };
      else if (action === "resolveDiscrepancy" && line?.observation)
        args = {
          ...args,
          assetId: line.current.id,
          expectedAssetVersion: line.current.version,
          observationId: line.observation.id,
          observationHash: line.observation.hash,
          reason: values.reason,
          humanDecision: confirmed,
        };
      else if (action === "assignStocktakeOwner")
        args = {
          ...args,
          ownerPrincipalId: values.ownerPrincipalId,
          dueDate: values.dueDate,
          reason: values.reason,
        };
      else if (action === "acceptStocktake")
        args = {
          ...args,
          reportHash: report?.hash,
          note: values.note,
          humanDecision: confirmed,
        };
      else if (action === "cancelStocktake")
        args = { ...args, reason: values.reason };
      const result = await post<{ run: Run }>("/api/commands", {
        toolId: `ops.inventory.${action}`,
        input: args,
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${result.run.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={actionNames[action]!} onClose={onClose}>
      <form className="command-form stocktake-form" onSubmit={submit}>
        <div className="sheet-body">
          {line && (
            <p>
              <strong>{line.current.title}</strong> · {line.current.serial} ·
              ewidencja v{line.current.version}
            </p>
          )}
          {action === "create" && input("title", "Nazwa spisu")}
          {["create", "assignStocktakeOwner"].includes(action) && (
            <>
              <label className="field">
                <span>Właściciel spisu</span>
                <select
                  required
                  value={values.ownerPrincipalId}
                  onChange={(e) =>
                    setValues({ ...values, ownerPrincipalId: e.target.value })
                  }
                >
                  <option value="">Wybierz</option>
                  {options.data?.owners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {input("dueDate", "Termin zakończenia", "date")}
            </>
          )}
          {choosing && (
            <>
              <p>
                Wybierz konkretną partię do 200 urządzeń. Zakres zachowa
                wskazane wersje ewidencji.
              </p>
              <label className="field">
                <span>Szukaj urządzenia lub numeru seryjnego</span>
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setAssetOffset(0);
                  }}
                />
              </label>
              {options.loading ? (
                <Loading />
              ) : (
                options.data?.assets.map((a) => {
                  const occupied = options.data?.occupancy.find(
                    (o) =>
                      o.assetId === a.id && o.stocktakeId !== report?.record.id,
                  );
                  return (
                    <label className="check-field" key={a.id}>
                      <input
                        type="checkbox"
                        checked={!!selected[a.id]}
                        disabled={
                          !!occupied ||
                          (!selected[a.id] &&
                            Object.keys(selected).length >= 200)
                        }
                        onChange={(e) =>
                          setSelected((old) => {
                            const next = { ...old };
                            if (e.target.checked) next[a.id] = a;
                            else delete next[a.id];
                            return next;
                          })
                        }
                      />
                      <span>
                        <strong>{a.title}</strong> · {a.serial}
                        <br />
                        {a.location} · {condition(a.condition)} · v{a.version}
                        {occupied ? " · inny otwarty spis lub rozbieżność" : ""}
                      </span>
                    </label>
                  );
                })
              )}
              <p>
                Wybrano {Object.keys(selected).length} urządzeń. Wyniki:{" "}
                {options.data?.total ?? "—"}.
              </p>
              <div className="button-group">
                <button
                  className="button secondary"
                  type="button"
                  disabled={!assetOffset}
                  onClick={() => setAssetOffset(Math.max(0, assetOffset - 50))}
                >
                  Poprzednia strona sprzętu
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={
                    !options.data || assetOffset + 50 >= options.data.total
                  }
                  onClick={() => setAssetOffset(assetOffset + 50)}
                >
                  Następna strona sprzętu
                </button>
              </div>
            </>
          )}
          {action === "recordObservation" && (
            <>
              <label className="field">
                <span>Wynik obserwacji</span>
                <select
                  value={values.present}
                  onChange={(e) =>
                    setValues({ ...values, present: e.target.value })
                  }
                >
                  <option value="true">Odnaleziono urządzenie</option>
                  <option value="false">Nie odnaleziono urządzenia</option>
                </select>
              </label>
              {values.present === "true" && (
                <>
                  {input("location", "Zaobserwowana lokalizacja")}
                  <label className="field">
                    <span>Zaobserwowany stan</span>
                    <select
                      value={values.condition}
                      onChange={(e) =>
                        setValues({ ...values, condition: e.target.value })
                      }
                    >
                      <option value="good">Sprawny</option>
                      <option value="repair">Wymaga naprawy</option>
                    </select>
                  </label>
                </>
              )}
              {input("observedOn", "Data obserwacji", "date")}
              <Notice>
                Poświadczenie zapisze ustalenie. Przeniesienie, serwis i zwrot
                sprzętu mają osobne operacje.
              </Notice>
            </>
          )}
          {action === "resolveDiscrepancy" && (
            <Notice>
              Potwierdzasz, że ostatnia obserwacja jest zgodna z pokazaną wersją
              ewidencji. Historia wcześniejszego ustalenia zostanie zachowana.
            </Notice>
          )}
          {action === "cancelStocktake" && (
            <Notice>
              Anulowanie zachowa niewyjaśnione rozbieżności i blokady sprzętu.
            </Notice>
          )}
          {["create", "recordObservation", "acceptStocktake"].includes(action)
            ? input(
                "note",
                action === "create" ? "Cel i podstawa spisu" : "Co sprawdzono",
                "textarea",
              )
            : input("reason", "Uzasadnienie", "textarea")}
          {[
            "recordObservation",
            "resolveDiscrepancy",
            "acceptStocktake",
          ].includes(action) && (
            <label className="check-field">
              <input
                required
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                {action === "recordObservation"
                  ? "Osobiście potwierdzam zapisaną obserwację."
                  : "Podejmuję decyzję jako właściciel spisu."}
              </span>
            </label>
          )}
          {(error || options.error) && (
            <Notice tone="error">{error || options.error}</Notice>
          )}
        </div>
        <div className="sheet-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Anuluj
          </button>
          <button
            className="button primary"
            disabled={busy || options.loading || !!options.error}
          >
            Przygotuj plan do zgody
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function StocktakeLines({
  report,
  onAction,
  isOwner,
  allowed,
}: {
  report: Report;
  onAction(action: string, line?: Line): void;
  isOwner: boolean;
  allowed: boolean;
}) {
  return (
    <div className="stocktake-lines">
      {report.lines.map((line) => (
        <article className="card" key={line.baseline.id}>
          <div className="card-heading">
            <div>
              <h3>{line.baseline.title}</h3>
              <p>{line.baseline.serial}</p>
            </div>
            <button
              className="text-button"
              onClick={() => navigate(`module/assets/${line.baseline.id}`)}
            >
              Otwórz ewidencję
            </button>
          </div>
          <div className="stocktake-comparison">
            <div>
              <strong>Przy otwarciu · v{line.baseline.version}</strong>
              <p>
                {line.baseline.location} · {condition(line.baseline.condition)}
              </p>
            </div>
            <div>
              <strong>Bieżąca ewidencja · v{line.current.version}</strong>
              <p>
                {line.current.location} · {condition(line.current.condition)}
              </p>
            </div>
            <div>
              <strong>Obserwacja człowieka</strong>
              {line.observation ? (
                <>
                  <p>
                    {line.observation.present
                      ? `${line.observation.location} · ${condition(line.observation.condition)}`
                      : "Nie odnaleziono urządzenia"}
                  </p>
                  <p>
                    {dateLabel(line.observation.observedOn)} ·{" "}
                    {line.observation.actorId}
                  </p>
                  <p>{line.observation.note}</p>
                  <button
                    className="text-button"
                    onClick={() => navigate(`runs/${line.observation!.runId}`)}
                  >
                    Wykonanie obserwacji
                  </button>
                </>
              ) : (
                <p>Nie sprawdzono</p>
              )}
            </div>
          </div>
          {line.discrepancy && (
            <Notice tone="error">
              <strong>Niewyjaśniona rozbieżność</strong>
              <ul>
                {line.discrepancy.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p>
                Właściciel: {report.ownerPrincipalId} · termin{" "}
                {dateLabel(report.dueDate)}. Sprawdź sprzęt; w razie potrzeby
                wykonaj osobną korektę ewidencji i potwierdź zgodną obserwację.
              </p>
            </Notice>
          )}
          {line.stale && (
            <Notice>
              Ewidencja zmieniła się po ostatnim poświadczeniu. Odbiór wymaga
              aktualnego ustalenia.
            </Notice>
          )}
          {line.resolution && (
            <p>
              Wyjaśniono: {line.resolution.reason} · {line.resolution.actorId} ·{" "}
              {dateLabel(line.resolution.at, true)}
            </p>
          )}
          {line.ready && (
            <p className="muted">Obserwacja zgodna z bieżącą ewidencją.</p>
          )}
          {allowed &&
            report.record.status !== "accepted" &&
            (report.record.status === "open" || line.discrepancy) && (
              <div className="button-group">
                <button
                  className="button secondary"
                  onClick={() => onAction("recordObservation", line)}
                >
                  Zapisz obserwację
                </button>
                {line.discrepancy && isOwner && (
                  <button
                    className="button secondary"
                    disabled={
                      !line.observation?.present ||
                      line.observation.location !== line.current.location ||
                      line.observation.condition !== line.current.condition
                    }
                    onClick={() => onAction("resolveDiscrepancy", line)}
                  >
                    Wyjaśnij rozbieżność
                  </button>
                )}
              </div>
            )}
        </article>
      ))}
    </div>
  );
}
function StocktakeHistory({ id, onClose }: { id: string; onClose(): void }) {
  const [offset, setOffset] = useState(0);
  const history = useResource<{
    history: {
      items: {
        record: Entity;
        actorId: string;
        runId: string;
        toolId: string;
      }[];
      total: number;
    };
  }>(`/api/inventory/${id}/history?limit=5&offset=${offset}`);
  return (
    <Sheet title="Historia spisu" onClose={onClose}>
      <div className="sheet-body">
        {history.loading ? (
          <Loading />
        ) : history.error ? (
          <Notice tone="error">{history.error}</Notice>
        ) : (
          history.data?.history.items.map((item) => (
            <article
              className="stocktake-history-entry"
              key={item.record.version}
            >
              <h3>
                Wersja {item.record.version} ·{" "}
                {actionNames[item.toolId.split(".").at(-1)!] ?? item.toolId}
              </h3>
              <p>
                {item.actorId} · {dateLabel(item.record.updatedAt, true)}
              </p>
              <p>
                Właściciel: {String(item.record.data.ownerPrincipalId)} · zakres{" "}
                {String(item.record.data.scopeRevision)}
              </p>
              {(item.record.data.lines as Line[])
                .filter((l) => l.observation)
                .map((l) => (
                  <p key={l.baseline.id}>
                    <strong>{l.baseline.title}</strong>:{" "}
                    {l.observation?.present
                      ? `${l.observation.location}, ${condition(l.observation.condition)}`
                      : "Nie odnaleziono"}{" "}
                    · {l.observation?.actorId} · {l.observation?.note}
                    {l.discrepancy
                      ? " · niewyjaśnione"
                      : l.resolution
                        ? ` · wyjaśniono: ${l.resolution.reason}`
                        : ""}
                  </p>
                ))}
              <button
                className="text-button"
                onClick={() => {
                  onClose();
                  navigate(`runs/${item.runId}`);
                }}
              >
                Otwórz wykonanie wersji
              </button>
            </article>
          ))
        )}
        <p>
          Wersje {offset + 1}–
          {Math.min(offset + 5, history.data?.history.total ?? 0)} z{" "}
          {history.data?.history.total ?? "—"}
        </p>
        <div className="button-group">
          <button
            className="button secondary"
            disabled={!offset}
            onClick={() => setOffset(offset - 5)}
          >
            Nowsze
          </button>
          <button
            className="button secondary"
            disabled={!history.data || offset + 5 >= history.data.history.total}
            onClick={() => setOffset(offset + 5)}
          >
            Starsze
          </button>
        </div>
      </div>
    </Sheet>
  );
}
export function StocktakePage({
  entityId,
  context,
  revision,
}: {
  entityId?: string;
  context: Context;
  revision: number;
}) {
  const [offset, setOffset] = useState(0),
    [status, setStatus] = useState("");
  const list = useResource<{ items: Summary[]; total: number }>(
    entityId
      ? null
      : `/api/inventory?limit=30&offset=${offset}${status ? `&status=${status}` : ""}`,
    revision,
  );
  const detail = useResource<{ report: Report }>(
    entityId ? `/api/inventory/${encodeURIComponent(entityId)}/report` : null,
    revision,
  );
  const [form, setForm] = useState<{ action: string; line?: Line } | null>(
      null,
    ),
    [history, setHistory] = useState(false);
  const report = detail.data?.report,
    allowed =
      context.principal.roles.includes("operator") &&
      context.tools.some((t) => t.id === "ops.inventory.create"),
    isOwner = report?.ownerPrincipalId === context.principal.id;
  const act = (action: string, line?: Line) => setForm({ action, line });
  return (
    <>
      {form && (
        <StocktakeForm
          action={form.action}
          line={form.line}
          report={report}
          onClose={() => setForm(null)}
        />
      )}
      {history && entityId && (
        <StocktakeHistory id={entityId} onClose={() => setHistory(false)} />
      )}
      {entityId && (
        <button
          className="text-button back-link"
          onClick={() => navigate("module/inventory")}
        >
          Spisy sprzętu
        </button>
      )}
      <div className="page-heading">
        <div>
          <span className="eyebrow">EWIDENCJA I USTALENIA</span>
          <h1>
            {entityId
              ? (report?.record.title ?? "Spis sprzętu")
              : "Spisy sprzętu"}
          </h1>
          <p>
            Każda partia ma konkretny zakres, datę, właściciela i potwierdzone
            obserwacje.
          </p>
        </div>
        {!entityId && allowed && (
          <button className="button primary" onClick={() => act("create")}>
            Otwórz spis
          </button>
        )}
      </div>
      {list.error || detail.error ? (
        <Notice tone="error">{list.error || detail.error}</Notice>
      ) : (entityId ? detail.loading : list.loading) ? (
        <Loading />
      ) : report ? (
        <>
          <section className="card">
            <div className="card-heading">
              <h2>Wynik i następne działanie</h2>
              <Badge status={report.record.status} />
            </div>
            <p>
              Właściciel: <strong>{report.ownerPrincipalId}</strong> · termin{" "}
              {dateLabel(report.dueDate)} · zakres{" "}
              {String(report.record.data.scopeRevision)}
            </p>
            <p>
              Sprawdzono {report.observed} z {report.lines.length} urządzeń ·
              otwarte rozbieżności: {report.unresolved}
            </p>
            <p>{String(report.record.data.note)}</p>
            {report.record.data.acceptance != null && (
              <p>
                Odbiór:{" "}
                {String(
                  (report.record.data.acceptance as Record<string, unknown>)
                    .actorId,
                )}{" "}
                ·{" "}
                {dateLabel(
                  String(
                    (report.record.data.acceptance as Record<string, unknown>)
                      .at,
                  ),
                  true,
                )}{" "}
                ·{" "}
                {String(
                  (report.record.data.acceptance as Record<string, unknown>)
                    .note,
                )}
              </p>
            )}
            {report.record.data.cancellation != null && (
              <p>
                Powód anulowania:{" "}
                {String(
                  (report.record.data.cancellation as Record<string, unknown>)
                    .reason,
                )}
              </p>
            )}
            {report.overdue && (
              <Notice tone="error">
                Spis jest po terminie. Właściciel powinien uzupełnić ustalenia
                lub jawnie przekazać odpowiedzialność i termin.
              </Notice>
            )}
            {report.record.status === "accepted" ? (
              <p>
                Odbiór zapisano. Raport dokumentuje stan w chwili poświadczenia.
              </p>
            ) : report.record.status === "cancelled" ? (
              <Notice>
                Spis anulowano. Wcześniejsze nierozstrzygnięte ustalenia nadal
                blokują sprzęt.
              </Notice>
            ) : (
              !report.ready && (
                <Notice>
                  Odbiór wymaga wszystkich obserwacji, zgodności z aktualną
                  ewidencją i wyjaśnienia rozbieżności.
                </Notice>
              )
            )}
            <div className="button-group">
              <button className="text-button" onClick={() => setHistory(true)}>
                Historia spisu
              </button>
              {allowed && report.record.status !== "accepted" && (
                <button
                  className="button secondary"
                  onClick={() => act("assignStocktakeOwner")}
                >
                  Przekaż odpowiedzialność
                </button>
              )}
              {allowed && isOwner && report.record.status === "open" && (
                <>
                  {report.observed === 0 && (
                    <button
                      className="button secondary"
                      onClick={() => act("reviseStocktake")}
                    >
                      Zmień zakres spisu
                    </button>
                  )}
                  <button
                    className="button primary"
                    disabled={!report.ready}
                    onClick={() => act("acceptStocktake")}
                  >
                    Odbierz spis
                  </button>
                  <button
                    className="button secondary"
                    onClick={() => act("cancelStocktake")}
                  >
                    Anuluj spis
                  </button>
                </>
              )}
            </div>
          </section>
          <StocktakeLines
            report={report}
            onAction={act}
            isOwner={!!isOwner}
            allowed={allowed}
          />
        </>
      ) : (
        !entityId && (
          <>
            <label className="field">
              <span>Status spisu</span>
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setOffset(0);
                }}
              >
                <option value="">Wszystkie</option>
                <option value="open">Otwarte</option>
                <option value="accepted">Odebrane</option>
                <option value="cancelled">Anulowane</option>
              </select>
            </label>
            {list.data?.items.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Spis</th>
                      <th>Właściciel i termin</th>
                      <th>Obserwacje</th>
                      <th>Rozbieżności</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <button
                            className="text-button"
                            onClick={() => navigate(`module/inventory/${e.id}`)}
                          >
                            {e.title}
                          </button>
                        </td>
                        <td>
                          {e.ownerPrincipalId}
                          <br />
                          {dateLabel(e.dueDate)}
                        </td>
                        <td>
                          {e.observed} / {e.assets}
                        </td>
                        <td>{e.unresolved}</td>
                        <td>
                          <Badge status={e.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty icon="inventory" title="Brak spisów">
                Otwórz pierwszą partię po wybraniu zakresu.
              </Empty>
            )}
            <p>{list.data?.total ?? "—"} spisów</p>
            <div className="button-group">
              <button
                className="button secondary"
                disabled={!offset}
                onClick={() => setOffset(offset - 30)}
              >
                Poprzednia strona
              </button>
              <button
                className="button secondary"
                disabled={!list.data || offset + 30 >= list.data.total}
                onClick={() => setOffset(offset + 30)}
              >
                Następna strona
              </button>
            </div>
          </>
        )
      )}
    </>
  );
}

export function AssetInventoryNotice({ id }: { id: string }) {
  const resource = useResource<{
    holds: {
      stocktakeId: string;
      ownerPrincipalId: string;
      dueDate: string;
      reasons: string[];
    }[];
  }>(`/api/assets/${id}/inventory`);
  if (resource.error)
    return (
      <Notice tone="error">
        Nie udało się sprawdzić rozbieżności spisu: {resource.error}
      </Notice>
    );
  return (
    <>
      {resource.data?.holds.map((hold) => (
        <Notice tone="error" key={hold.stocktakeId}>
          <strong>Otwarte ustalenie ze spisu blokuje nowe wydanie.</strong>
          <p>{hold.reasons.join(" ")}</p>
          <p>
            Właściciel: {hold.ownerPrincipalId} · termin{" "}
            {dateLabel(hold.dueDate)}
          </p>
        </Notice>
      ))}
    </>
  );
}
