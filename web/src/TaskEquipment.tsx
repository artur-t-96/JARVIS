import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Run } from "./types";
import { Empty, Loading, Notice, Sheet } from "./ui";
import {
  equipmentActionLabels,
  equipmentCommand,
  equipmentState,
  type EquipmentAction,
  type EquipmentAllocation,
  type TaskEquipmentProjection,
} from "./equipment";

export function EquipmentAllocationCard({
  allocation,
  onAction,
}: {
  allocation: EquipmentAllocation;
  onAction?: (action: EquipmentAction) => void;
}) {
  return (
    <article className="equipment-allocation">
      <div className="task-heading">
        <h3>{allocation.asset.title}</h3>
        <span className={`task-state ${allocation.status}`}>
          {equipmentState(allocation)}
        </span>
      </div>
      <dl className="human-task-meta">
        <div>
          <dt>Numer seryjny</dt>
          <dd>{allocation.asset.serial ?? "Nie ustalono"}</dd>
        </div>
        <div>
          <dt>Lokalizacja w ewidencji</dt>
          <dd>{allocation.asset.location ?? "Nie ustalono"}</dd>
        </div>
        <div>
          <dt>Stan w ewidencji</dt>
          <dd>
            {allocation.asset.condition === "good"
              ? "Sprawny"
              : allocation.asset.condition === "repair"
                ? "Wymaga naprawy"
                : "Nie ustalono"}
          </dd>
        </div>
        <div>
          <dt>Rezerwacja do</dt>
          <dd>
            {dateLabel(allocation.reservedUntil)}
            {allocation.expiresAt && (
              <small>
                Dokładny koniec: {dateLabel(allocation.expiresAt, true)}
              </small>
            )}
          </dd>
        </div>
      </dl>
      {allocation.expired && allocation.status === "reserved" && (
        <Notice>
          Termin minął. Opiekun sprzętu musi jawnie zwolnić tę rezerwację przed
          kolejnym przydziałem. Odczyt nie zwalnia urządzenia.
        </Notice>
      )}
      {allocation.issueEvent && (
        <div className="human-evidence">
          <span className="eyebrow">ZAPISANE POŚWIADCZENIE WYDANIA</span>
          <p>Przekazano {dateLabel(allocation.issueEvent.occurredOn)}</p>
          <small>
            Poświadczył: {allocation.issueEvent.performedBy ?? "Nie ustalono"} ·
            Zgodę na zapis wydał:{" "}
            {allocation.issueEvent.approvedBy ?? "Nie ustalono"}
          </small>
        </div>
      )}
      {allocation.binding.title && (
        <p className="small">Warunek: {allocation.binding.title}</p>
      )}
      {allocation.status === "issued" &&
        allocation.binding.status === "unbound" && (
          <p className="small muted">
            Wydanie zostało zapisane. Powiązanie dowodu jest osobną operacją i
            nie wydaje sprzętu ponownie.
          </p>
        )}
      {onAction && allocation.allowedActions.length > 0 && (
        <div className="task-actions">
          {allocation.allowedActions.map((action) => (
            <button
              key={action}
              className={`button ${action === "bindAssetForTask" ? "primary" : "secondary"}`}
              disabled={action === "issueForTask" && allocation.expired}
              onClick={() => onAction(action)}
            >
              {equipmentActionLabels[action]}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
export function EquipmentTaskContent({
  equipment,
  onAction,
}: {
  equipment: TaskEquipmentProjection;
  onAction?: (allocation: EquipmentAllocation, action: EquipmentAction) => void;
}) {
  return (
    <>
      <dl className="equipment-context">
        <div>
          <dt>Odbiorca</dt>
          <dd>{equipment.recipientLabel}</dd>
        </div>
        <div>
          <dt>Współpraca</dt>
          <dd>{equipment.engagementLabel}</dd>
        </div>
      </dl>
      <Notice>
        Poświadczenie wydania, powiązanie dowodu i wykonanie zadania są osobnymi
        krokami. Dokumenty i dostęp wymagają odrębnego potwierdzenia przed
        odbiorem całego onboardingu.
      </Notice>
      {equipment.task.status !== "accepted" && (
        <Notice>
          Przyjmij zadanie, zanim rozpoczniesz przekazanie sprzętu.
        </Notice>
      )}
      {equipment.allocations.length ? (
        equipment.allocations.map((allocation) => (
          <EquipmentAllocationCard
            key={allocation.id}
            allocation={allocation}
            onAction={
              onAction && equipment.task.status === "accepted"
                ? (action) => onAction(allocation, action)
                : undefined
            }
          />
        ))
      ) : (
        <Empty icon="assets" title="Brak dostępnego przekazania">
          Nie ma alokacji, którą możesz obsłużyć w tym zadaniu. Właściciel
          sprawy powinien potwierdzić rezerwację dla właściwej współpracy.
        </Empty>
      )}
      {equipment.requirements.length > 0 && (
        <section className="equipment-requirements">
          <h3>Warunki sprzętowe tego zadania</h3>
          {equipment.requirements.map((requirement) => (
            <p key={requirement.id}>
              <strong>{requirement.title}</strong>
              <span>
                {requirement.status === "bound"
                  ? "Dowód powiązany; aktualność podlega sprawdzeniu przy odbiorze"
                  : "Oczekuje na powiązanie wydania"}
              </span>
            </p>
          ))}
        </section>
      )}
    </>
  );
}
export function TaskEquipment({
  taskId,
  title,
  onClose,
}: {
  taskId: string;
  title: string;
  onClose: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<{ equipment: TaskEquipmentProjection }>(
    `/api/tasks/${encodeURIComponent(taskId)}/equipment`,
    revision,
  );
  const [selection, setSelection] = useState<{
    allocationId: string;
    action: EquipmentAction;
  } | null>(null);
  const [date, setDate] = useState("");
  const [location, setLocation] = useState("");
  const [condition, setCondition] = useState<"good" | "repair">("good");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key, setKey] = useState(requestKey);
  const equipment = resource.data?.equipment;
  const allocation = equipment?.allocations.find(
    (entry) => entry.id === selection?.allocationId,
  );
  const bindingOnly = selection?.action === "bindAssetForTask";
  const validRead =
    !resource.loading && !resource.error && equipment?.task.id === taskId;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validRead || !selection || !equipment || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      const command = equipmentCommand(
        equipment,
        selection.allocationId,
        selection.action,
        { date, location, condition, note, humanConfirmed: confirmed },
      );
      const { run } = await post<{ run: Run }>("/api/commands", {
        ...command,
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
    <Sheet title="Sprzęt i przekazanie" subtitle={title} onClose={onClose}>
      <div className="sheet-body equipment-sheet">
        <button
          className="button ghost"
          disabled={busy || resource.loading}
          onClick={() => {
            setRevision((value) => value + 1);
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
        ) : validRead && equipment && !selection ? (
          <EquipmentTaskContent
            equipment={equipment}
            onAction={(entry, action) => {
              setSelection({ allocationId: entry.id, action });
              setConfirmed(false);
              setError("");
              setKey(requestKey());
            }}
          />
        ) : null}
        {selection && allocation && equipment && (
          <form onSubmit={submit} className="equipment-attestation">
            <h3>{equipmentActionLabels[selection.action]}</h3>
            <dl className="equipment-context">
              <div>
                <dt>Odbiorca</dt>
                <dd>{equipment.recipientLabel}</dd>
              </div>
              <div>
                <dt>Współpraca</dt>
                <dd>{equipment.engagementLabel}</dd>
              </div>
              <div>
                <dt>Urządzenie</dt>
                <dd>
                  {allocation.asset.title} ·{" "}
                  {allocation.asset.serial ?? "Bez numeru seryjnego"}
                </dd>
              </div>
            </dl>
            {error && (
              <Notice tone="error">
                {error} Wpisany opis został zachowany. Sprawdź historię wykonań
                przed ponowieniem; po zmianie zakresu odśwież zadanie.
              </Notice>
            )}
            {bindingOnly ? (
              <Notice>
                Powiążesz zapisane wydanie z warunkiem „
                {allocation.binding.title ?? "Wydany sprzęt"}”. Nie zmienia to
                fizycznego stanu urządzenia ani nie zamyka zadania.
              </Notice>
            ) : (
              <>
                <div className="form-grid">
                  <label className="field">
                    <span>
                      {selection.action === "issueForTask"
                        ? "Rzeczywisty dzień wydania"
                        : "Rzeczywisty dzień przyjęcia zwrotu"}
                    </span>
                    <input
                      type="date"
                      required
                      disabled={busy}
                      value={date}
                      onChange={(event) => setDate(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>
                      {selection.action === "issueForTask"
                        ? "Lokalizacja po wydaniu"
                        : "Lokalizacja przyjęcia zwrotu"}
                    </span>
                    <input
                      required
                      maxLength={200}
                      disabled={busy}
                      value={location}
                      onChange={(event) => setLocation(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Zaobserwowany stan urządzenia</span>
                    <select
                      disabled={busy}
                      value={condition}
                      onChange={(event) =>
                        setCondition(event.target.value as "good" | "repair")
                      }
                    >
                      <option value="good">Sprawny</option>
                      <option value="repair">Wymaga naprawy</option>
                    </select>
                  </label>
                </div>
                {selection.action === "issueForTask" &&
                  condition === "repair" && (
                    <Notice tone="error">
                      Nie można wydać sprzętu wymagającego naprawy. Przekaż
                      sprawę opiekunowi sprzętu.
                    </Notice>
                  )}
                <label className="field">
                  <span>Opis rzeczywistego przekazania</span>
                  <textarea
                    rows={4}
                    required
                    maxLength={2000}
                    disabled={busy}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <p className="small muted">
                  Poświadczenie będzie przypisane do Twojego zalogowanego konta.
                  Nie stanowi podpisu odbiorcy.
                </p>
              </>
            )}
            <label className="checkbox-field">
              <input
                type="checkbox"
                required
                disabled={busy}
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              {bindingOnly
                ? "Potwierdzam powiązanie wskazanego poświadczonego wydania z tym wymaganiem."
                : selection.action === "issueForTask"
                  ? "Poświadczam rzeczywiste wydanie tego urządzenia wskazanej osobie i współpracy."
                  : "Poświadczam rzeczywiste przyjęcie zwrotu tego urządzenia."}
            </label>
            <Notice>
              Przygotujesz plan do sprawdzenia i zatwierdzenia. Samo
              przygotowanie planu nie zapisuje przekazania.
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
                Wróć do przekazań
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={
                  busy ||
                  !validRead ||
                  !confirmed ||
                  (!bindingOnly &&
                    (!date || !location.trim() || !note.trim())) ||
                  (selection.action === "issueForTask" &&
                    condition === "repair")
                }
              >
                {busy ? "Przygotowywanie…" : "Przygotuj operację"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Sheet>
  );
}
