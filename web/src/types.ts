export interface Field {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "select" | "boolean";
  required?: boolean;
  options?: string[];
}
export interface ModuleDefinition {
  id: string;
  label: string;
  description: string;
  fields: Field[];
  actions: { id: string; label: string; fields?: Field[] }[];
}
export interface Entity {
  id: string;
  module: string;
  title: string;
  status: string;
  version: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export interface Run {
  id: string;
  title: string;
  request: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  planHash: string;
  policyVersion: string;
  cancellationRequested?: boolean;
  plan: { summary: string };
  steps: {
    id: string;
    title: string;
    toolId: string;
    input: Record<string, unknown>;
    status: string;
    attempts: number;
    output: { data: Record<string, unknown> } | null;
    error: string | null;
    approval: {
      id: string;
      status: string;
      bindingHash: string;
      decidedBy: string | null;
    } | null;
    verification: {
      ok: boolean;
      summary: string;
      evidence: {
        source: string;
        summary: string;
        observedAt: string;
        data: Record<string, unknown>;
      }[];
    } | null;
  }[];
  events: {
    id: number;
    type: string;
    createdAt: string;
    details: Record<string, unknown>;
  }[];
}
export interface Context {
  principal: {
    id: string;
    tenantId: string;
    roles: string[];
    scopes?: string[];
    name?: string;
    displayName?: string;
  };
  policy: { name: string; version: string };
  planner: { kind: string };
  mode: string;
  tools: { id: string; description: string; effect: string }[];
}
export interface Workspace {
  catalog: ModuleDefinition[];
  summary: {
    modules: {
      id: string;
      label: string;
      total: number;
      byStatus: Record<string, number>;
    }[];
    openCases: number;
    waitingAcceptance: number;
    incidents: number;
  };
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: {
    id: string;
    role: "user" | "assistant";
    content: string;
    kind?: string;
    runId?: string;
    createdAt: string;
  }[];
}
export interface AuthStatus {
  mode: string;
  authenticated: boolean;
  setupRequired?: boolean;
}
export interface Health {
  status: string;
  version: string;
  checks?: Record<string, unknown>;
}

export const statusLabels: Record<string, string> = {
  registered: "Zarejestrowany",
  onboarding: "Onboarding",
  offboarding: "Offboarding",
  ended: "Współpraca zakończona",
  needs_changes: "Do poprawy",
  snoozed: "Odłożone",
  dismissed: "Odrzucone",
  healthy: "System gotowy",
  unhealthy: "Wymaga sprawdzenia",
  planned: "Plan gotowy",
  running: "W realizacji",
  waiting_approval: "Czeka na zgodę",
  completed: "Zakończone",
  blocked: "Zablokowane",
  failed: "Błąd",
  cancelled: "Anulowane",
  needs_reconciliation: "Do uzgodnienia",
  pending: "Oczekuje",
  executing: "Wykonywanie",
  verifying: "Weryfikacja",
  succeeded: "Zweryfikowane",
  unknown: "Wynik nieznany",
  open: "Otwarte",
  in_progress: "W toku",
  ready: "Gotowe",
  accepted: "Odebrane",
  draft: "Szkic",
  review: "Do odbioru",
  active: "Aktywne",
  inactive: "Nieaktywne",
  available: "Dostępny",
  assigned: "Przydzielony",
  maintenance: "W serwisie",
  retired: "Wycofany",
  requested: "Zgłoszone",
  approved: "Zatwierdzone",
  awaiting_budget: "Czeka na decyzję kosztową",
  rejected: "Odrzucone",
  ordered: "Zamówione",
  acknowledged: "Potwierdzone przez dostawcę",
  part_received: "Częściowo przyjęte",
  needs_resolution: "Rozbieżność do wyjaśnienia",
  confirmed: "Poświadczone",
  received: "Otrzymane",
  delivered: "Przekazane",
  waiting_acceptance: "Czeka na odbiór",
  awaiting_acceptance: "Czeka na odbiór",
  closed: "Zamknięte",
  resolved: "Rozwiązane",
  expired: "Wygasłe",
  renewed: "Odnowione",
  new: "Nowe",
  qualified: "Zakwalifikowane",
  proposal: "Oferta",
  won: "Wygrane",
  lost: "Przegrane",
  applied: "Zgłoszony",
  screening: "Weryfikacja",
  interview: "Rozmowa",
  hired: "Zatrudniony",
  published: "Opublikowane",
  archived: "Archiwalne",
  submitted: "Do decyzji",
  reserved: "Zarezerwowany",
};
export const statusLabel = (value: string) =>
  statusLabels[value] ?? value.replaceAll("_", " ");
export const dateLabel = (value?: string, full = false, timeZone?: string) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    ...(full
      ? ({
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        } as const)
      : ({ day: "numeric", month: "short", year: "numeric" } as const)),
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(value));
};
export const numberLabel = (value: number) =>
  new Intl.NumberFormat("pl-PL").format(value);
export function displayValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Tak" : "Nie";
  if (typeof value === "number") return numberLabel(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
