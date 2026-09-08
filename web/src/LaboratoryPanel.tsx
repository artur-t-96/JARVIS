import { useState, type FormEvent } from "react";
import type { WorkspaceStore } from "../../src/workspace";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Icon, Notice, Sheet } from "./ui";

export type LaboratoryView = ReturnType<WorkspaceStore["laboratoryOverview"]>;
export function LaboratoryStatus({
  laboratory,
}: {
  laboratory: LaboratoryView;
}) {
  const observed = laboratory.observed;
  return (
    <div>
      <h3>{laboratory.title}</h3>
      <p>
        {!observed
          ? "Brak obserwacji"
          : !observed.current
            ? "Stan nieaktualny — sprawdź usługę ponownie"
            : !observed.verified
              ? "Oczekiwanie na zakończenie weryfikacji odczytu"
              : observed.healthy
                ? "Usługa odpowiada poprawnie"
                : "Wykryta niedostępność usługi"}
      </p>
      {observed && (
        <p className="small muted">
          {observed.httpStatus === null
            ? "Brak poprawnej odpowiedzi HTTP"
            : `HTTP ${observed.httpStatus}`}{" "}
          · wersja {observed.version} · {dateLabel(observed.observedAt, true)}
        </p>
      )}
      <p className="small muted">
        Źródło: własne laboratorium JARVIS · aktualność do{" "}
        {laboratory.freshnessSeconds / 60} min.
      </p>
    </div>
  );
}
export function LaboratoryPanel({ context }: { context: Context }) {
  const resource = useResource<{ laboratory: LaboratoryView }>(
    "/api/laboratory",
    0,
    5000,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [diagnosis, setDiagnosis] = useState("");
  const [dueDate, setDueDate] = useState("");
  const allowed = (id: string) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((tool) => tool.id === id);
  const laboratory = resource.data?.laboratory,
    observed = laboratory?.observed;
  if (!context.tools.some((tool) => tool.id.startsWith("lab."))) return null;
  async function command(toolId: string, input: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId,
        input,
        idempotencyKey: requestKey(),
      });
      navigate(`runs/${run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function createCase(event: FormEvent) {
    event.preventDefault();
    if (!laboratory || !observed) return;
    void command("ops.cases.create", {
      title: "Przywrócenie usługi laboratorium",
      data: {
        caseType: "it",
        brief: diagnosis,
        dueDate,
        acceptanceCriteria:
          "HTTP 200 dla własnej usługi po zatwierdzonej naprawie; aktualny niezależny test i odbiór właściciela.",
        laboratory: {
          targetId: laboratory.targetId,
          observationId: observed.id,
          observationHash: observed.hash,
          procedureId: laboratory.procedureId,
          procedureVersion: laboratory.procedureVersion,
        },
      },
    });
  }
  return (
    <section className="card laboratory-panel">
      <div>
        <span className="eyebrow">WYDZIELONE LABORATORIUM JARVIS</span>
        <h2>Od awarii do odebranej naprawy</h2>
        <p className="muted">
          Obserwacja, diagnoza, uzgodniony zakres, zatwierdzona procedura i
          niezależny wynik.
        </p>
        {laboratory && <LaboratoryStatus laboratory={laboratory} />}
      </div>
      {(error || resource.error) && (
        <Notice tone="error">{error || resource.error}</Notice>
      )}
      <div className="button-group">
        {allowed("lab.inspect") && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void command("lab.inspect", {})}
          >
            <Icon name="pulse" size={17} />
            Sprawdź usługę
          </button>
        )}
        {laboratory?.activeCase ? (
          <button
            className="button primary"
            onClick={() =>
              navigate(`module/cases/${laboratory.activeCase!.id}`)
            }
          >
            Otwórz sprawę naprawy
          </button>
        ) : (
          allowed("ops.cases.create") && (
            <button
              className="button primary"
              disabled={
                busy ||
                !observed?.current ||
                !observed.verified ||
                observed.healthy
              }
              onClick={() => setCreating(true)}
            >
              Przygotuj sprawę naprawy
            </button>
          )
        )}
        {allowed("lab.simulateFailure") && (
          <button
            className="text-button"
            disabled={busy || !observed?.current || !observed.verified}
            onClick={() =>
              void command("lab.simulateFailure", {
                expectedVersion: observed?.version,
              })
            }
          >
            Zaplanuj awarię testową
          </button>
        )}
      </div>
      <p className="small muted">
        Naprawa dotyczy wyłącznie tej usługi. Jej odbiór wymaga aktualnego
        dowodu i osobnej decyzji człowieka.
      </p>
      {creating && laboratory && observed && (
        <Sheet
          title="Sprawa naprawy własnej usługi"
          subtitle="Diagnoza i zakres do zatwierdzenia"
          onClose={() => setCreating(false)}
        >
          <form className="command-form" onSubmit={createCase}>
            <div className="sheet-body">
              {error && <Notice tone="error">{error}</Notice>}
              <LaboratoryStatus laboratory={laboratory} />
              <p>
                Właściciel odbioru: {context.principal.id}. Procedura przywróci
                odpowiedź HTTP własnej usługi i wykona osobny test.
              </p>
              <label className="field">
                <span>Diagnoza i oczekiwany rezultat</span>
                <textarea
                  required
                  maxLength={10000}
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Termin</span>
                <input
                  type="date"
                  required
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </label>
              <p className="small muted">
                Obserwacja potwierdza niedostępność. Hipotezy dotyczące
                przyczyny zapisz jawnie jako hipotezy.
              </p>
            </div>
            <div className="sheet-footer">
              <button
                className="button secondary"
                type="button"
                onClick={() => setCreating(false)}
              >
                Wróć
              </button>
              <button
                className="button primary"
                disabled={busy || !observed.current || observed.healthy}
              >
                {busy ? "Przygotowywanie…" : "Przygotuj plan utworzenia sprawy"}
              </button>
            </div>
          </form>
        </Sheet>
      )}
    </section>
  );
}
