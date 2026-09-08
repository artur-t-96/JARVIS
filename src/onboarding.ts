import type { JsonObject } from "./contracts.js";
import type { EmploymentEpisode } from "./workspace.js";
import type { StartCancellation } from "./employment-cancellation.js";

export interface OnboardingStage {
  id:
    | "preparing"
    | "changes_required"
    | "ready_for_review"
    | "awaiting_acceptance"
    | "waiting_start"
    | "ready_to_activate"
    | "active"
    | "closed"
    | "cancelled";
  title: string;
  next: string;
  action?: "submit" | "review" | "activate";
}
export function onboardingStage(input: {
  caseStatus: string;
  episodeStatus: EmploymentEpisode["status"];
  ready: boolean;
  acceptanceCurrent: boolean;
  startDate: string;
  today: string;
}): OnboardingStage {
  if (input.episodeStatus === "cancelled")
    return {
      id: "cancelled",
      title: "Rozpoczęcie współpracy anulowane",
      next: "Decyzja o niezrealizowanym starcie została zapisana po rozliczeniu zasobów. Historia pozostaje dostępna. Nowy start wymaga osobnego okresu, zakresu i dowodów.",
    };
  if (input.episodeStatus === "active")
    return {
      id: "active",
      title: "Współpraca aktywna",
      next: input.acceptanceCurrent
        ? "Start został potwierdzony. Bieżące dowody odbioru pozostają aktualne."
        : "Start został wcześniej potwierdzony. Co najmniej jeden warunek wymaga teraz ponownego sprawdzenia; obsłuż go jako bieżącą sprawę operacyjną.",
    };
  if (["offboarding", "ended"].includes(input.episodeStatus))
    return {
      id: "closed",
      title: "Historia rozpoczęcia współpracy",
      next: "Ten okres jest w zakończeniu albo został zakończony. Nie można ponownie aktywować go przez onboarding.",
    };
  if (input.caseStatus === "cancelled")
    return {
      id: "cancelled",
      title: "Sprawa onboardingu anulowana",
      next: "Anulowanie sprawy nie zamknęło okresu współpracy. Wymaga on jawnego rozliczenia zasobów i decyzji o dalszym postępowaniu.",
    };
  if (
    input.caseStatus === "needs_changes" ||
    (input.caseStatus === "accepted" && !input.acceptanceCurrent) ||
    (input.caseStatus === "awaiting_acceptance" && !input.ready)
  )
    return {
      id: "changes_required",
      title: "Potrzebna ponowna ocena zakresu",
      next: "Przejrzyj odmowę lub nieaktualne źródła. Przygotuj nową rewizję zakresu i wymagane potwierdzenia przed odbiorem.",
    };
  if (!input.ready)
    return {
      id: "preparing",
      title: "Przygotowanie do rozpoczęcia",
      next: "Dokończ wskazane zadania i uzupełnij aktualne dowody. Sama notatka ani rezerwacja sprzętu nie potwierdza gotowości.",
    };
  if (input.caseStatus === "awaiting_acceptance")
    return {
      id: "awaiting_acceptance",
      title: "Czeka na odbiór właściciela",
      next: "Właściciel odbioru ocenia aktualny zakres, zakończone zadania i dowody. Zgoda na zapis decyzji jest oddzielna.",
      action: "review",
    };
  if (input.caseStatus !== "accepted")
    return {
      id: "ready_for_review",
      title: "Gotowe do przekazania do odbioru",
      next: "Wymagane zadania i rezultaty są potwierdzone. Przekaż ten zakres do oceny właściciela.",
      action: "submit",
    };
  if (input.startDate > input.today)
    return {
      id: "waiting_start",
      title: "Odebrane — czeka na datę startu",
      next: "W dniu rozpoczęcia ponownie sprawdzimy wszystkie dowody. Odbiór przygotowania nie aktywuje współpracy automatycznie.",
    };
  return {
    id: "ready_to_activate",
    title: "Można potwierdzić rozpoczęcie",
    next: "Data startu nastąpiła, a odbiór pozostaje aktualny. Potwierdź rozpoczęcie tego konkretnego okresu współpracy.",
    action: "activate",
  };
}
export interface OnboardingOverview {
  evaluatedAt: string;
  today: string;
  timezone: string;
  case: {
    id: string;
    version: number;
    status: string;
    scopeRevision: number;
    ownerPrincipalId: string | null;
    profileVersion: number | null;
  };
  person: { id: string; title: string };
  episode: Pick<
    EmploymentEpisode,
    "id" | "kind" | "status" | "startDate" | "role" | "version"
  >;
  engagement: { module: string; id: string; title: string } | null;
  engagementUnavailable: boolean;
  stage: OnboardingStage;
  ready: boolean;
  acceptanceCurrent: boolean;
  tasks: {
    id: string;
    title: string;
    status: string;
    required: boolean;
    assigneePrincipalId: string | null;
    assigneeRole: string | null;
    dueDate: string | null;
    overdue: boolean;
    waitingFor: string[];
  }[];
  cancellation?: StartCancellation;
  cancellationDecision?: EmploymentEpisode["cancellation"];
  /** Suggestion only: Core binds and rechecks actual authority and versions. */
  command?: {
    action: "submit" | "review" | "activate";
    toolId: string;
    input: JsonObject;
  };
}
