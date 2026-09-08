import { useState, type FormEvent } from "react";
import type { OnboardingOverview } from "../../src/onboarding";
import { post, requestKey } from "./api";
import { errorMessage, navigate } from "./hooks";
import { dateLabel, type Run } from "./types";
import { Notice, Sheet } from "./ui";

export function StartCancellationSummary({
  overview,
  onPrepare,
}: {
  overview: OnboardingOverview;
  onPrepare?: () => void;
}) {
  if (overview.cancellationDecision) {
    const d = overview.cancellationDecision;
    return (
      <Notice>
        <strong>Decyzja o niezrealizowanym starcie</strong>
        <p>{d.reason}</p>
        <p>
          {dateLabel(d.at, true)} · właściciel: {d.requestedBy} · zatwierdzenie:{" "}
          {d.approvedBy}
        </p>
      </Notice>
    );
  }
  const state = overview.cancellation;
  if (!state) return null;
  return (
    <details className="onboarding-cancellation">
      <summary>Jeśli ta współpraca nie rozpocznie się</summary>
      <h3>Anulowanie rozpoczęcia</h3>
      <p>
        Decyzja dotyczy wskazanego okresu. Historia i potwierdzenia pozostaną
        dostępne; rejestr nie zapisze przepracowanego okresu ani daty
        zakończenia.
      </p>
      {state.blockers.length ? (
        <>
          <p>
            <strong>Najpierw rozlicz zasoby</strong>
          </p>
          <ul>
            {state.blockers.map((b, i) => (
              <li key={`${b.kind}-${b.id ?? i}-${i}`}>
                <strong>{b.title}</strong>
                <p>{b.next}</p>
                {b.module && b.id && (
                  <button
                    className="text-button"
                    onClick={() => navigate(`module/${b.module}/${b.id}`)}
                  >
                    Otwórz powiązany rekord
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>
          Nie ma otwartych przydziałów ani nierozstrzygniętych zasobów
          blokujących tę decyzję.
        </p>
      )}
      {onPrepare && state.command ? (
        <button className="button secondary" onClick={onPrepare}>
          Przygotuj anulowanie rozpoczęcia
        </button>
      ) : (
        state.ready && (
          <p className="small muted">
            Plan decyzji przygotowuje właściciel tej sprawy z dostępem do
            rozliczanych obszarów.
          </p>
        )
      )}
    </details>
  );
}

export function StartCancellationDecision({
  overview,
  onClose,
}: {
  overview: OnboardingOverview;
  onClose: () => void;
}) {
  const [key] = useState(requestKey),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const command = overview.cancellation!.command!;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ run: Run }>("/api/commands", {
        toolId: command.toolId,
        input: {
          ...command.input,
          reason,
          humanDecision: true,
          workNeverStarted: true,
        },
        idempotencyKey: key,
      });
      navigate(`runs/${result.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Anulowanie rozpoczęcia współpracy" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <p>
            <strong>{overview.person.title}</strong> ·{" "}
            {overview.engagement?.title ??
              (overview.episode.kind === "internal"
                ? "współpraca wewnętrzna"
                : "wskazana współpraca")}{" "}
            · planowany start {dateLabel(overview.episode.startDate)}
          </p>
          <p>
            JARVIS zamknie przygotowanie tego okresu i jego otwarte zadania.
            Nowy start będzie wymagał osobnego zakresu, dowodów i odbioru.
          </p>
          <label className="field">
            <span>Powód anulowania</span>
            <textarea
              required
              minLength={3}
              maxLength={4000}
              value={reason}
              disabled={busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="checkbox-field">
            <input
              type="checkbox"
              required
              checked={confirmed}
              disabled={busy}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Potwierdzam, że ta współpraca nie została rozpoczęta
          </label>
          <Notice>
            Przygotujesz plan do zatwierdzenia. Przed zapisem JARVIS ponownie
            sprawdzi wersję okresu, zakres oraz rozliczenie zasobów.
          </Notice>
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Wróć
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={!confirmed || busy}
          >
            {busy ? "Przygotowywanie…" : "Przygotuj plan anulowania"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}
