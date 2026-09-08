import { useCallback, useState, type FormEvent } from "react";
import type { WorkspaceStore } from "../../src/workspace";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Icon, Notice, Sheet } from "./ui";

export type LaboratoryView = ReturnType<WorkspaceStore["laboratoryOverview"]>;
export function certificateErrorLabel(code: unknown) {
  const labels: Record<string, string> = {
    CERT_HAS_EXPIRED: "Certyfikat wygasł",
    CERT_NOT_YET_VALID: "Certyfikat jeszcze nie obowiązuje",
    ERR_TLS_CERT_ALTNAME_INVALID: "Nazwa usługi nie odpowiada certyfikatowi",
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Wystawca certyfikatu nie jest zaufany",
    SELF_SIGNED_CERT_IN_CHAIN: "Łańcuch certyfikatu nie jest zaufany",
    DEPTH_ZERO_SELF_SIGNED_CERT: "Certyfikat nie ma zaufanego wystawcy",
    TLS_UNAVAILABLE: "Nie udało się sprawdzić połączenia TLS",
    LAB_TLS_KEY_UNAVAILABLE:
      "Brak prywatnego klucza tej instalacji laboratorium",
    RESULT_MISMATCH: "Odpowiedź usługi nie potwierdza oczekiwanego certyfikatu",
  };
  return labels[String(code)] ?? "Wymagana ponowna weryfikacja certyfikatu";
}
export function LaboratoryStatus({
  laboratory,
}: {
  laboratory: LaboratoryView;
}) {
  const observed = laboratory.observed;
  const tls = laboratory.protocol === "HTTPS";
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
                : tls
                  ? "Wykryty problem z certyfikatem lub usługą"
                  : "Wykryta niedostępność usługi"}
      </p>
      {observed && (
        <p className="small muted">
          {tls && observed.tls?.errorCode
            ? certificateErrorLabel(observed.tls.errorCode)
            : observed.httpStatus === null
              ? "Brak poprawnej odpowiedzi HTTP"
              : `HTTP ${observed.httpStatus}`}{" "}
          · wersja {observed.version} · {dateLabel(observed.observedAt, true)}
        </p>
      )}
      {observed?.tls && (
        <details>
          <summary>Dane certyfikatu i połączenia</summary>
          <p>
            {observed.tls.authorized
              ? "Nazwa, daty i łańcuch zweryfikowane przez TLS."
              : "Połączenie nie potwierdza zaufanego certyfikatu."}
          </p>
          <p className="small muted">Nazwa: {observed.tls.serverName}</p>
          <p className="small muted">
            Certyfikat skonfigurowany:{" "}
            {dateLabel(observed.tls.configuredCertificate.validFrom, true)} —{" "}
            {dateLabel(observed.tls.configuredCertificate.validTo, true)}
          </p>
          <p className="small muted">
            Odcisk skonfigurowanego certyfikatu:{" "}
            <code>{observed.tls.configuredCertificate.fingerprint}</code>
          </p>
          {observed.tls.peerFingerprint ? (
            <p className="small muted">
              Odcisk potwierdzony w połączeniu:{" "}
              <code>{observed.tls.peerFingerprint}</code>
            </p>
          ) : (
            <p className="small muted">
              Odcisk serwera nie został potwierdzony w zaufanym połączeniu.
            </p>
          )}
        </details>
      )}
      <p className="small muted">
        Źródło: własne laboratorium JARVIS · aktualność do{" "}
        {laboratory.freshnessSeconds / 60} min.
      </p>
    </div>
  );
}
export function LaboratoryPanel({ context }: { context: Context }) {
  return (
    <>
      {(["jarvis-local-service", "jarvis-local-tls"] as const).map((target) => (
        <LaboratoryTargetPanel key={target} target={target} context={context} />
      ))}
    </>
  );
}
function LaboratoryTargetPanel({
  context,
  target,
}: {
  context: Context;
  target: "jarvis-local-service" | "jarvis-local-tls";
}) {
  const tls = target === "jarvis-local-tls";
  const [failure, setFailure] = useState("expired");
  const resource = useResource<{ laboratory: LaboratoryView }>(
    "/api/laboratory?target=" + target,
    0,
    5000,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [creating, setCreating] = useState(false),
    [diagnosis, setDiagnosis] = useState("");
  const [dueDate, setDueDate] = useState("");
  const closeCase = useCallback(() => setCreating(false), []);
  const allowed = (id: string) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((tool) => tool.id === id);
  const laboratory = resource.data?.laboratory,
    observed = laboratory?.observed;
  const inspectTool = laboratory?.inspectTool ?? "";
  const failureTool = laboratory?.failureTool ?? "";
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
      title: tls
        ? "Odnowienie certyfikatu laboratorium"
        : "Przywrócenie usługi laboratorium",
      data: {
        caseType: "it",
        brief: diagnosis,
        dueDate,
        acceptanceCriteria: tls
          ? "Nazwa, daty i łańcuch certyfikatu oraz HTTP 200 potwierdzone niezależnym testem po zatwierdzonym odnowieniu; osobny odbiór właściciela."
          : "HTTP 200 dla własnej usługi po zatwierdzonej naprawie; aktualny niezależny test i odbiór właściciela.",
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
        <h2>
          {tls
            ? "Odnowienie certyfikatu HTTPS"
            : "Od awarii do odebranej naprawy"}
        </h2>
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
        {allowed(inspectTool) && (
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void command(inspectTool, {})}
          >
            <Icon name="pulse" size={17} />
            {tls ? "Sprawdź certyfikat i HTTPS" : "Sprawdź usługę"}
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
        {tls && allowed(failureTool) && (
          <label className="field">
            <span>Przypadek testowy</span>
            <select
              value={failure}
              onChange={(e) => setFailure(e.target.value)}
            >
              <option value="expired">Certyfikat wygasł</option>
              <option value="wrong_name">Niewłaściwa nazwa</option>
              <option value="untrusted">Nieufny wystawca</option>
            </select>
          </label>
        )}
        {allowed(failureTool) && (
          <button
            className="text-button"
            disabled={busy || !observed?.current || !observed.verified}
            onClick={() =>
              void command(failureTool, {
                expectedVersion: observed?.version,
                ...(tls
                  ? {
                      failure,
                      expectedFingerprint:
                        observed?.tls?.configuredCertificate.fingerprint,
                    }
                  : {}),
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
          onClose={closeCase}
        >
          <form className="command-form" onSubmit={createCase}>
            <div className="sheet-body">
              {error && <Notice tone="error">{error}</Notice>}
              <LaboratoryStatus laboratory={laboratory} />
              <p>
                Właściciel odbioru: {context.principal.id}. Procedura przywróci
                {tls
                  ? " certyfikat własnej usługi. Test sprawdzi nazwę, daty, zaufany łańcuch i odpowiedź HTTPS."
                  : " odpowiedź HTTP własnej usługi i wykona osobny test."}
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
