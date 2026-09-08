import { useState, type FormEvent } from "react";
import type { AccessGrant, AccessEvent } from "../../src/access-models";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Entity, type Run } from "./types";
import { Loading, Notice, Sheet } from "./ui";
interface Member {
  key: string;
  applicationId: string;
  applicationVersion: number;
  role: string;
  validityDays: number;
  licenseId: string | null;
  current: boolean;
  grantId: string | null;
  expiresAt: string | null;
}
interface Requirement {
  id: string;
  title: string;
  bound: boolean;
  problem: string | null;
  assessment: null | {
    title: string;
    version: number;
    hash: string;
    identity: { bundleId: string; current: boolean; members: Member[] };
  };
}
type Grant = AccessGrant & { events: AccessEvent[] };
type Selection = {
  requirement?: Requirement;
  member?: Member;
  grant?: Grant;
  action: "attestAccess" | "renewAccess" | "revokeAccess";
};
export function CaseAccess({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const [selection, setSelection] = useState<Selection | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const resource = useResource<{
    access: { requirements: Requirement[]; grants: Grant[] };
  }>(
    `/api/cases/${encodeURIComponent(item.id)}/access`,
    revision + item.version,
  );
  const apps = useResource<{ items: Entity[] }>("/api/workspace/it", revision);
  const allowed = context.principal.roles.includes("operator");
  const open = ["open", "needs_changes"].includes(item.status);
  const label = (id: string) =>
    apps.data?.items.find((a) => a.id === id)?.title ?? id;
  async function bind(r: Requirement) {
    if (!r.assessment) return;
    setBusy(true);
    setError("");
    try {
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: "ops.cases.bindEvidence",
        input: {
          id: item.id,
          expectedVersion: item.version,
          requirementId: r.id,
          sourceModule: "it",
          sourceId: r.assessment.identity.bundleId,
          sourceVersion: r.assessment.version,
          accessProofHash: r.assessment.hash,
        },
        idempotencyKey: requestKey(),
      });
      navigate(`runs/${run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  if (resource.loading) return <Loading />;
  if (resource.error)
    return (
      <Notice tone="error">
        Nie można odczytać rejestru dostępów: {resource.error}
      </Notice>
    );
  const data = resource.data?.access;
  if (!data || (!data.requirements.length && !data.grants.length)) return null;
  return (
    <section className="card" aria-label="Poświadczenia dostępów">
      {selection && (
        <WitnessForm
          item={item}
          selection={selection}
          context={context}
          label={label}
          onClose={() => setSelection(null)}
        />
      )}
      <div className="card-heading">
        <h2>Aplikacje i poświadczone dostępy</h2>
      </div>
      <p className="muted">
        Poświadczenia dotyczą osoby i okresu współpracy tej sprawy. Zapis
        potwierdza sprawdzenie przez człowieka; nadanie uprawnień odbywa się w
        danej aplikacji.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {data.requirements.map((r) => (
        <article className="requirement-editor-row" key={r.id}>
          <h3>{r.title}</h3>
          {r.problem ? (
            <Notice>
              {r.problem} Zdefiniuj zestaw w module IT, a następnie wybierz go w
              nowej rewizji sprawy.
            </Notice>
          ) : (
            r.assessment && (
              <>
                <p>
                  Zestaw: <strong>{r.assessment.title}</strong> · wersja{" "}
                  {r.assessment.version}
                </p>
                <ul className="task-history">
                  {r.assessment.identity.members.map((m) => {
                    const grant = data.grants.find((g) => g.id === m.grantId);
                    return (
                      <li key={m.key}>
                        <strong>
                          {label(m.applicationId)} · {m.role}
                        </strong>
                        <p>
                          {m.current
                            ? `Aktualne poświadczenie do ${dateLabel(grant?.validUntil ?? "")}`
                            : "Brak aktualnego poświadczenia"}
                          {m.licenseId ? " · wymagany przydział licencji" : ""}
                        </p>
                        {allowed && open && (
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() =>
                              setSelection({
                                requirement: r,
                                member: m,
                                grant,
                                action: grant ? "renewAccess" : "attestAccess",
                              })
                            }
                          >
                            {grant
                              ? "Sprawdź ponownie i odnów"
                              : "Poświadcz sprawdzenie dostępu"}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {allowed && open && (
                  <button
                    className="button primary"
                    disabled={busy || !r.assessment.identity.current || r.bound}
                    onClick={() => void bind(r)}
                  >
                    {r.bound
                      ? "Dowód zestawu powiązany z rewizją"
                      : "Przygotuj powiązanie dowodu zestawu"}
                  </button>
                )}
              </>
            )
          )}
        </article>
      ))}
      {!!data.grants.length && (
        <details>
          <summary>Historia poświadczeń ({data.grants.length})</summary>
          {data.grants.map((g) => (
            <article className="requirement-editor-row" key={g.id}>
              <h3>
                {label(g.applicationId)} · {g.role}
              </h3>
              <p>
                Konto: {g.accountRef} ·{" "}
                {g.status === "active"
                  ? "Dostęp poświadczony"
                  : "Cofnięcie poświadczone"}
              </p>
              <ol className="task-history">
                {g.events.map((e) => (
                  <li key={e.id}>
                    <strong>
                      {e.kind === "attest"
                        ? "Pierwsze poświadczenie"
                        : e.kind === "renew"
                          ? "Ponowne sprawdzenie"
                          : "Cofnięcie dostępu"}{" "}
                      · wersja {e.grantVersion}
                    </strong>
                    <p>
                      Sprawdzono{" "}
                      {dateLabel(
                        e.kind === "revoke"
                          ? e.snapshot.revokedOn!
                          : e.snapshot.observedOn,
                      )}
                      . {e.snapshot.verificationMethod}
                    </p>
                    <p>{e.snapshot.note}</p>
                    <p className="small muted">
                      Wykonał: {e.performedBy} · zgodę na zapis wydał:{" "}
                      {e.approvedBy ?? "Brak danych"} · zarejestrowano{" "}
                      {dateLabel(e.recordedAt, true)}
                    </p>
                  </li>
                ))}
              </ol>
              {allowed && g.status === "active" && (
                <button
                  className="button secondary"
                  onClick={() =>
                    setSelection({ grant: g, action: "revokeAccess" })
                  }
                >
                  Poświadcz cofnięcie tego dostępu
                </button>
              )}
            </article>
          ))}
        </details>
      )}
    </section>
  );
}
function WitnessForm({
  item,
  selection,
  context,
  label,
  onClose,
}: {
  item: Entity;
  selection: Selection;
  context: Context;
  label: (id: string) => string;
  onClose: () => void;
}) {
  const { member, requirement, grant, action } = selection;
  const revoke = action === "revokeAccess";
  const [accountRef, setAccount] = useState(grant?.accountRef ?? ""),
    [observedOn, setDate] = useState(""),
    [validUntil, setUntil] = useState(""),
    [method, setMethod] = useState(""),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [seatId, setSeat] = useState(grant?.licenseSeatId ?? "");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [key] = useState(requestKey);
  const canLicense = context.principal.scopes?.some(
    (s) => s === "*" || s === "licenses",
  );
  const license = useResource<{ item: Entity }>(
    member?.licenseId && canLicense
      ? `/api/workspace/licenses/${encodeURIComponent(member.licenseId)}`
      : null,
  );
  const seats = (
    (license.data?.item.data.assignments ?? []) as {
      id: string;
      status: string;
      personId: string;
      employmentEpisodeId: string;
    }[]
  ).filter(
    (s) =>
      s.status === "assigned" &&
      s.personId === item.data.personId &&
      s.employmentEpisodeId === item.data.employmentEpisodeId,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const fields = revoke
        ? {
            grantId: grant!.id,
            expectedGrantVersion: grant!.version,
            revokedOn: observedOn,
          }
        : {
            requirementId: requirement!.id,
            memberKey: member!.key,
            accountRef,
            observedOn,
            validUntil,
            ...(member!.licenseId ? { licenseSeatId: seatId } : {}),
            ...(grant
              ? { grantId: grant.id, expectedGrantVersion: grant.version }
              : {}),
          };
      const { run } = await post<{ run: Run }>("/api/commands", {
        toolId: `ops.cases.${action}`,
        input: {
          id: item.id,
          expectedVersion: item.version,
          ...fields,
          verificationMethod: method,
          note,
          humanConfirmed: confirmed,
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
      title={
        revoke
          ? "Poświadcz cofnięcie dostępu"
          : grant
            ? "Odnów poświadczenie dostępu"
            : "Poświadcz dostęp"
      }
      subtitle={label(member?.applicationId ?? grant!.applicationId)}
      onClose={onClose}
    >
      <form className="command-form" onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <p>
            Sprawa: <strong>{item.title}</strong>. Wymagana rola:{" "}
            <strong>{member?.role ?? grant?.role}</strong>.
          </p>
          <fieldset className="access-fieldset" disabled={busy}>
            <label className="field">
              <span>Identyfikator konta — bez hasła i klucza</span>
              <input
                required
                maxLength={200}
                readOnly={!!grant}
                value={accountRef}
                onChange={(e) => setAccount(e.target.value)}
              />
            </label>
            <label className="field">
              <span>
                {revoke
                  ? "Data sprawdzenia cofnięcia"
                  : "Data sprawdzenia dostępu"}
              </span>
              <input
                required
                type="date"
                value={observedOn}
                onChange={(e) => setDate(e.target.value)}
              />
            </label>
            {!revoke && (
              <label className="field">
                <span>Poświadczenie aktualne do</span>
                <input
                  required
                  type="date"
                  value={validUntil}
                  onChange={(e) => setUntil(e.target.value)}
                />
                <small>
                  Zestaw dopuszcza maksymalnie {member?.validityDays} dni,
                  licząc dzień sprawdzenia.
                </small>
              </label>
            )}
            {member?.licenseId && (
              <label className="field">
                <span>Przydział licencji tej współpracy</span>
                <select
                  required
                  value={seatId}
                  onChange={(e) => setSeat(e.target.value)}
                >
                  <option value="">Wybierz przydział…</option>
                  {seats.map((s) => (
                    <option key={s.id} value={s.id}>
                      {license.data?.item.title} · {s.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
                {(!canLicense || !seats.length) && (
                  <Notice>
                    Brak dostępnego przydziału tej licencji dla osoby i
                    współpracy. Potwierdzenie wymaga właściwego przydziału i
                    uprawnień do licencji.
                  </Notice>
                )}
                {license.error && <Notice tone="error">{license.error}</Notice>}
              </label>
            )}
            <label className="field">
              <span>Jak sprawdzono konto i rolę</span>
              <textarea
                required
                maxLength={2000}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Wynik sprawdzenia i uwagi</span>
              <textarea
                required
                maxLength={4000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <label className="checkbox-field">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Potwierdzam wykonanie opisanego sprawdzenia dla tej osoby i
              współpracy.
            </label>
          </fieldset>
          <Notice>
            Przygotujesz plan zapisu poświadczenia. Zgoda na zapis, powiązanie
            dowodu i odbiór sprawy są osobnymi decyzjami.
          </Notice>
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
              !confirmed ||
              Boolean(
                member?.licenseId &&
                (!canLicense || !seats.some((s) => s.id === seatId)),
              )
            }
          >
            Przygotuj poświadczenie
          </button>
        </div>
      </form>
    </Sheet>
  );
}
