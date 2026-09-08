import { useState, type FormEvent } from "react";
import { download, post, requestKey, uploadDocument } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { type Entity, type Run } from "./types";
import { Loading, Notice, Sheet } from "./ui";
type FileRecord = {
  id: string;
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  manifestHash: string;
  revisions: number[];
  current: boolean;
  valid: boolean;
};
const types: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
export function DocumentFiles({
  item,
  canWrite,
}: {
  item: Entity;
  canWrite: boolean;
}) {
  const state = useResource<{ files: FileRecord[] }>(
    `/api/documents/${item.id}/files`,
    item.version,
  );
  const [upload, setUpload] = useState(false),
    [removing, setRemoving] = useState<FileRecord | null>(null),
    [error, setError] = useState("");
  const mutable =
    canWrite &&
    ["draft", "review", "approved", "rejected"].includes(item.status);
  return (
    <section className="card document-files" aria-label="Pliki dokumentu">
      <div className="card-heading">
        <h2>Pliki i rewizje</h2>
        {mutable && (
          <button className="button secondary" onClick={() => setUpload(true)}>
            Dodaj plik
          </button>
        )}
      </div>
      {state.loading && <Loading />}
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {state.data?.files.length === 0 && (
        <p className="muted">
          Dokument nie ma załączników. Dodanie pliku przygotuje nową rewizję do
          odrębnego odbioru.
        </p>
      )}
      {state.data?.files.map((f) => (
        <article key={f.id} className="card">
          <h3>{f.filename}</h3>
          <p>
            {f.current ? "Bieżąca rewizja" : "Plik historyczny"} · rewizje{" "}
            {f.revisions.join(", ")} · {(f.bytes / 1024).toFixed(1)} KiB
          </p>
          <Notice tone={f.valid ? "success" : "error"}>
            {f.valid
              ? "Plik jest dostępny i zgodny z manifestem."
              : "Plik jest niedostępny lub ma niezgodny odcisk. Nie potwierdza gotowości dokumentu."}
          </Notice>
          <details>
            <summary>Odcisk pliku</summary>
            <p className="small">
              <code>{f.sha256}</code>
            </p>
          </details>
          <div className="actions">
            <button
              className="button secondary"
              disabled={!f.valid}
              onClick={() => {
                setError("");
                void download(
                  `/api/documents/${item.id}/files/${f.id}`,
                  f.filename,
                ).catch((e) => setError(errorMessage(e)));
              }}
            >
              Pobierz plik
            </button>
            {mutable && f.current && (
              <button
                className="button secondary"
                onClick={() => setRemoving(f)}
              >
                Usuń z nowej rewizji
              </button>
            )}
          </div>
        </article>
      ))}
      <p className="small muted">
        Zmiana plików wymaga zgody na zapis i nowego odbioru dokumentu.
        Historyczne pliki pozostają dostępne w odpowiednich rewizjach.
      </p>
      {upload && <Upload item={item} onClose={() => setUpload(false)} />}
      {removing && (
        <Removal
          item={item}
          file={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}
function Upload({ item, onClose }: { item: Entity; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null),
    [note, setNote] = useState(""),
    [key, setKey] = useState(requestKey),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const type = types[file.name.split(".").pop()?.toLowerCase() ?? ""];
      if (!type || file.size < 1 || file.size > 10 * 1024 * 1024)
        throw new Error("Wybierz PDF, DOCX, TXT, MD, PNG lub JPG do 10 MiB.");
      const { run } = await uploadDocument<{ run: Run }>(
        item.id,
        item.version,
        file,
        type,
        note,
        key,
      );
      navigate(`runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Dodaj plik do dokumentu"
      subtitle="Nowa rewizja po sprawdzeniu i zgodzie"
      onClose={onClose}
    >
      <form className="command-form" onSubmit={(e) => void submit(e)}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <label className="field">
            <span>Plik źródłowy</span>
            <input
              type="file"
              accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg"
              required
              disabled={busy}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setKey(requestKey());
              }}
            />
          </label>
          <p className="small muted">
            Do 10 MiB. Plik pozostanie lokalnie w JARVIS. Jego treść nie jest
            przekazywana do modelu.
          </p>
          <label className="field">
            <span>Powód dodania</span>
            <textarea
              required
              maxLength={500}
              value={note}
              disabled={busy}
              onChange={(e) => {
                setNote(e.target.value);
                setKey(requestKey());
              }}
            />
          </label>
          <Notice>
            Po przygotowaniu zobaczysz nazwę, rozmiar, typ i odcisk. Dopiero
            zgoda doda plik do nowej rewizji. Poprzedni odbiór pozostanie w
            historii.
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
          <button className="button primary" disabled={busy || !file}>
            {busy ? "Przygotowywanie…" : "Przygotuj dodanie pliku"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
function Removal({
  item,
  file,
  onClose,
}: {
  item: Entity;
  file: FileRecord;
  onClose: () => void;
}) {
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key, setKey] = useState(requestKey);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: "ops.documents.detachFile",
        input: {
          id: item.id,
          expectedVersion: item.version,
          fileId: file.id,
          changeNote: note,
        },
        idempotencyKey: key,
      });
      navigate(`runs/${run.id}`);
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Usuń plik z nowej rewizji"
      subtitle={file.filename}
      onClose={onClose}
    >
      <form className="command-form" onSubmit={(e) => void submit(e)}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <label className="field">
            <span>Powód zmiany</span>
            <textarea
              required
              maxLength={500}
              value={note}
              disabled={busy}
              onChange={(e) => {
                setNote(e.target.value);
                setKey(requestKey());
              }}
            />
          </label>
          <Notice>
            Plik i poprzednia akceptacja pozostaną w historii. Nowa rewizja
            będzie wymagała osobnego odbioru.
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
          <button className="button primary" disabled={busy}>
            Przygotuj zmianę
          </button>
        </div>
      </form>
    </Sheet>
  );
}
