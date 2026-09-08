export type EquipmentAction =
  "issueForTask" | "returnForTask" | "bindAssetForTask";
export interface EquipmentAllocation {
  id: string;
  version: number;
  status: string;
  reservedUntil: string;
  expiresAt: string | null;
  expired: boolean;
  asset: {
    id: string;
    title: string;
    version: number;
    serial: string | null;
    location: string | null;
    condition: string | null;
  };
  issueEvent?: {
    id: string;
    occurredOn: string;
    performedBy: string | null;
    approvedBy: string | null;
  };
  binding: {
    status: "unbound" | "bound" | "not_applicable";
    requirementId?: string;
    title?: string;
  };
  allowedActions: EquipmentAction[];
  commandBindings: Partial<Record<EquipmentAction, Record<string, unknown>>>;
}
export interface TaskEquipmentProjection {
  task: {
    id: string;
    title: string;
    version: number;
    status: string;
    scopeRevision: number;
  };
  recipientLabel: string;
  engagementLabel: string;
  allocations: EquipmentAllocation[];
  requirements: {
    id: string;
    title: string;
    key: string;
    status: "unbound" | "bound";
    sourceId?: string;
  }[];
}
export interface EquipmentAttestation {
  date: string;
  location: string;
  condition: "good" | "repair";
  note: string;
  humanConfirmed: boolean;
}
export const equipmentActionLabels: Record<EquipmentAction, string> = {
  issueForTask: "Poświadcz wydanie",
  returnForTask: "Poświadcz zwrot",
  bindAssetForTask: "Powiąż wydanie z wymaganiem",
};
export function equipmentState(
  allocation: Pick<
    EquipmentAllocation,
    "status" | "expired" | "binding" | "issueEvent"
  >,
): string {
  if (allocation.status === "reserved")
    return allocation.expired
      ? "Rezerwacja wygasła — sprzęt nadal zajęty"
      : "Zarezerwowany — oczekuje na wydanie";
  if (allocation.status === "issued") {
    if (!allocation.issueEvent)
      return "Wydany — brak poświadczenia na aktualnych zasadach";
    if (allocation.binding.status === "not_applicable")
      return "Wydany — do rozliczenia w tym zadaniu";
    return allocation.binding.status === "bound"
      ? "Wydany — dowód powiązany"
      : "Wydany — dowód wymaga powiązania";
  }
  if (allocation.status === "returned")
    return "Zwrócony — wcześniejsze wydanie nie potwierdza gotowości";
  if (allocation.status === "released") return "Rezerwacja zwolniona";
  return "Stan wymaga sprawdzenia";
}
/** Inputs from a typed read are immutable. The operator supplies only the witnessed facts. */
export function equipmentCommand(
  equipment: TaskEquipmentProjection,
  allocationId: string,
  action: EquipmentAction,
  attestation?: EquipmentAttestation,
) {
  const allocation = equipment.allocations.find(
    (entry) => entry.id === allocationId,
  );
  const binding = allocation?.commandBindings[action];
  if (
    equipment.task.status !== "accepted" ||
    !allocation?.allowedActions.includes(action) ||
    !binding
  )
    throw new Error(
      "Czynność nie jest dostępna. Odśwież zakres zadania i sprawdź wykonawcę.",
    );
  if (
    binding.taskId !== equipment.task.id ||
    binding.expectedTaskVersion !== equipment.task.version ||
    binding.allocationId !== allocation.id ||
    binding.expectedAllocationVersion !== allocation.version ||
    binding.id !== allocation.asset.id ||
    binding.expectedVersion !== allocation.asset.version
  )
    throw new Error("Zakres przekazania jest nieaktualny. Odśwież zadanie.");
  if (
    action === "issueForTask" &&
    (allocation.status !== "reserved" || allocation.expired)
  )
    throw new Error(
      "Tej rezerwacji nie można wydać. Wymaga rozstrzygnięcia przez opiekuna sprzętu.",
    );
  if (action === "returnForTask" && allocation.status !== "issued")
    throw new Error("Zwrot wymaga wskazanej wydanej alokacji.");
  if (action === "bindAssetForTask") {
    if (
      allocation.status !== "issued" ||
      !allocation.issueEvent ||
      binding.issueEventId !== allocation.issueEvent.id ||
      !binding.requirementId
    )
      throw new Error("Brak aktualnego, poświadczonego wydania do powiązania.");
    return { toolId: `ops.assets.${action}`, input: { ...binding } };
  }
  if (
    !attestation?.humanConfirmed ||
    !/^\d{4}-\d{2}-\d{2}$/.test(attestation.date) ||
    !attestation.location.trim() ||
    !attestation.note.trim() ||
    !["good", "repair"].includes(attestation.condition)
  )
    throw new Error(
      "Uzupełnij dzień, lokalizację, stan i opis rzeczywistego przekazania oraz poświadczenie.",
    );
  if (action === "issueForTask" && attestation.condition !== "good")
    throw new Error("Sprzęt wymagający naprawy nie może zostać wydany.");
  return {
    toolId: `ops.assets.${action}`,
    input: {
      ...binding,
      location: attestation.location.trim(),
      condition: attestation.condition,
      humanConfirmed: true,
      ...(action === "issueForTask"
        ? { issuedOn: attestation.date, handoverNote: attestation.note.trim() }
        : {
            returnedOn: attestation.date,
            receiptNote: attestation.note.trim(),
          }),
    },
  };
}
