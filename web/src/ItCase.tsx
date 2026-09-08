import { useState } from "react";
import type { WorkspaceStore } from "../../src/workspace";
import { LaboratoryStatus, certificateErrorLabel } from "./LaboratoryPanel";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Notice } from "./ui";

type ItCaseView = ReturnType<WorkspaceStore["laboratoryCase"]>;
export function ItCaseCard({
  item,
  view,
  onRepair,
  onInspect,
  onBind,
  busy = false,
}: {
  item: Entity;
  view: ItCaseView;
  onRepair?: () => void;
  onInspect?: () => void;
  onBind?: (id: string) => void;
  busy?: boolean;
}) {
  const tls = view.laboratory.protocol === "HTTPS";
  const observation = view.context.observation as Record<string, unknown>,
    closed = ["accepted", "cancelled"].includes(item.status);
  const requirement = view.readiness.requirements.find(
    (r) => r.kind === "test_passed",
  );
  return (
    <section className="card laboratory-panel">
      <span className="eyebrow">SPRAWA IT · WŁASNE LABORATORIUM</span>
      <h2>Diagnoza, procedura i wynik</h2>
      <p>
        <strong>Właściciel odbioru:</strong>{" "}
        {String(item.data.ownerPrincipalId)} · <strong>Termin:</strong>{" "}
        {dateLabel(String(item.data.dueDate))}
      </p>
      <p>
        <strong>Obserwacja źródłowa:</strong>{" "}
        {tls && (observation.tls as Record<string, unknown>)?.errorCode
          ? certificateErrorLabel(
              (observation.tls as Record<string, unknown>).errorCode,
            )
          : observation.httpStatus === null
            ? "brak odpowiedzi"
            : `HTTP ${String(observation.httpStatus)}`}{" "}
        · {dateLabel(String(observation.observedAt), true)}
      </p>
      <p>
        <strong>Diagnoza operatora i zakres:</strong> {String(item.data.brief)}
      </p>
      <p>
        <strong>Procedura:</strong>{" "}
        {tls
          ? "odnowienie certyfikatu własnej usługi HTTPS"
          : "przywrócenie własnej usługi HTTP"}
        ; wersja {String(view.context.procedureVersion)}.{" "}
        {tls
          ? "Test sprawdza nazwę, daty, łańcuch zaufania, odcisk i odpowiedź HTTPS."
          : "Test osobno odczytuje odpowiedź i wersję usługi."}
      </p>
      <LaboratoryStatus laboratory={view.laboratory} />
      {onInspect && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={onInspect}
        >
          Sprawdź bieżący stan
        </button>
      )}
      {!closed && onRepair && (
        <button
          className="button primary"
          disabled={
            busy ||
            !view.laboratory.observed?.current ||
            !view.laboratory.observed.verified
          }
          onClick={onRepair}
        >
          Przygotuj zatwierdzaną naprawę
        </button>
      )}
      {!view.proofs.length && (
        <Notice>
          Brak zakończonej, niezależnie zweryfikowanej naprawy dla tej rewizji.
          Sam opis wykonanej pracy nie spełnia warunku testu.
        </Notice>
      )}
      {view.testHistory
        .filter((test) => test.result !== "positive")
        .map((test) => (
          <Notice key={test.id} tone="error">
            {test.result === "negative"
              ? "Test nie potwierdził naprawy."
              : "Wynik testu nie został potwierdzony przez Core."}{" "}
            {test.tlsErrorCode
              ? certificateErrorLabel(test.tlsErrorCode)
              : test.httpStatus === null
                ? "Brak odpowiedzi HTTP"
                : `HTTP ${test.httpStatus}`}{" "}
            · {dateLabel(test.observedAt, true)} · rewizja {test.scopeRevision}
            <button
              className="text-button"
              onClick={() => navigate(`runs/${test.runId}`)}
            >
              Sprawdź wykonanie przed dalszym działaniem
            </button>
          </Notice>
        ))}
      {view.proofs.map((proof) => (
        <article className="requirement-row" key={proof.id}>
          <div className="requirement-body">
            <h3>
              {proof.identity.current
                ? tls
                  ? "Pozytywny i aktualny test certyfikatu oraz HTTPS"
                  : "Pozytywny i aktualny test HTTP"
                : "Historyczny wynik — wymaga ponownej kontroli"}
            </h3>
            <p>
              {view.laboratory.protocol} {String(proof.identity.httpStatus)} ·
              wersja {String(proof.identity.version)} ·{" "}
              {dateLabel(String(proof.identity.observedAt), true)}
            </p>
            <p className="small">
              Operator: {String(proof.identity.requestedBy)} · zgoda:{" "}
              {String(proof.identity.approvedBy)}
            </p>
            <div className="button-group">
              <button
                className="text-button"
                onClick={() => navigate(`runs/${String(proof.identity.runId)}`)}
              >
                Zobacz wykonanie i test
              </button>
              {!closed &&
                requirement &&
                !requirement.source &&
                proof.identity.current === true &&
                onBind && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => onBind(proof.id)}
                  >
                    Powiąż test z odbiorem
                  </button>
                )}
            </div>
          </div>
        </article>
      ))}
      <p className="small muted">
        Dowód obowiązuje przez 5 minut i traci aktualność po zmianie stanu.
        Zmiana zamrożonego powiązania wymaga nowej rewizji sprawy. Odbiór
        pozostaje osobną decyzją właściciela.
      </p>
    </section>
  );
}
export function ItCase({ item, context }: { item: Entity; context: Context }) {
  const resource = useResource<{ laboratoryCase: ItCaseView }>(
    `/api/cases/${item.id}/laboratory`,
    item.version,
    5000,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const allowed = (id: string) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((tool) => tool.id === id);
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
  const view = resource.data?.laboratoryCase;
  return (
    <>
      {(error || resource.error) && (
        <Notice tone="error">{error || resource.error}</Notice>
      )}
      {view && (
        <ItCaseCard
          item={item}
          view={view}
          busy={busy}
          onRepair={
            allowed(view.laboratory.procedureId)
              ? () =>
                  void command(view.laboratory.procedureId, view.repairInput)
              : undefined
          }
          onInspect={
            allowed(view.laboratory.inspectTool)
              ? () => void command(view.laboratory.inspectTool, {})
              : undefined
          }
          onBind={
            allowed("ops.cases.bindEvidence")
              ? (id) => {
                  const proof = view.proofs.find((p) => p.id === id),
                    requirement = view.readiness.requirements.find(
                      (r) => r.kind === "test_passed",
                    );
                  if (proof && requirement)
                    void command("ops.cases.bindEvidence", {
                      id: item.id,
                      expectedVersion: item.version,
                      requirementId: requirement.id,
                      sourceModule: "laboratory",
                      sourceId: id,
                      sourceVersion: proof.version,
                      sourceProofHash: proof.hash,
                    });
                }
              : undefined
          }
        />
      )}
    </>
  );
}
