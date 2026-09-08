import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import type { Entity, Run } from "./types";
import { Loading, Notice, Sheet } from "./ui";

export function DocumentReadiness({ item }: { item: Entity }) {
  const state = useResource<{
    readiness: {
      contract: string;
      readyForReview: boolean;
      approvalCurrent: boolean;
      blockers: string[];
      references: {
        module: string;
        id: string;
        kind?: string;
        version: number;
        currentVersion: number | null;
        current: boolean;
      }[];
    };
  }>(`/api/documents/${item.id}/readiness`, item.version);
  const r = state.data?.readiness;
  return (
    <section className="card" aria-label="Kontrola dokumentu">
      <div className="card-heading">
        <h2>Źródła i akceptacja dokumentu</h2>
      </div>
      {state.loading && <Loading />}
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {r && (
        <>
          <Notice
            tone={
              r.approvalCurrent
                ? "success"
                : r.readyForReview
                  ? undefined
                  : "error"
            }
          >
            {r.approvalCurrent
              ? "Zaakceptowana rewizja ma aktualne źródła i zgodną treść."
              : r.readyForReview
                ? "Źródła i treść są zgodne. Akceptacja tej rewizji wymaga osobnej decyzji."
                : "Dokument wymaga uzupełnienia przed przekazaniem lub akceptacją."}
          </Notice>
          {r.blockers.length > 0 && (
            <ul>
              {r.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {r.references.length > 0 ? (
            <ul>
              {r.references.map((s, i) => (
                <li key={i}>
                  {s.kind === "case_scope"
                    ? "Uzgodniony zakres sprawy"
                    : `Rekord: ${s.module}`}{" "}
                  · wersja {s.version} ·{" "}
                  {s.current
                    ? "aktualne"
                    : `wymaga odświeżenia${s.currentVersion === null ? " — źródło niedostępne" : ` (obecnie ${s.currentVersion})`}`}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Brak wskazanych źródeł. Autor odpowiada za treść własną; dokument
              onboardingu wymaga powiązania z uzgodnionym zakresem.
            </p>
          )}
          <p className="small muted">
            Rewizja zachowuje poprzednią treść i decyzje. Odświeżenie źródeł nie
            zmienia automatycznie tekstu dokumentu.
          </p>
        </>
      )}
    </section>
  );
}

export function DocumentRevision({
  item,
  onClose,
}: {
  item: Entity;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(item.title),
    [content, setContent] = useState(String(item.data.content ?? "")),
    [changeNote, setChangeNote] = useState("");
  const [refresh, setRefresh] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const proposed = useResource<{
    input: {
      id: string;
      expectedVersion: number;
      sources: Record<string, unknown>[];
    };
  }>(refresh ? `/api/documents/${item.id}/refresh-sources` : null);
  const [key] = useState(requestKey);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      refresh &&
      (!proposed.data || proposed.data.input.expectedVersion !== item.version)
    ) {
      setError("Dokument zmienił wersję. Otwórz aktualny rekord ponownie.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: "ops.documents.revise",
        input: {
          id: item.id,
          expectedVersion: item.version,
          title,
          content,
          changeNote,
          ...(refresh ? { sources: proposed.data!.input.sources } : {}),
        },
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Nowa rewizja dokumentu"
      subtitle="Treść, nazwa i jawne źródła do zatwierdzenia"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="sheet-body">
          {(error || proposed.error) && (
            <Notice tone="error">{error || proposed.error}</Notice>
          )}
          <label className="field">
            <span>Nazwa dokumentu</span>
            <input
              required
              maxLength={160}
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Treść nowej rewizji</span>
            <textarea
              required
              maxLength={50000}
              rows={12}
              value={content}
              disabled={busy}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Powód i opis zmian</span>
            <textarea
              required
              maxLength={4000}
              value={changeNote}
              disabled={busy}
              onChange={(e) => setChangeNote(e.target.value)}
            />
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={refresh}
              disabled={busy}
              onChange={(e) => setRefresh(e.target.checked)}
            />
            <span>Jawnie odśwież wskazane źródła do obecnych wersji</span>
          </label>
          <Notice>
            {refresh
              ? "Sprawdź tekst względem nowych źródeł. JARVIS nie poprawia go automatycznie i nie zachowuje dawnej akceptacji."
              : "Nowa rewizja zachowa dokładne dotychczasowe referencje. Nieaktualne źródło będzie nadal blokować akceptację."}
          </Notice>
          {refresh && proposed.loading && <Loading />}
          {refresh && proposed.data && (
            <ul>
              {proposed.data.input.sources.map((s, i) => (
                <li key={i}>
                  {s.kind === "case_scope"
                    ? "Uzgodniony zakres"
                    : String(s.module)}{" "}
                  · wersja {String(s.version)}
                </li>
              ))}
            </ul>
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
            className="button primary"
            disabled={
              busy ||
              (refresh &&
                (!proposed.data || proposed.loading || !!proposed.error))
            }
          >
            Przygotuj rewizję
          </button>
        </div>
      </form>
    </Sheet>
  );
}
