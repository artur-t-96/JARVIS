import { useState } from "react";
import { useResource, navigate } from "./hooks";
import { dateLabel, type Entity } from "./types";
import { Empty, Loading, Notice } from "./ui";

export interface CustodyAllocation {
  id: string;
  version: number;
  status: string;
  personId: string;
  employmentEpisodeId: string | null;
  caseId: string | null;
  recipientLabel?: string;
  engagementLabel?: string;
  reservedUntil: string;
  expiresAt: string | null;
  expired?: boolean;
  timezone: string | null;
  issuedOn: string | null;
  returnedOn: string | null;
  provenance: "legacy" | "p05";
  issueEventId: string | null;
}
interface CustodyEvent {
  id: string;
  kind: string;
  occurredOn: string;
  recordedAt: string;
  performedBy: string | null;
  approvedBy: string | null;
  requestedBy: string;
  runId: string;
  snapshot: { note: string; asset: { location?: string; condition?: string } };
}
export const allocationActions = [
  "issue",
  "return",
  "release",
  "expireReservation",
  "replaceReservation",
];
export function allocationExpired(
  allocation: CustodyAllocation,
  now = Date.now(),
) {
  return (
    allocation.status === "reserved" &&
    (allocation.expired === true ||
      (allocation.expiresAt !== null &&
        Number.isFinite(Date.parse(allocation.expiresAt)) &&
        Date.parse(allocation.expiresAt) <= now))
  );
}
export function allocationChoices(
  allocations: CustodyAllocation[],
  action: string,
  now = Date.now(),
) {
  return allocations.filter(
    (allocation) =>
      Number.isInteger(allocation.version) &&
      allocation.version > 0 &&
      (action !== "replaceReservation" ||
        (allocation.provenance === "p05" &&
          !!allocation.employmentEpisodeId &&
          !!allocation.caseId &&
          !!allocation.timezone &&
          !!allocation.expiresAt &&
          !allocationExpired(allocation, now))) &&
      (action === "return"
        ? allocation.status === "issued"
        : allocation.status === "reserved" &&
          (action === "expireReservation"
            ? allocationExpired(allocation, now)
            : action === "issue"
              ? !allocationExpired(allocation, now)
              : true)),
  );
}
export function allocationSelection(
  allocations: CustodyAllocation[],
  action: string,
  selectedId: unknown,
) {
  const selected = allocationChoices(allocations, action).find(
    (allocation) => allocation.id === selectedId,
  );
  if (!selected)
    throw new Error("Wybierz aktualny przydział odpowiedni dla tej operacji.");
  if (action === "issue" && (!selected.employmentEpisodeId || !selected.caseId))
    throw new Error(
      "Historyczny przydział nie ma rozstrzygniętej współpracy lub sprawy. Nie można go wydać tym formularzem.",
    );
  return {
    allocationId: selected.id,
    expectedAllocationVersion: selected.version,
  };
}
export function custodyAllocationLabel(allocation: CustodyAllocation) {
  return `${allocation.recipientLabel ?? "Odbiorca (nazwa niedostępna)"} · ${allocation.engagementLabel ?? "Współpraca (nazwa niedostępna)"} · ${allocation.status === "issued" ? "wydano " + dateLabel(allocation.issuedOn ?? undefined) : "rezerwacja do " + dateLabel(allocation.reservedUntil)}`;
}
export function AllocationSelect({
  allocations,
  action,
  selectedId,
  disabled,
  onSelect,
}: {
  allocations: CustodyAllocation[];
  action: string;
  selectedId: string;
  disabled: boolean;
  onSelect: (allocation: CustodyAllocation | undefined) => void;
}) {
  const choices = allocationChoices(allocations, action);
  return (
    <label className="field wide">
      <span>
        Konkretny przydział urządzenia <span className="required">*</span>
      </span>
      <select
        required
        disabled={disabled}
        value={
          choices.some((entry) => entry.id === selectedId) ? selectedId : ""
        }
        onChange={(event) =>
          onSelect(choices.find((entry) => entry.id === event.target.value))
        }
      >
        <option value="">
          {choices.length
            ? "Wybierz przydział…"
            : "Brak przydziału dla tej operacji"}
        </option>
        {choices.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {custodyAllocationLabel(entry)}
          </option>
        ))}
      </select>
      <small>
        Operacja dotyczy wskazanego przydziału. Wersja i powiązanie ze
        współpracą pochodzą z ewidencji.
      </small>
    </label>
  );
}
export function AssetCustody({
  item,
  onAction,
  allowedTool,
}: {
  item: Entity;
  onAction: (action: string, values?: Record<string, unknown>) => void;
  allowedTool: (action: string) => boolean;
}) {
  const [offset, setOffset] = useState(0);
  const resource = useResource<{
    custody: {
      assetId: string;
      allocations: CustodyAllocation[];
      events: CustodyEvent[];
      totalEvents: number;
      limit: number;
      offset: number;
    };
  }>(
    `/api/assets/${encodeURIComponent(item.id)}/custody?limit=20&offset=${offset}`,
    item.version,
  );
  const custody = resource.data?.custody;
  const labels: Record<string, string> = {
    reserve: "Rezerwacja",
    issue: "Poświadczone wydanie",
    return: "Poświadczony zwrot",
    release: "Zwolnienie rezerwacji",
    expire: "Zwolnienie po terminie",
  };
  return (
    <section className="card">
      <div className="card-heading">
        <h2>Przydziały i przekazania</h2>
      </div>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <Notice tone="error">{resource.error}</Notice>
      ) : custody && custody.assetId === item.id ? (
        <>
          {custody.allocations.length ? (
            [...custody.allocations].reverse().map((entry) => (
              <article className="equipment-allocation" key={entry.id}>
                <h3>
                  {entry.recipientLabel ?? "Odbiorca (nazwa niedostępna)"}
                </h3>
                <p>
                  {entry.engagementLabel ?? "Współpraca (nazwa niedostępna)"}
                </p>
                <p>
                  <strong>
                    {entry.status === "reserved"
                      ? allocationExpired(entry)
                        ? "Rezerwacja wygasła — nadal zajmuje urządzenie"
                        : "Zarezerwowany"
                      : entry.status === "issued"
                        ? "Wydany"
                        : entry.status === "returned"
                          ? "Zwrócony"
                          : "Rezerwacja zwolniona"}
                  </strong>
                </p>
                <dl className="human-task-meta">
                  <div>
                    <dt>Rezerwacja do</dt>
                    <dd>
                      {dateLabel(entry.reservedUntil)}
                      {entry.timezone && <small>{entry.timezone}</small>}
                    </dd>
                  </div>
                  {entry.expiresAt && (
                    <div>
                      <dt>Dokładny koniec</dt>
                      <dd>{dateLabel(entry.expiresAt, true)}</dd>
                    </div>
                  )}
                  {entry.issuedOn && (
                    <div>
                      <dt>Wydano</dt>
                      <dd>{dateLabel(entry.issuedOn)}</dd>
                    </div>
                  )}
                  {entry.returnedOn && (
                    <div>
                      <dt>Zwrócono</dt>
                      <dd>{dateLabel(entry.returnedOn)}</dd>
                    </div>
                  )}
                </dl>
                {entry.provenance === "legacy" && (
                  <Notice>
                    Wpis historyczny. Migracja nie potwierdza autora fizycznego
                    przekazania ani nie uzupełnia brakujących powiązań.
                  </Notice>
                )}
                {allocationExpired(entry) && (
                  <p className="small muted">
                    Upływ terminu nie zwalnia urządzenia automatycznie.
                    Zwolnienie wymaga osobnej operacji.
                  </p>
                )}
                {entry.status === "issued" && (
                  <p className="small muted">
                    {entry.issueEventId
                      ? "Wydanie posiada zapisane zdarzenie. Powiązanie z warunkiem sprawy sprawdź w zadaniu IT."
                      : "Brak zdarzenia poświadczonego wydania; nie jest to aktualny dowód odbioru."}
                  </p>
                )}
                <div className="task-actions">
                  {allocationActions
                    .filter(
                      (action) =>
                        allowedTool(action) &&
                        allocationChoices([entry], action).length > 0,
                    )
                    .map((action) => (
                      <button
                        key={action}
                        className="button secondary"
                        onClick={() =>
                          onAction(action, {
                            allocationId: entry.id,
                            expectedAllocationVersion: entry.version,
                            personId: entry.personId,
                            employmentEpisodeId: entry.employmentEpisodeId,
                            caseId: entry.caseId,
                          })
                        }
                      >
                        {
                          (
                            {
                              issue: "Poświadcz wydanie",
                              return: "Poświadcz zwrot",
                              release: "Zwolnij rezerwację",
                              expireReservation: "Zwolnij po terminie",
                              replaceReservation: "Zamień urządzenie",
                            } as Record<string, string>
                          )[action]
                        }
                      </button>
                    ))}
                </div>
              </article>
            ))
          ) : (
            <Empty icon="assets" title="Brak przydziałów">
              To urządzenie nie ma zapisanej historii przydziałów.
            </Empty>
          )}
          <h3>Historia zdarzeń</h3>
          {custody.events.length ? (
            <ol className="equipment-event-list">
              {custody.events.map((event) => (
                <li key={event.id}>
                  <strong>
                    {labels[event.kind] ?? "Zmiana stanu sprzętu"}
                  </strong>
                  <time>
                    {dateLabel(event.occurredOn)} · zapisano{" "}
                    {dateLabel(event.recordedAt, true)}
                  </time>
                  <p>{event.snapshot.note}</p>
                  <span className="small muted">
                    Zlecono: {event.requestedBy} · Zgoda:{" "}
                    {event.approvedBy ?? "Nie ustalono"}
                    {event.performedBy
                      ? ` · Poświadczono: ${event.performedBy}`
                      : ""}
                  </span>
                  {event.snapshot.asset.location && (
                    <p className="small">
                      Lokalizacja po zdarzeniu: {event.snapshot.asset.location}
                    </p>
                  )}
                  <button
                    className="text-button"
                    onClick={() => navigate(`runs/${event.runId}`)}
                  >
                    Zobacz wykonanie i weryfikację
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted">
              Brak zapisanych zdarzeń. Nie oznacza to potwierdzonego
              przekazania.
            </p>
          )}
          {custody.totalEvents > custody.limit && (
            <div className="task-actions">
              <button
                className="button ghost"
                disabled={offset === 0}
                onClick={() => setOffset((value) => Math.max(0, value - 20))}
              >
                Nowsze zdarzenia
              </button>
              <span className="small">
                {offset + 1}–
                {Math.min(offset + custody.events.length, custody.totalEvents)}{" "}
                z {custody.totalEvents}
              </span>
              <button
                className="button ghost"
                disabled={offset + custody.events.length >= custody.totalEvents}
                onClick={() => setOffset((value) => value + 20)}
              >
                Starsze zdarzenia
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
