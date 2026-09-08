import { useState } from "react";
import { useResource } from "./hooks";
import { dateLabel, type Entity } from "./types";
import { Empty, Loading, Notice } from "./ui";
interface RegisterEvent {
  id: string;
  assetVersion: number;
  toolId: string;
  requestedBy: string;
  approvedBy: string | null;
  recordedAt: string;
  state: {
    status: string;
    location: string | null;
    condition: string | null;
    custodianPrincipalId: string | null;
  } | null;
  attestation: {
    occurredOn: string | null;
    note: string;
    performedBy: string;
  } | null;
}
interface RegisterHistory {
  events: RegisterEvent[];
  total: number;
  limit: number;
  offset: number;
  historyFromVersion: number | null;
  consistent: boolean;
}
const labels: Record<string, string> = {
  create: "Rejestracja urządzenia",
  assignCustodian: "Wyznaczenie opiekuna ewidencji",
  update: "Zmiana danych ewidencji",
  reserve: "Rezerwacja",
  issue: "Poświadczenie wydania",
  issueForTask: "Poświadczenie wydania przez zadanie IT",
  return: "Przyjęcie zwrotu",
  returnForTask: "Przyjęcie zwrotu przez zadanie IT",
  release: "Zwolnienie rezerwacji",
  expireReservation: "Zamknięcie wygasłej rezerwacji",
  move: "Przeniesienie urządzenia",
  sendToService: "Przekazanie do serwisu",
  markRepaired: "Poświadczenie naprawy",
  retire: "Wycofanie z użytkowania",
};
export function AssetRegister({ item }: { item: Entity }) {
  const [offset, setOffset] = useState(0);
  const resource = useResource<{ register: RegisterHistory }>(
    `/api/assets/${encodeURIComponent(item.id)}/register?limit=20&offset=${offset}`,
    item.version,
  );
  const history = resource.data?.register;
  return (
    <section className="card">
      <div className="card-heading">
        <h2>Historia ewidencji urządzenia</h2>
      </div>
      <p>
        Opiekun ewidencji:{" "}
        <strong>
          {typeof item.data.custodianPrincipalId === "string"
            ? item.data.custodianPrincipalId
            : "Nie wyznaczono"}
        </strong>
      </p>
      <p className="muted">
        Rejestr zmian i odpowiedzialności. Poświadczenia fizycznego wydania i
        zwrotu znajdują się w historii przekazań.
      </p>
      {resource.loading ? (
        <Loading />
      ) : resource.error ? (
        <Notice tone="error">{resource.error}</Notice>
      ) : history ? (
        <>
          {!history.consistent && (
            <Notice tone="error">
              Historia nie odpowiada zapisanym wersjom urządzenia. Wymaga
              sprawdzenia przed kolejną operacją.
            </Notice>
          )}
          {history.historyFromVersion === null ? (
            <Empty title="Starsza ewidencja bez nowej historii">
              Dawnych czynności ani autorów nie odtwarzano. Historia zacznie się
              od następnej zatwierdzonej zmiany.
            </Empty>
          ) : (
            <>
              <p className="small muted">
                Historia od wersji {history.historyFromVersion}. Wpisy pokazują
                czas rejestracji czynności.
              </p>
              <ol className="task-history">
                {history.events.map((event) => (
                  <li key={event.id}>
                    <strong>
                      {labels[event.toolId.split(".").at(-1)!] ??
                        "Zmiana urządzenia"}{" "}
                      · wersja {event.assetVersion}
                    </strong>
                    <p>{dateLabel(event.recordedAt, true)}</p>
                    {event.state && (
                      <p className="small">
                        Miejsce po zmianie:{" "}
                        {event.state.location ?? "Nie ustalono"} · Stan:{" "}
                        {event.state.condition === "good"
                          ? "Sprawny"
                          : event.state.condition === "repair"
                            ? "Wymaga naprawy"
                            : "Nie ustalono"}
                      </p>
                    )}
                    {event.attestation && (
                      <p className="small">
                        Dzień czynności:{" "}
                        {event.attestation.occurredOn
                          ? dateLabel(event.attestation.occurredOn)
                          : "Nie zapisano"}
                        . {event.attestation.note}
                      </p>
                    )}
                    <p className="small muted">
                      Zarejestrował: {event.requestedBy} · Zgodę na zapis wydał:{" "}
                      {event.approvedBy ?? "Brak zapisanej tożsamości"}
                    </p>
                  </li>
                ))}
              </ol>
            </>
          )}
          {history.total > 20 && (
            <div className="button-group">
              <button
                className="button secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Nowsze wpisy
              </button>
              <span>
                {offset + 1}–{Math.min(offset + 20, history.total)} z{" "}
                {history.total}
              </span>
              <button
                className="button secondary"
                disabled={offset + 20 >= history.total}
                onClick={() => setOffset(offset + 20)}
              >
                Starsze wpisy
              </button>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
