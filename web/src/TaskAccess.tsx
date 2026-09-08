import { useState, type FormEvent } from "react";
import type {
  AccessTaskAction,
  TaskAccessProjection,
} from "../../src/task-access";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Run } from "./types";
import { Loading, Notice, Sheet } from "./ui";

const labels: Record<AccessTaskAction, string> = {
  attestAccessForTask: "Poświadcz sprawdzenie dostępu",
  renewAccessForTask: "Sprawdź ponownie i odnów",
  revokeAccessForTask: "Poświadcz cofnięcie dostępu",
  bindAccessForTask: "Powiąż dowód zestawu",
};
export function TaskAccess({
  taskId,
  title,
  onClose,
}: {
  taskId: string;
  title: string;
  onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<{ access: TaskAccessProjection }>(
    "/api/tasks/" + encodeURIComponent(taskId) + "/access",
    revision,
  );
  const [selection, setSelection] = useState<{
    requirementId: string;
    memberKey?: string;
    action: AccessTaskAction;
  } | null>(null);
  const [accountRef, setAccountRef] = useState("");
  const [observedOn, setObservedOn] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [licenseSeatId, setLicenseSeatId] = useState("");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState(requestKey);
  const access = resource.data?.access;
  const requirement = access?.requirements.find(
    (r) => r.id === selection?.requirementId,
  );
  const member = requirement?.members.find(
    (m) => m.key === selection?.memberKey,
  );
  const binding = selection?.action === "bindAccessForTask";
  const revoking = selection?.action === "revokeAccessForTask";
  const pins = selection
    ? binding
      ? requirement?.bindInput
      : member?.commandBindings[selection.action]
    : undefined;
  const valid =
    !resource.loading && !resource.error && access?.task.id === taskId;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !selection || !pins || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const input = {
        ...pins,
        humanConfirmed: true,
        ...(binding
          ? {}
          : revoking
            ? {
                revokedOn: observedOn,
                verificationMethod: method.trim(),
                note: note.trim(),
              }
            : {
                accountRef: accountRef.trim(),
                observedOn,
                validUntil,
                verificationMethod: method.trim(),
                note: note.trim(),
                ...(member?.licenseRequired ? { licenseSeatId } : {}),
              }),
      };
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: "ops.cases." + selection.action,
        input,
        idempotencyKey: key,
      });
      onClose();
      navigate("runs/" + run.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="Dostępy w zadaniu IT" subtitle={title} onClose={onClose}>
      <div className="sheet-body equipment-sheet">
        <button
          className="button ghost"
          disabled={busy || resource.loading}
          onClick={() => {
            setRevision((v) => v + 1);
            setSelection(null);
            setConfirmed(false);
            setKey(requestKey());
            setError("");
          }}
        >
          Odśwież zakres zadania
        </button>
        {resource.loading ? (
          <Loading />
        ) : resource.error ? (
          <Notice tone="error">{resource.error}</Notice>
        ) : valid && access ? (
          <>
            <dl className="equipment-context">
              <div>
                <dt>Odbiorca</dt>
                <dd>{access.recipientLabel}</dd>
              </div>
              <div>
                <dt>Współpraca</dt>
                <dd>{access.engagementLabel}</dd>
              </div>
            </dl>
            {access.task.status !== "accepted" ? (
              <Notice>
                Przyjmij zadanie, aby zobaczyć wymagane aplikacje i poświadczyć
                sprawdzenie dostępów.
              </Notice>
            ) : (
              <>
                {!access.dependenciesReady && (
                  <Notice>
                    Najpierw ukończ zadania poprzedzające. Zakres dostępów jest
                    widoczny, a zapis pozostaje zablokowany.
                  </Notice>
                )}
                {!selection &&
                  access.requirements.map((r) => (
                    <section key={r.id} className="equipment-allocation">
                      <h3>{r.title}</h3>
                      <p>{r.bundleTitle ?? "Zestaw do ustalenia"}</p>
                      {r.problem && <Notice tone="error">{r.problem}</Notice>}
                      {r.bound && (
                        <Notice tone={r.bindingCurrent ? "success" : "error"}>
                          {r.bindingCurrent
                            ? "Dowód powiązany z rewizją. Potwierdzenie wykonania zadania pozostaje osobną decyzją."
                            : "Zapisane powiązanie wymaga ponownego sprawdzenia. Właściciel sprawy musi przygotować nową rewizję przed powiązaniem zmienionego dowodu."}
                        </Notice>
                      )}
                      {r.members.map((m) => (
                        <article key={m.key} className="equipment-allocation">
                          <h4>
                            {m.applicationLabel} · {m.role}
                          </h4>
                          <p>
                            {m.current
                              ? "Aktualne poświadczenie do " +
                                dateLabel(m.grant?.validUntil)
                              : "Brak aktualnego poświadczenia"}
                          </p>
                          {m.grant && (
                            <p className="small">
                              Konto: {m.grant.accountRef} · Poświadczył:{" "}
                              {m.grant.performedBy} · Zgodę wydał:{" "}
                              {m.grant.approvedBy ?? "Nie ustalono"}
                            </p>
                          )}
                          {m.licenseRequired && (
                            <p className="small">
                              {m.licenseSeats.length
                                ? "Wymagany przydział licencji tej współpracy."
                                : "Brak przydziału licencji. Zgłoś to właścicielowi sprawy."}
                            </p>
                          )}
                          <div className="task-actions">
                            {Object.keys(m.commandBindings).map((a) => {
                              const action = a as AccessTaskAction;
                              return (
                                <button
                                  key={a}
                                  className="button secondary"
                                  onClick={() => {
                                    setSelection({
                                      requirementId: r.id,
                                      memberKey: m.key,
                                      action,
                                    });
                                    setAccountRef(m.grant?.accountRef ?? "");
                                    setObservedOn("");
                                    setValidUntil("");
                                    setLicenseSeatId("");
                                    setMethod("");
                                    setNote("");
                                    setConfirmed(false);
                                    setError("");
                                    setKey(requestKey());
                                  }}
                                >
                                  {labels[action]}
                                </button>
                              );
                            })}
                          </div>
                          {!!m.history.length && (
                            <details className="task-history">
                              <summary>
                                Historia sprawdzeń ({m.history.length})
                              </summary>
                              <ol>
                                {m.history.map((e, i) => (
                                  <li key={i}>
                                    <strong>
                                      {e.kind === "revoke"
                                        ? "Poświadczenie cofnięcia"
                                        : e.kind === "renew"
                                          ? "Ponowne sprawdzenie"
                                          : "Poświadczenie dostępu"}
                                    </strong>
                                    <time>{dateLabel(e.recordedAt, true)}</time>
                                    <span>
                                      Data sprawdzenia:{" "}
                                      {dateLabel(e.revokedOn ?? e.observedOn)} ·
                                      Wykonał: {e.performedBy} · Zgoda:{" "}
                                      {e.approvedBy ?? "Nie ustalono"}
                                    </span>
                                  </li>
                                ))}
                              </ol>
                              <small>
                                Ostatnie 50 wpisów dotyczących tej aplikacji,
                                roli i współpracy.
                              </small>
                            </details>
                          )}
                        </article>
                      ))}
                      {r.bindInput && (
                        <button
                          className="button primary"
                          onClick={() => {
                            setSelection({
                              requirementId: r.id,
                              action: "bindAccessForTask",
                            });
                            setConfirmed(false);
                            setError("");
                            setKey(requestKey());
                          }}
                        >
                          Powiąż dowód zestawu
                        </button>
                      )}
                    </section>
                  ))}
                {selection && requirement && pins && (
                  <form onSubmit={submit} className="equipment-attestation">
                    <h3>{labels[selection.action]}</h3>
                    <p>
                      {binding
                        ? requirement.bundleTitle
                        : member?.applicationLabel + " · " + member?.role}
                    </p>
                    {error && (
                      <Notice tone="error">
                        {error} Wpisany opis został zachowany. Po zmianie obsady
                        lub zakresu odśwież zadanie i przygotuj nowy plan.
                      </Notice>
                    )}
                    {!binding && (
                      <>
                        {!revoking && (
                          <label className="field">
                            <span>
                              Identyfikator konta — bez hasła i klucza
                            </span>
                            <input
                              required
                              maxLength={200}
                              disabled={
                                busy ||
                                selection.action === "renewAccessForTask"
                              }
                              value={accountRef}
                              onChange={(e) => setAccountRef(e.target.value)}
                            />
                          </label>
                        )}
                        <div className="form-grid">
                          <label className="field">
                            <span>
                              {revoking
                                ? "Data sprawdzenia cofnięcia"
                                : "Data sprawdzenia dostępu"}
                            </span>
                            <input
                              type="date"
                              required
                              disabled={busy}
                              value={observedOn}
                              onChange={(e) => setObservedOn(e.target.value)}
                            />
                          </label>
                          {!revoking && (
                            <label className="field">
                              <span>Poświadczenie aktualne do</span>
                              <input
                                type="date"
                                required
                                disabled={busy}
                                value={validUntil}
                                onChange={(e) => setValidUntil(e.target.value)}
                              />
                              <small>
                                Zestaw dopuszcza maksymalnie{" "}
                                {member?.validityDays} dni, licząc dzień
                                sprawdzenia.
                              </small>
                            </label>
                          )}
                        </div>
                        {!revoking && member?.licenseRequired && (
                          <label className="field">
                            <span>Przydział licencji tej współpracy</span>
                            <select
                              required
                              disabled={busy}
                              value={licenseSeatId}
                              onChange={(e) => setLicenseSeatId(e.target.value)}
                            >
                              <option value="">Wybierz przydział…</option>
                              {member.licenseSeats.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.label} · {s.id.slice(0, 8)}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label className="field">
                          <span>Jak sprawdzono konto i rolę</span>
                          <textarea
                            required
                            rows={3}
                            maxLength={2000}
                            disabled={busy}
                            value={method}
                            onChange={(e) => setMethod(e.target.value)}
                          />
                        </label>
                        <label className="field">
                          <span>Wynik sprawdzenia i uwagi</span>
                          <textarea
                            required
                            rows={3}
                            maxLength={4000}
                            disabled={busy}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                          />
                        </label>
                      </>
                    )}
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        required
                        disabled={busy}
                        checked={confirmed}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      {binding
                        ? "Potwierdzam powiązanie aktualnych poświadczeń całego zestawu z wymaganiem tego zadania."
                        : "Poświadczam opisane sprawdzenie dla wskazanej osoby i współpracy."}
                    </label>
                    <Notice>
                      Zgoda dotyczy zapisu w JARVIS. Nadanie lub cofnięcie roli
                      odbywa się w odpowiedniej aplikacji. Ta operacja nie
                      zamyka zadania ani odbioru sprawy.
                    </Notice>
                    <div className="task-actions">
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => {
                          setSelection(null);
                          setConfirmed(false);
                        }}
                      >
                        Wróć do dostępów
                      </button>
                      <button
                        type="submit"
                        className="button primary"
                        disabled={
                          busy ||
                          !valid ||
                          !confirmed ||
                          (!binding &&
                            (!observedOn ||
                              !method.trim() ||
                              !note.trim() ||
                              (!revoking &&
                                (!accountRef.trim() ||
                                  !validUntil ||
                                  (member?.licenseRequired &&
                                    !licenseSeatId)))))
                        }
                      >
                        {busy ? "Przygotowywanie…" : "Przygotuj operację"}
                      </button>
                    </div>
                  </form>
                )}
              </>
            )}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
