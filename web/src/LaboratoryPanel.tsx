import { useState } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Icon, Notice } from "./ui";

export function LaboratoryPanel({ context }: { context: Context }) {
  const runs = useResource<{ runs: Run[] }>("/api/runs", 0, 5000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const allowed = (id: string) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((tool) => tool.id === id);
  const observed = runs.data?.runs
    .flatMap((run) =>
      run.steps
        .filter(
          (step) =>
            step.toolId === "lab.inspect" &&
            step.status === "succeeded" &&
            typeof step.output?.data.version === "number",
        )
        .map((step) => ({ run, data: step.output!.data })),
    )
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt))[0];
  if (!context.tools.some((tool) => tool.id.startsWith("lab."))) return null;
  async function plan(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await post<{ run: Run }>("/api/commands", {
        toolId: id,
        input:
          id === "lab.inspect"
            ? {}
            : { expectedVersion: observed?.data.version },
        idempotencyKey: requestKey(),
      });
      navigate(`runs/${response.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card laboratory-panel">
      <div>
        <span className="eyebrow">WYDZIELONE LABORATORIUM JARVIS</span>
        <h2>Sprawdź, napraw, potwierdź wynik</h2>
        <p className="muted">
          Własna lokalna usługa HTTP do ćwiczenia diagnostyki i kontrolowanej
          naprawy.
        </p>
        {observed ? (
          <p className="small">
            Ostatni odczyt: HTTP {String(observed.data.httpStatus)} · wersja{" "}
            {String(observed.data.version)} ·{" "}
            {dateLabel(String(observed.data.observedAt), true)}
          </p>
        ) : (
          <p className="small muted">
            Zacznij od odczytu aktualnego stanu usługi.
          </p>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="button-group">
        {allowed("lab.inspect") && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void plan("lab.inspect")}
          >
            <Icon name="pulse" size={17} />
            Sprawdź usługę
          </button>
        )}
        {allowed("lab.repair") && (
          <button
            className="button primary"
            disabled={busy || !observed}
            onClick={() => void plan("lab.repair")}
          >
            Przygotuj naprawę
          </button>
        )}
        {allowed("lab.simulateFailure") && (
          <button
            className="text-button"
            disabled={busy || !observed}
            onClick={() => void plan("lab.simulateFailure")}
          >
            Zaplanuj awarię testową
          </button>
        )}
      </div>
      <p className="small muted">
        Każda zmiana wymaga sprawdzenia zakresu i zgody. Odczyt HTTP po naprawie
        służy jako niezależny dowód.
      </p>
    </section>
  );
}
