import { useEffect, useState } from "react";
import { api } from "./api";
import type { EmploymentPeriod } from "./employment-periods";
import { dateLabel, statusLabel } from "./types";

export function useEmploymentPeriods(personId: string | null) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    personId: string | null;
    episodes: EmploymentPeriod[];
    loading: boolean;
    error: string;
  }>({ personId: null, episodes: [], loading: Boolean(personId), error: "" });
  useEffect(() => {
    if (!personId) return;
    let alive = true;
    const controller = new AbortController();
    setState({ personId, episodes: [], loading: true, error: "" });
    void api<{ episodes: EmploymentPeriod[] }>(
      `/api/people/${encodeURIComponent(personId)}/episodes`,
      { signal: controller.signal },
    )
      .then(({ episodes }) => {
        if (alive)
          setState({
            personId,
            episodes: episodes.filter(
              (episode) => episode.personId === personId,
            ),
            loading: false,
            error: "",
          });
      })
      .catch(() => {
        if (alive)
          setState({
            personId,
            episodes: [],
            loading: false,
            error:
              "Nie udało się odczytać okresów współpracy. Sprawdź dostęp i spróbuj ponownie.",
          });
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [personId, revision]);
  const current = personId && personId === state.personId;
  return {
    episodes: current ? state.episodes : [],
    loading: Boolean(personId) && (!current || state.loading),
    error: current ? state.error : "",
    refresh: () => setRevision((value) => value + 1),
  };
}
export function employmentPeriodLabel(episode: EmploymentPeriod) {
  const kind =
    episode.kind === "internal" ? "Pracownik wewnętrzny" : "Konsultant";
  const project = episode.engagementLabel
    ? `${episode.engagementLabel} · `
    : episode.engagementRef
      ? "Projekt (nazwa niedostępna) · "
      : "";
  return `${project}${episode.role} · ${kind} · od ${dateLabel(episode.startDate)}${episode.endDate ? ` do ${dateLabel(episode.endDate)}` : ""} · ${statusLabel(episode.status)}`;
}
export function EmploymentPeriodSelect({
  personId,
  episodes,
  selectedId,
  loading,
  error,
  disabled,
  onSelect,
  onRefresh,
}: {
  personId: string;
  episodes: EmploymentPeriod[];
  selectedId: string;
  loading: boolean;
  error: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const selected = episodes.find((episode) => episode.id === selectedId);
  return (
    <div className="field wide" aria-busy={loading}>
      <label htmlFor="field-employmentEpisodeId">
        Okres współpracy <span className="required">*</span>
      </label>
      <select
        id="field-employmentEpisodeId"
        required
        disabled={disabled || !personId || loading || Boolean(error)}
        value={selected?.id ?? ""}
        onChange={(event) => onSelect(event.target.value)}
        aria-describedby="employment-period-help"
      >
        <option value="">
          {!personId
            ? "Najpierw wybierz osobę…"
            : loading
              ? "Pobieranie okresów współpracy…"
              : episodes.length
                ? "Wybierz konkretną współpracę…"
                : "Brak okresu dostępnego dla tej operacji"}
        </option>
        {episodes.map((episode) => (
          <option key={episode.id} value={episode.id}>
            {employmentPeriodLabel(episode)}
          </option>
        ))}
      </select>
      <small id="employment-period-help">
        {selected
          ? "Operacja dotyczy wyłącznie wybranej współpracy. Jej aktualność zostanie ponownie sprawdzona przed zapisem."
          : "Wybierz współpracę, której dotyczy operacja."}
      </small>
      {personId && !loading && !error && !episodes.length && (
        <p className="small muted">
          Nie ma okresu w odpowiednim stanie. Sprawdź status współpracy w
          obszarze osób.
        </p>
      )}
      {error && (
        <p className="small" role="alert">
          {error}
        </p>
      )}
      {personId && (
        <button
          type="button"
          className="text-button"
          disabled={disabled || loading}
          onClick={onRefresh}
        >
          Odśwież okresy współpracy
        </button>
      )}
    </div>
  );
}
