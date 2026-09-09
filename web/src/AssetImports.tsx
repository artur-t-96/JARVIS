import { useState, type FormEvent } from "react";
import { download, post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Entity, type Run } from "./types";
import { Empty, Loading, Notice, Sheet } from "./ui";

const fields: Record<string, string> = {
  title: "Nazwa",
  assetType: "Rodzaj sprzętu",
  serial: "Numer seryjny",
  location: "Lokalizacja",
  condition: "Stan techniczny",
  manufacturer: "Producent",
  model: "Model",
};
interface Row {
  sourceRow: number;
  firstLine: number;
  lastLine: number;
  values: Record<string, string>;
  asset: Record<string, string> | null;
  errors: string[];
  eligible: boolean;
  existing: { id: string; title: string; version: number; serial: string }[];
}
interface Preview {
  previewHash: string;
  profileVersion: number;
  headers: string[];
  mapping: Record<string, string>;
  mappingErrors: string[];
  rows: Row[];
  counts: {
    total: number;
    eligible: number;
    existing: number;
    invalid: number;
  };
  source: {
    filename: string;
    sourceName: string;
    observedOn: string;
    sha256: string;
  };
}
interface Report {
  id: string;
  valid: boolean;
  actorId: string;
  approvedBy: string;
  importedAt: string;
  runId: string;
  hash: string;
  source: {
    note: string;
    source: {
      filename: string;
      sourceName: string;
      observedOn: string;
      sha256: string;
      bytes: number;
    };
  };
  created: {
    id: string;
    title: string;
    serial: string;
    sourceRow: number;
    firstLine: number;
    lastLine: number;
  }[];
  skippedRows: number[];
}
async function fileBase64(file: File) {
  if (!/\.csv$/i.test(file.name) || file.size < 1 || file.size > 512 * 1024)
    throw Error("Wybierz plik CSV do 512 KiB, zapisany jako UTF-8.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function ImportRows({
  rows,
  selected,
  onSelect,
  disabled = false,
}: {
  rows: Row[];
  selected: number[];
  onSelect: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="asset-import-table">
      <table>
        <thead>
          <tr>
            <th>Wybór</th>
            <th>Źródło</th>
            <th>Sprzęt i lokalizacja</th>
            <th>Wynik sprawdzenia</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sourceRow}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Importuj pozycję ${row.sourceRow}`}
                  checked={selected.includes(row.sourceRow)}
                  disabled={
                    disabled ||
                    !row.eligible ||
                    (!selected.includes(row.sourceRow) &&
                      selected.length >= 200)
                  }
                  onChange={() => onSelect(row.sourceRow)}
                />
              </td>
              <td>
                Pozycja {row.sourceRow}
                <br />
                <span className="small muted">
                  Wiersze {row.firstLine}–{row.lastLine}
                </span>
              </td>
              <td>
                <strong>{row.asset?.title ?? "Wymaga poprawy"}</strong>
                <br />
                {row.asset?.serial}
                <br />
                {row.asset?.location}
                {row.asset && (
                  <p className="small">
                    {row.asset.assetType} ·{" "}
                    {row.asset.condition === "good"
                      ? "Sprawny"
                      : "Wymaga naprawy"}
                  </p>
                )}
                <details>
                  <summary>Oryginalne pola</summary>
                  <dl>
                    {Object.entries(row.values).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{value || "Puste pole"}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              </td>
              <td>
                {row.eligible && <span>Nowy rekord — można wybrać</span>}
                {row.errors.map((e, i) => (
                  <p key={i} className="error-text">
                    {e}
                  </p>
                ))}
                {row.existing.map((e) => (
                  <p key={e.id}>
                    Już istnieje:{" "}
                    <a href={`#/module/assets/${e.id}`}>{e.title}</a> (wersja{" "}
                    {e.version}). Zostanie pominięty.
                  </p>
                ))}
                {!row.eligible &&
                  !row.errors.length &&
                  !row.existing.length && (
                    <p>Najpierw popraw mapowanie kolumn.</p>
                  )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function ImportForm({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null),
    [sourceName, setSourceName] = useState(""),
    [observedOn, setDate] = useState(""),
    [delimiter, setDelimiter] = useState(";");
  const [mapping, setMapping] = useState<Record<string, string> | undefined>(),
    [preview, setPreview] = useState<Preview | null>(null),
    [dirty, setDirty] = useState(true);
  const [selected, setSelected] = useState<number[]>([]),
    [offset, setOffset] = useState(0),
    [note, setNote] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key, setKey] = useState(requestKey);
  const changed = () => {
    setDirty(true);
    setKey(requestKey());
  };
  async function payload() {
    if (!file) throw Error("Wybierz plik źródłowy.");
    return {
      filename: file.name,
      sourceName,
      observedOn,
      delimiter,
      ...(mapping ? { mapping } : {}),
      contentBase64: await fileBase64(file),
    };
  }
  async function check(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await post<{ preview: Preview }>(
        "/api/asset-imports/preview",
        await payload(),
      );
      setPreview(response.preview);
      setMapping(response.preview.mapping);
      setDirty(false);
      setOffset(0);
      setKey(requestKey());
      setSelected(
        response.preview.rows
          .filter((r) => r.eligible)
          .slice(0, 200)
          .map((r) => r.sourceRow),
      );
    } catch (e) {
      setError(errorMessage(e));
      setDirty(true);
    } finally {
      setBusy(false);
    }
  }
  async function prepare() {
    if (!preview || dirty || !note.trim() || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      const { run } = await post<{ run: Run }>("/api/asset-imports/prepare", {
        ...(await payload()),
        uploadId: key,
        previewHash: preview.previewHash,
        profileVersion: preview.profileVersion,
        selectedRows: [...selected].sort((a, b) => a - b),
        note,
      });
      navigate(`runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Import sprzętu z CSV"
      subtitle="Podgląd → wybór pozycji → zgoda na zapis"
      onClose={onClose}
    >
      <form className="command-form" onSubmit={(e) => void check(e)}>
        <div className="sheet-body">
          <p>
            Plik UTF-8 do 512 KiB i 500 pozycji. Jedno zatwierdzenie obejmuje
            maksymalnie 200 nowych urządzeń. Numery seryjne zachowują zera na
            początku.
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <label className="field">
            <span>Plik CSV</span>
            <input
              type="file"
              accept=".csv,text/csv"
              required
              disabled={busy}
              onChange={(e) => {
                const next = e.target.files?.[0] ?? null;
                setFile(next);
                setMapping(undefined);
                setPreview(null);
                changed();
                if (next && !sourceName)
                  setSourceName(next.name.replace(/\.csv$/i, ""));
              }}
            />
          </label>
          <label className="field">
            <span>Nazwa źródła</span>
            <input
              value={sourceName}
              maxLength={200}
              required
              disabled={busy}
              onChange={(e) => {
                setSourceName(e.target.value);
                changed();
              }}
              placeholder="Np. ewidencja magazynu z września"
            />
          </label>
          <label className="field">
            <span>Stan danych na dzień</span>
            <input
              type="date"
              value={observedOn}
              required
              disabled={busy}
              onChange={(e) => {
                setDate(e.target.value);
                changed();
              }}
            />
          </label>
          <label className="field">
            <span>Separator kolumn</span>
            <select
              value={delimiter}
              disabled={busy}
              onChange={(e) => {
                setDelimiter(e.target.value);
                setMapping(undefined);
                setPreview(null);
                changed();
              }}
            >
              <option value=";">Średnik (;)</option>
              <option value=",">Przecinek (,)</option>
              <option value={"\t"}>Tabulator</option>
            </select>
          </label>
          <details>
            <summary>Format pliku i mapowanie kolumn</summary>
            <p>
              Wymagane kolumny: nazwa, typ, numer_seryjny, lokalizacja, stan.
              Opcjonalne: producent, model. Typy: laptop, komputer stacjonarny,
              telefon, monitor, akcesorium, inne. Stan: sprawny lub wymaga
              naprawy.
            </p>
            <pre className="small">
              {
                "nazwa;typ;numer_seryjny;lokalizacja;stan\nLaptop testowy;laptop;000123;Magazyn;sprawny"
              }
            </pre>
          </details>
          {preview && (
            <fieldset disabled={busy}>
              <legend>Przypisanie kolumn</legend>
              {preview.headers.map((header) => (
                <label className="field" key={header}>
                  <span>{header}</span>
                  <select
                    value={mapping?.[header] ?? ""}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value) next[header] = e.target.value;
                      else delete next[header];
                      setMapping(next);
                      changed();
                    }}
                  >
                    <option value="">Wybierz pole</option>
                    {Object.entries(fields).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
          <button className="button secondary" type="submit" disabled={busy}>
            {busy
              ? "Przetwarzanie…"
              : preview
                ? "Sprawdź ponownie"
                : "Sprawdź plik"}
          </button>
          {preview && (
            <>
              {dirty && (
                <Notice tone="info">
                  Parametry zmieniły się. Sprawdź ponownie przed zatwierdzeniem.
                </Notice>
              )}
              {preview.mappingErrors.map((text, i) => (
                <Notice key={i} tone="error">
                  {text}
                </Notice>
              ))}
              <h3>Wybór pozycji</h3>
              <p>
                {preview.counts.total} w źródle · {preview.counts.eligible}{" "}
                nowych · {preview.counts.existing} istniejących ·{" "}
                {preview.counts.invalid} z błędami
              </p>
              <Notice tone="info">
                Wybrano {selected.length}. Pominięte:{" "}
                {preview.counts.total - selected.length}. Istniejące rekordy
                zachowają obecne dane. Błędne pozycje można poprawić w pliku i
                sprawdzić ponownie.
              </Notice>
              <div className="actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || dirty}
                  onClick={() => {
                    setSelected(
                      preview.rows
                        .filter((r) => r.eligible)
                        .slice(0, 200)
                        .map((r) => r.sourceRow),
                    );
                    setKey(requestKey());
                  }}
                >
                  Wybierz pierwsze 200 poprawnych
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || dirty}
                  onClick={() => {
                    setSelected([]);
                    setKey(requestKey());
                  }}
                >
                  Wyczyść wybór
                </button>
              </div>
              <ImportRows
                rows={preview.rows.slice(offset, offset + 30)}
                selected={selected}
                disabled={busy || dirty}
                onSelect={(n) => {
                  setSelected((current) =>
                    current.includes(n)
                      ? current.filter((x) => x !== n)
                      : [...current, n],
                  );
                  setKey(requestKey());
                }}
              />
              <div className="pagination">
                <button
                  type="button"
                  className="button secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 30))}
                >
                  Poprzednie pozycje
                </button>
                <span>
                  {offset + 1}–{Math.min(offset + 30, preview.rows.length)} z{" "}
                  {preview.rows.length}
                </span>
                <button
                  type="button"
                  className="button secondary"
                  disabled={offset + 30 >= preview.rows.length}
                  onClick={() => setOffset(offset + 30)}
                >
                  Następne pozycje
                </button>
              </div>
              <label className="field">
                <span>Uzasadnienie importu i pominięć</span>
                <textarea
                  value={note}
                  maxLength={2000}
                  disabled={busy}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setKey(requestKey());
                  }}
                />
              </label>
              <p className="small muted">
                Import zapisze stan ewidencji z podanego źródła. Fizyczne
                wydanie, zwrot i przydzielenie do osoby wymagają oddzielnego
                potwierdzenia.
              </p>
              <details>
                <summary>Odcisk oryginalnego źródła</summary>
                <code>{preview.source.sha256}</code>
              </details>
            </>
          )}
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Zamknij
          </button>
          <button
            type="button"
            className="button primary"
            disabled={
              busy ||
              dirty ||
              !selected.length ||
              !note.trim() ||
              !!preview?.mappingErrors.length
            }
            onClick={() => void prepare()}
          >
            Przygotuj import ({selected.length})
          </button>
        </div>
      </form>
    </Sheet>
  );
}
export function ImportReport({ report }: { report: Report }) {
  const [error, setError] = useState("");
  return (
    <>
      <Notice tone={report.valid ? "success" : "error"}>
        {report.valid
          ? "Oryginalny plik i zapisane wersje urządzeń są zgodne."
          : "Nie udało się potwierdzić pliku lub historii importu. Wynik wymaga wyjaśnienia."}
      </Notice>
      <h3>{report.source.source.sourceName}</h3>
      <p>
        {report.source.source.filename} · stan na{" "}
        {dateLabel(report.source.source.observedOn)}
      </p>
      <p>
        Dodano: {report.created.length} · pominięto: {report.skippedRows.length}
        . Zapisano {dateLabel(report.importedAt, true)}.
      </p>
      <p>
        Autor: {report.actorId} · zgoda: {report.approvedBy}
      </p>
      <p>{report.source.note}</p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="actions">
        <button
          className="button secondary"
          disabled={!report.valid}
          onClick={() =>
            void download(
              `/api/asset-imports/${report.id}/source`,
              report.source.source.filename,
            ).catch((e) => setError(errorMessage(e)))
          }
        >
          Pobierz oryginalny CSV
        </button>
        <button
          className="button secondary"
          onClick={() => navigate(`runs/${report.runId}`)}
        >
          Pokaż wykonanie i zgodę
        </button>
      </div>
      <div className="asset-import-table">
        <table>
          <thead>
            <tr>
              <th>Pozycja źródła</th>
              <th>Utworzony sprzęt</th>
              <th>Numer seryjny</th>
            </tr>
          </thead>
          <tbody>
            {report.created.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.sourceRow} (wiersze {r.firstLine}–{r.lastLine})
                </td>
                <td>
                  <a href={`#/module/assets/${r.id}`}>{r.title}</a>
                </td>
                <td>{r.serial}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!report.skippedRows.length && (
        <details>
          <summary>Pominięte pozycje ({report.skippedRows.length})</summary>
          <p>{report.skippedRows.join(", ")}</p>
        </details>
      )}
      <p className="small muted">
        To potwierdzenie importu ewidencji. Nie zastępuje protokołu fizycznego
        wydania.
      </p>
      <details>
        <summary>Odcisk źródła</summary>
        <code>{report.source.source.sha256}</code>
      </details>
    </>
  );
}
function ImportDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useResource<{ report: Report }>(`/api/asset-imports/${id}`);
  return (
    <Sheet title="Historia importu sprzętu" onClose={onClose}>
      <div className="sheet-body">
        {state.loading ? (
          <Loading />
        ) : state.error ? (
          <Notice tone="error">{state.error}</Notice>
        ) : (
          state.data && <ImportReport report={state.data.report} />
        )}
      </div>
    </Sheet>
  );
}
function ImportHistory({ onClose }: { onClose: () => void }) {
  const [offset, setOffset] = useState(0),
    [id, setId] = useState<string | null>(null);
  const state = useResource<{
    items: {
      id: string;
      sourceName: string;
      filename: string;
      observedOn: string;
      importedAt: string;
      created: number;
      skipped: number;
    }[];
    total: number;
  }>(`/api/asset-imports?limit=20&offset=${offset}`);
  if (id) return <ImportDetail id={id} onClose={() => setId(null)} />;
  return (
    <Sheet title="Importy sprzętu" onClose={onClose}>
      <div className="sheet-body">
        {state.loading ? (
          <Loading />
        ) : state.error ? (
          <Notice tone="error">{state.error}</Notice>
        ) : (
          <>
            {state.data?.items.length === 0 && (
              <Empty title="Brak zapisanych importów">
                Import pojawi się tutaj po zatwierdzeniu i sprawdzeniu zapisu.
              </Empty>
            )}
            {state.data?.items.map((r) => (
              <article className="card" key={r.id}>
                <h3>{r.sourceName}</h3>
                <p>
                  {r.filename} · stan na {dateLabel(r.observedOn)}
                </p>
                <p>
                  Dodano: {r.created} · pominięto: {r.skipped} ·{" "}
                  {dateLabel(r.importedAt, true)}
                </p>
                <button
                  className="button secondary"
                  onClick={() => setId(r.id)}
                >
                  Otwórz import
                </button>
              </article>
            ))}
            <div className="pagination">
              <button
                className="button secondary"
                disabled={!offset}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Poprzednie importy
              </button>
              <span>Łącznie: {state.data?.total ?? 0}</span>
              <button
                className="button secondary"
                disabled={offset + 20 >= (state.data?.total ?? 0)}
                onClick={() => setOffset(offset + 20)}
              >
                Następne importy
              </button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
export function AssetImportToolbar({ canWrite }: { canWrite: boolean }) {
  const [mode, setMode] = useState<"import" | "history" | null>(null);
  return (
    <>
      <div className="actions">
        {canWrite && (
          <button
            className="button secondary"
            onClick={() => setMode("import")}
          >
            Import CSV
          </button>
        )}
        <button className="button secondary" onClick={() => setMode("history")}>
          Historia importów
        </button>
      </div>
      {mode === "import" && <ImportForm onClose={() => setMode(null)} />}{" "}
      {mode === "history" && <ImportHistory onClose={() => setMode(null)} />}
    </>
  );
}
export function AssetImportProvenance({ item }: { item: Entity }) {
  const source = item.data.importSource as
    | {
        importId: string;
        sourceName: string;
        observedOn: string;
        sourceRow: number;
      }
    | undefined;
  const [open, setOpen] = useState(false);
  if (!source) return null;
  return (
    <section className="card">
      <h2>Pochodzenie ewidencji</h2>
      <p>
        {source.sourceName} · stan na {dateLabel(source.observedOn)} · pozycja{" "}
        {source.sourceRow}
      </p>
      <button className="button secondary" onClick={() => setOpen(true)}>
        Otwórz źródło importu
      </button>
      {open && (
        <ImportDetail id={source.importId} onClose={() => setOpen(false)} />
      )}
    </section>
  );
}
export function AssetImportOperation({
  runId,
  step,
}: {
  runId: string;
  step: Run["steps"][number];
}) {
  const [offset, setOffset] = useState(0);
  const state = useResource<{
    proposal:
      | {
          status: "pending";
          preview: Preview;
          selectedRows: number[];
          note: string;
          expiresAt: string;
          current: boolean;
        }
      | { status: "applied"; report: Report };
  }>(
    `/api/runs/${runId}/asset-import/${encodeURIComponent(step.id)}?state=${step.status}`,
  );
  if (state.loading) return <Loading />;
  if (state.error) return <Notice tone="error">{state.error}</Notice>;
  const p = state.data?.proposal;
  if (!p) return null;
  if (p.status === "applied") return <ImportReport report={p.report} />;
  return (
    <div className="asset-import-operation">
      <h3>{p.preview.source.sourceName}</h3>
      <p>
        {p.preview.source.filename} · stan na{" "}
        {dateLabel(p.preview.source.observedOn)}
      </p>
      <Notice tone={p.current ? "info" : "error"}>
        {p.current
          ? `Wybrane urządzenia: ${p.selectedRows.length}. Pominięte pozycje: ${p.preview.rows.length - p.selectedRows.length}.`
          : "Zakres jest nieaktualny lub źródło wygasło. Przygotuj nowy podgląd i plan."}
      </Notice>
      <p>{p.note}</p>
      <p className="small">
        Źródło oczekuje do {dateLabel(p.expiresAt, true)}.
      </p>
      <ImportRows
        rows={p.preview.rows.slice(offset, offset + 30)}
        selected={p.selectedRows}
        disabled
        onSelect={() => {}}
      />
      <div className="pagination">
        <button
          className="button secondary"
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 30))}
        >
          Poprzednie pozycje
        </button>
        <span>
          {offset + 1}–{Math.min(offset + 30, p.preview.rows.length)} z{" "}
          {p.preview.rows.length}
        </span>
        <button
          className="button secondary"
          disabled={offset + 30 >= p.preview.rows.length}
          onClick={() => setOffset(offset + 30)}
        >
          Następne pozycje
        </button>
      </div>
      <p>
        Import zapisze ewidencję. Potwierdzenie fizycznego wydania pozostaje
        osobną operacją.
      </p>
      <details>
        <summary>Odcisk źródła</summary>
        <code>{p.preview.source.sha256}</code>
      </details>
    </div>
  );
}
