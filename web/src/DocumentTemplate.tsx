import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { type Entity, type Run } from "./types";
import { Icon, Notice, Sheet } from "./ui";

export function DocumentTemplate({ onClose }: { onClose: () => void }) {
  const templates = useResource<{
    templates: { id: string; label: string; module: string }[];
  }>("/api/document-templates");
  const [templateId, setTemplateId] = useState("");
  const [sourceId, setSourceId] = useState("");
  const module = templates.data?.templates.find(
    (item) => item.id === templateId,
  )?.module;
  const sources = useResource<{ items: Entity[] }>(
    module ? `/api/workspace/${module}` : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(requestKey);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await post<{ run: Run }>(
        "/api/document-templates/prepare",
        { templateId, sourceId, idempotencyKey: key },
      );
      onClose();
      navigate(`runs/${result.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="Przygotuj dokument ze źródła"
      subtitle="Wersjonowany szkic do sprawdzenia"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="sheet-body">
          {(error || templates.error || sources.error) && (
            <Notice tone="error">
              {error || templates.error || sources.error}
            </Notice>
          )}
          <label className="field">
            <span>Rodzaj dokumentu</span>
            <select
              required
              disabled={busy}
              value={templateId}
              onChange={(event) => {
                setTemplateId(event.target.value);
                setSourceId("");
              }}
            >
              <option value="">Wybierz szablon…</option>
              {templates.data?.templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Rekord źródłowy</span>
            <select
              required
              disabled={busy || !module || sources.loading}
              value={sourceId}
              onChange={(event) => setSourceId(event.target.value)}
            >
              <option value="">
                {!module
                  ? "Najpierw wybierz szablon…"
                  : sources.loading
                    ? "Pobieranie rekordów…"
                    : sources.data?.items.length
                      ? "Wybierz rekord…"
                      : "Brak dostępnych rekordów"}
              </option>
              {!sources.loading &&
                sources.data?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} ·{" "}
                    {templateId === "case_scope"
                      ? `zakres ${String(item.data.scopeRevision)}`
                      : `wersja ${item.version}`}
                  </option>
                ))}
            </select>
          </label>
          <Notice>
            JARVIS ułoży dokument na podstawie wskazanego rekordu i zapisze
            informację o źródle. Sprawdzisz treść przed zatwierdzeniem zapisu
            szkicu.
          </Notice>
        </div>
        <div className="sheet-footer">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Anuluj
          </button>
          <button className="button primary" disabled={busy || !sourceId}>
            <Icon name="documents" size={17} />
            Przygotuj dokument
          </button>
        </div>
      </form>
    </Sheet>
  );
}
