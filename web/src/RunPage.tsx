import { useState } from "react";
import { AssetImportOperation } from "./AssetImports";
import { ReportOperation } from "./OperationalReports";
import { SalesOperation } from "./Sales";
import { post } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Badge, Icon, JsonView, Loading, Notice } from "./ui";

const fileOperation = (toolId: string) =>
  ["ops.documents.attachFile", "ops.documents.detachFile"].includes(toolId);

function FileOperation({
  input,
  attach,
}: {
  input: Record<string, unknown>;
  attach: boolean;
}) {
  const fields = attach
    ? [
        ["Plik", input.filename],
        ["Rozmiar", `${Number(input.bytes).toLocaleString("pl-PL")} bajtów`],
        ["Typ", input.mediaType],
        ["Materiał ważny do", dateLabel(String(input.expiresAt), true)],
        ["SHA-256 pliku", input.sha256],
      ]
    : [["Identyfikator pliku", input.fileId]];
  return (
    <div className="file-operation">
      <dl>
        {[
          ...fields,
          ["Wersja dokumentu", input.expectedVersion],
          ["Powód zmiany", input.changeNote],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt>{String(label)}</dt>
            <dd>{String(value ?? "—")}</dd>
          </div>
        ))}
      </dl>
      <button
        className="text-button"
        onClick={() => navigate(`module/documents/${String(input.id)}`)}
      >
        Otwórz dokument
      </button>
      <p className="small muted">
        Zmiana utworzy nową rewizję do osobnego odbioru. Poprzednia treść, pliki
        i decyzje pozostaną w historii.
      </p>
      <details className="technical-details">
        <summary>Pełny zakres techniczny</summary>
        <JsonView value={input} />
      </details>
    </div>
  );
}

export const isHumanTaskOperation = (toolId: string) =>
  /^ops\.cases\.(acceptTask|declineTask|transferTask|completeTask|cancelTask)$/.test(
    toolId,
  ) ||
  /^ops\.assets\.(issueForTask|returnForTask|bindAssetForTask)$/.test(toolId);

function ReplacementResult({ value }: { value: unknown }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (
    typeof result.sourceAssetId !== "string" ||
    typeof result.replacementAssetId !== "string"
  )
    return null;
  return (
    <div className="verification">
      <p>
        Poprzednia rezerwacja została zwolniona. Nowe urządzenie zarezerwowano
        dla tej samej osoby, współpracy i sprawy.
      </p>
      <p>
        Termin pozostał bez zmiany:{" "}
        {dateLabel(
          typeof result.expiresAt === "string" ? result.expiresAt : undefined,
          true,
        )}
        .
      </p>
      <button
        className="text-button"
        onClick={() =>
          navigate(`module/assets/${String(result.sourceAssetId)}`)
        }
      >
        Otwórz poprzednie urządzenie
      </button>
    </div>
  );
}

const eventLabels: Record<string, string> = {
  plan_created: "Przygotowano plan",
  run_started: "Rozpoczęto wykonanie",
  step_started: "Rozpoczęto krok",
  approval_requested: "Poproszono o zgodę",
  approval_approved: "Udzielono zgody",
  approval_rejected: "Odrzucono operację",
  effect_recorded: "Zapisano wynik operacji",
  step_verified: "Potwierdzono wynik",
  verification_failed: "Weryfikacja nie potwierdziła wyniku",
  run_completed: "Zakończono wykonanie",
  cancellation_requested: "Zlecono zatrzymanie",
  reconciliation_started: "Rozpoczęto uzgadnianie wyniku",
  reconciliation_requested: "Zlecono uzgodnienie wyniku",
  outcome_unknown: "Wynik wymaga uzgodnienia",
  step_blocked: "Zablokowano krok",
  verification_resumed: "Wznowiono weryfikację",
};
export function RunPage({ id, context }: { id: string; context: Context }) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<{ run: Run }>(
    `/api/runs/${encodeURIComponent(id)}`,
    revision,
    1800,
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  async function action(operation: string, body: unknown = {}) {
    setBusy(operation);
    setError("");
    try {
      await post(`/api/runs/${id}/${operation}`, body);
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  const run = resource.data?.run;
  const isOperator = context.principal.roles.includes("operator");
  const isApprover = context.principal.roles.includes("approver");
  if (!run)
    return resource.error ? (
      <Notice tone="error">{resource.error}</Notice>
    ) : (
      <Loading />
    );
  return (
    <>
      <button className="text-button back-link" onClick={() => navigate("ops")}>
        <Icon name="back" size={16} />
        Wykonania
      </button>
      <div className="page-heading">
        <div>
          <span className="eyebrow">WYKONANIE · {run.id.slice(0, 8)}</span>
          <h1>{run.title}</h1>
          <div className="heading-meta">
            <Badge status={run.status} />
            <span>{dateLabel(run.createdAt, true)}</span>
          </div>
        </div>
        <div className="button-group">
          {run.status === "planned" && isOperator && (
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() => void action("start")}
            >
              <Icon name="arrow" size={18} />
              Rozpocznij
            </button>
          )}
          {["needs_reconciliation", "blocked", "failed"].includes(run.status) &&
            isOperator && (
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => void action("retry")}
              >
                <Icon name="refresh" size={17} />
                Uzgodnij / sprawdź ponownie
              </button>
            )}
          {!["completed", "cancelled"].includes(run.status) && isOperator && (
            <button
              className="button ghost"
              disabled={!!busy}
              onClick={() => void action("cancel")}
            >
              Zatrzymaj
            </button>
          )}
        </div>
      </div>
      {(error || resource.error) && (
        <Notice tone="error">{error || resource.error}</Notice>
      )}
      {run.status === "planned" && (
        <Notice>
          Sprawdź plan i rozpocznij wykonanie. Operacje zapisujące dane będą
          wymagały zgody na ich konkretny zakres.
        </Notice>
      )}
      {run.status === "completed" && (
        <Notice tone="success">
          Operacje zostały wykonane i zweryfikowane.{" "}
          {run.steps.some((step) =>
            [
              "ops.documents.createReport",
              "ops.documents.refreshReport",
            ].includes(step.toolId),
          )
            ? "Odbiór raportu jest osobną decyzją w module Dokumenty."
            : "Odbiór biznesowy sprawy jest osobną decyzją w module Sprawy."}
        </Notice>
      )}
      {run.status === "needs_reconciliation" && (
        <Notice tone="error">
          Wynik operacji pozostaje niepewny. JARVIS musi uzgodnić go ze źródłem
          przed podjęciem kolejnych działań.
        </Notice>
      )}
      {run.cancellationRequested && (
        <Notice>
          Zlecono zatrzymanie. Jeśli operacja już trwała, jej skutek nadal
          wymaga sprawdzenia.
        </Notice>
      )}
      <div className="run-layout">
        <div>
          <section className="card run-summary">
            <span className="eyebrow">CEL I PLAN</span>
            <p className="request-text">
              {run.steps.length === 1 &&
              (fileOperation(run.steps[0]!.toolId) ||
                [
                  "ops.assets.importBatch",
                  "ops.documents.createReport",
                  "ops.documents.refreshReport",
                ].includes(run.steps[0]!.toolId))
                ? run.title
                : run.request}
            </p>
            <p className="muted">{run.plan.summary}</p>
          </section>
          <div className="steps">
            {run.steps.map((step, index) => (
              <section
                className={`card step ${step.status === "waiting_approval" ? "step-needs-decision" : ""}`}
                key={step.id}
              >
                <div className="step-header">
                  <span
                    className={`step-number ${step.status === "succeeded" ? "done" : ""}`}
                  >
                    {step.status === "succeeded" ? (
                      <Icon name="check" size={17} />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div>
                    <h2>{step.title}</h2>
                    <span className="small muted">{step.toolId}</span>
                  </div>
                  <Badge status={step.status} />
                </div>
                {step.toolId.startsWith("demo.") && (
                  <span className="demo-label">
                    Dane demonstracyjne · lokalny test
                  </span>
                )}
                {step.error && <Notice tone="error">{step.error}</Notice>}
                <div className="step-body">
                  <div className="section-label">
                    {step.status === "waiting_approval"
                      ? "Dokładny zakres operacji do zatwierdzenia"
                      : "Argumenty operacji"}
                  </div>
                  {step.toolId === "ops.assets.importBatch" ? (
                    <AssetImportOperation runId={run.id} step={step} />
                  ) : [
                      "ops.documents.createReport",
                      "ops.documents.refreshReport",
                    ].includes(step.toolId) ? (
                    <ReportOperation runId={run.id} step={step} />
                  ) : fileOperation(step.toolId) ? (
                    <FileOperation
                      input={step.input}
                      attach={step.toolId === "ops.documents.attachFile"}
                    />
                  ) : step.toolId.startsWith("ops.sales.") ? (
                    <SalesOperation input={step.input} />
                  ) : (
                    <JsonView value={step.input} />
                  )}
                  {step.approval?.status === "pending" && (
                    <div className="approval-box">
                      <div>
                        <Icon name="shield" size={22} />
                        <h3>Decyzja należy do Ciebie</h3>
                      </div>
                      <p>
                        Sprawdź dane powyżej. Zgoda dotyczy wyłącznie tej wersji
                        planu i pokazanych argumentów.
                      </p>
                      <details className="technical-details">
                        <summary>Identyfikator zakresu zgody</summary>
                        <code>{step.approval.bindingHash}</code>
                      </details>
                      {isApprover ? (
                        <div className="button-group">
                          <button
                            className="button primary"
                            disabled={!!busy}
                            onClick={() =>
                              void action("approve", {
                                approvalId: step.approval!.id,
                                bindingHash: step.approval!.bindingHash,
                                decision: "approved",
                              })
                            }
                          >
                            <Icon name="check" size={17} />
                            Zatwierdź operację
                          </button>
                          <button
                            className="button secondary"
                            disabled={!!busy}
                            onClick={() =>
                              void action("approve", {
                                approvalId: step.approval!.id,
                                bindingHash: step.approval!.bindingHash,
                                decision: "rejected",
                              })
                            }
                          >
                            Odrzuć
                          </button>
                        </div>
                      ) : (
                        <p className="small">
                          Decyzję może podjąć osoba z rolą zatwierdzającego.
                        </p>
                      )}
                    </div>
                  )}
                  {step.verification && (
                    <div className="verification">
                      <div className="section-label">
                        <Icon
                          name={step.verification.ok ? "check" : "alert"}
                          size={16}
                        />
                        Weryfikacja wyniku
                      </div>
                      <p>{step.verification.summary}</p>
                      {step.verification.evidence.map(
                        (evidence, evidenceIndex) => (
                          <details className="evidence" key={evidenceIndex}>
                            <summary>
                              <span>
                                <Icon name="documents" size={17} />
                                {evidence.summary}
                              </span>
                              <Icon name="down" size={15} />
                            </summary>
                            <p className="small muted">
                              Źródło: {evidence.source} ·{" "}
                              {dateLabel(evidence.observedAt, true)}
                            </p>
                            <JsonView value={evidence.data} />
                          </details>
                        ),
                      )}
                    </div>
                  )}
                  {step.status === "succeeded" &&
                    step.toolId === "ops.assets.replaceReservation" && (
                      <ReplacementResult
                        value={step.output?.data.replacement}
                      />
                    )}
                  {step.status === "succeeded" &&
                    typeof step.output?.data.entityId === "string" &&
                    typeof step.output?.data.module === "string" && (
                      <button
                        className="button secondary section-link"
                        onClick={() =>
                          navigate(
                            isHumanTaskOperation(step.toolId)
                              ? "tasks"
                              : `module/${String(step.output!.data.module)}/${String(step.output!.data.entityId)}`,
                          )
                        }
                      >
                        {isHumanTaskOperation(step.toolId)
                          ? "Otwórz zadania"
                          : "Otwórz zapisany rekord"}
                        <Icon name="arrow" size={16} />
                      </button>
                    )}
                  {step.output && (
                    <details className="technical-details">
                      <summary>Zapisany wynik operacji</summary>
                      <JsonView value={step.output.data} />
                    </details>
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
        <aside className="card run-history">
          <div className="card-heading">
            <h2>Historia wykonania</h2>
            <Icon name="clock" size={19} />
          </div>
          <ol className="timeline">
            {run.events.map((event) => (
              <li key={event.id}>
                <span className="timeline-dot" />
                <div>
                  <strong>
                    {eventLabels[event.type] ?? event.type.replaceAll("_", " ")}
                  </strong>
                  <time>{dateLabel(event.createdAt, true)}</time>
                  {typeof event.details.message === "string" && (
                    <p>{String(event.details.message)}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <div className="history-footer">
            Wersja zasad: {run.policyVersion}
            <details className="technical-details">
              <summary>Hash planu</summary>
              <code>{run.planHash}</code>
            </details>
          </div>
        </aside>
      </div>
    </>
  );
}
