import type { Conversation as BaseConversation } from "./types";
import { dateLabel } from "./types";
import { Icon, Loading, Notice } from "./ui";

export interface DraftChoice {
  ref: string;
  label: string;
  detail?: string;
}
export interface NeedDraft {
  id: string;
  version: number;
  intent: string;
  phase: string;
  person?: DraftChoice;
  episode?: DraftChoice;
  asset?: DraftChoice;
  case?: DraftChoice;
  readyOn?: string;
  reservationUntil?: string;
  assetType?: string;
  missingFields: string[];
  blockedReason?: string;
  clarification?: {
    kind: string;
    question: string;
    options: DraftChoice[];
    hasNextPage?: boolean;
  };
  linkedRuns: { runId: string; status: string; title: string }[];
  sources?: {
    label: string;
    module: string;
    version: number;
    observedAt: string;
    updatedAt?: string;
    freshness: "current" | "stale" | "unavailable";
  }[];
  scopeHash?: string;
}
export type Conversation = BaseConversation & {
  draft?: NeedDraft;
  pendingTurn?: {
    idempotencyKey: string;
    message: string;
    leaseExpiresAt: string;
  };
};

const phases: Record<string, { label: string; hint: string; tone?: string }> = {
  collecting: {
    label: "Uzupełnianie potrzeby",
    hint: "Szkic zbiera dane potrzebne do przygotowania operacji.",
  },
  needs_choice: {
    label: "Potrzebny Twój wybór",
    hint: "Wybierz właściwą osobę, współpracę lub dostępny wariant.",
  },
  ready_to_plan: {
    label: "Gotowe do przygotowania planu",
    hint: "Ustalony zakres może posłużyć do przygotowania operacji wymagającej zgody.",
  },
  planned: {
    label: "Plan przygotowany",
    hint: "Plan czeka na uruchomienie. Wykonanie sprawdzisz w powiązanej operacji.",
  },
  awaiting_approval: {
    label: "Oczekuje na zgodę",
    hint: "Sprawdź dokładny zakres operacji i podejmij decyzję w jej widoku.",
  },
  in_progress: {
    label: "Operacja w toku",
    hint: "Bieżący stan pochodzi z powiązanego wykonania.",
  },
  blocked: {
    label: "Potrzeba zablokowana",
    hint: "Uzupełnij wskazany brak albo wyjaśnij przeszkodę przed dalszym działaniem.",
    tone: "attention",
  },
  completed: {
    label: "Powiązane wykonanie zakończone",
    hint: "Sprawdź zapisane rezultaty i dowody w powiązanej operacji.",
    tone: "complete",
  },
  cancelled: {
    label: "Realizacja anulowana",
    hint: "Historia pozostaje dostępna. Kolejna potrzeba wymaga ustalenia nowego zakresu.",
  },
};
const missingLabels: Record<string, string> = {
  person: "Właściwa osoba",
  personRef: "Właściwa osoba",
  personId: "Właściwa osoba",
  episode: "Konkretna współpraca",
  episodeRef: "Konkretna współpraca",
  employmentEpisodeId: "Konkretna współpraca",
  readyOn: "Termin gotowości",
  reservationUntil: "Koniec rezerwacji",
  asset: "Dostępny sprzęt",
  assetRef: "Dostępny sprzęt",
  assetId: "Dostępny sprzęt",
  assetType: "Rodzaj sprzętu",
  case: "Właściwa sprawa",
  caseRef: "Właściwa sprawa",
  caseId: "Właściwa sprawa",
};
const assetLabels: Record<string, string> = {
  laptop: "Laptop",
  desktop: "Komputer stacjonarny",
  accessory: "Akcesorium",
  phone: "Telefon",
  monitor: "Monitor",
  other: "Inny sprzęt",
};
const runLabels: Record<string, { label: string; hint: string }> = {
  planned: {
    label: "Plan przygotowany",
    hint: "Sprawdź zakres przed uruchomieniem",
  },
  waiting_approval: {
    label: "Oczekuje na zgodę",
    hint: "Sprawdź operację i podejmij decyzję",
  },
  running: { label: "W trakcie wykonania", hint: "Sprawdź postęp i dowody" },
  completed: {
    label: "Wykonanie zakończone",
    hint: "Otwórz zapisane wyniki i weryfikację",
  },
  blocked: {
    label: "Wykonanie zablokowane",
    hint: "Sprawdź przyczynę blokady",
  },
  failed: {
    label: "Wykonanie wymaga uwagi",
    hint: "Sprawdź błąd i stan operacji",
  },
  needs_reconciliation: {
    label: "Wynik wymaga uzgodnienia",
    hint: "Sprawdź wynik przed ponowną próbą",
  },
  cancelled: { label: "Wykonanie anulowane", hint: "Otwórz historię operacji" },
};
export const runStateCopy = (status?: string) =>
  runLabels[status ?? ""] ?? {
    label: "Powiązana operacja",
    hint: "Otwórz, aby sprawdzić bieżący stan",
  };

export function DraftChoicePanel({
  clarification,
  disabled,
  onChoose,
  onNextPage,
}: {
  clarification: NonNullable<NeedDraft["clarification"]>;
  disabled: boolean;
  onChoose: (choice: DraftChoice) => void;
  onNextPage?: () => void;
}) {
  return (
    <section
      className="draft-clarification"
      aria-label="Doprecyzowanie potrzeby"
    >
      <h4>{clarification.question}</h4>
      {clarification.options.length ? (
        <div className="draft-choice-list">
          {clarification.options.map((option) => (
            <button
              type="button"
              className="draft-choice"
              key={option.ref}
              disabled={disabled}
              onClick={() => onChoose(option)}
            >
              <span>
                <strong>{option.label}</strong>
                {option.detail && <small>{option.detail}</small>}
              </span>
              <Icon name="arrow" size={17} />
            </button>
          ))}
        </div>
      ) : (
        <p className="small muted">
          Brak dostępnego wariantu do wyboru. Uzupełnij opis potrzeby lub
          wyjaśnij wskazaną przeszkodę.
        </p>
      )}
      {clarification.hasNextPage && onNextPage && (
        <button
          type="button"
          className="button secondary"
          disabled={disabled}
          onClick={onNextPage}
        >
          Pokaż kolejne
        </button>
      )}
    </section>
  );
}

export function ConversationDraft({
  draft,
  loading = false,
  disabled = false,
  onChoose,
  onOpenRun,
  onNextPage,
}: {
  draft?: NeedDraft;
  loading?: boolean;
  disabled?: boolean;
  onChoose: (choice: DraftChoice) => void;
  onOpenRun: (id: string) => void;
  onNextPage?: () => void;
}) {
  if (loading && !draft)
    return (
      <section
        className="conversation-draft"
        aria-label="Pobieranie szkicu"
        aria-busy="true"
      >
        <Loading />
      </section>
    );
  if (!draft) return null;
  const phase = phases[draft.phase] ?? {
    label: "Stan do sprawdzenia",
    hint: "Sprawdź bieżący zakres i powiązane operacje.",
  };
  const fields: [string, string | undefined][] = [
    ["Osoba", draft.person?.label],
    [
      "Współpraca",
      draft.episode
        ? [draft.episode.label, draft.episode.detail]
            .filter(Boolean)
            .join(" · ")
        : undefined,
    ],
    ["Sprzęt", draft.asset?.label],
    ["Sprawa", draft.case?.label],
    [
      "Rodzaj sprzętu",
      draft.assetType
        ? (assetLabels[draft.assetType] ?? "Wskazany rodzaj sprzętu")
        : undefined,
    ],
    ["Gotowe na", draft.readyOn ? dateLabel(draft.readyOn) : undefined],
    [
      "Rezerwacja ważna do",
      draft.reservationUntil
        ? dateLabel(
            draft.reservationUntil,
            draft.reservationUntil.includes("T"),
          )
        : undefined,
    ],
  ];
  const missing = [
    ...new Set(
      draft.missingFields.map(
        (key) => missingLabels[key] ?? "Dodatkowe dane do uzgodnienia",
      ),
    ),
  ];
  return (
    <section
      className={`conversation-draft ${phase.tone ?? ""}`}
      aria-label="Bieżący szkic potrzeby"
      aria-busy={loading}
    >
      <div className="draft-heading">
        <div>
          <span className="eyebrow">
            BIEŻĄCY SZKIC · WERSJA {draft.version}
          </span>
          <h3>
            {draft.intent === "equipment_request" ||
            draft.intent === "reserve_asset"
              ? "Przygotowanie sprzętu"
              : "Ustalony zakres potrzeby"}
          </h3>
        </div>
        <span className="draft-phase">{phase.label}</span>
      </div>
      <p className="small muted">{phase.hint}</p>
      {draft.blockedReason && (
        <Notice tone="error">{draft.blockedReason}</Notice>
      )}
      {fields.some(([, value]) => value) && (
        <dl className="draft-facts">
          {fields
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      )}
      {missing.length > 0 && (
        <div className="draft-missing">
          <strong>Do ustalenia</strong>
          <ul>
            {missing.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.clarification && (
        <DraftChoicePanel
          clarification={draft.clarification}
          disabled={disabled || loading}
          onChoose={onChoose}
          onNextPage={onNextPage}
        />
      )}
      {draft.linkedRuns.length > 0 && (
        <section className="draft-executions" aria-label="Bieżący stan wykonań">
          <h4>Powiązane wykonania</h4>
          {draft.linkedRuns.map((run) => {
            const state = runStateCopy(run.status);
            return (
              <button
                type="button"
                className="chat-run-link"
                key={run.runId}
                onClick={() => onOpenRun(run.runId)}
              >
                <span className="chat-run-icon">
                  <Icon name="cases" size={21} />
                </span>
                <span>
                  <strong>{run.title}</strong>
                  <small>
                    {state.label} · {state.hint}
                  </small>
                </span>
                <Icon name="arrow" size={20} />
              </button>
            );
          })}
        </section>
      )}
      {!!draft.sources?.length && (
        <details className="draft-sources">
          <summary>
            Źródła i aktualność odczytu ({draft.sources.length})
          </summary>
          <ul>
            {draft.sources.map((source, index) => (
              <li key={index}>
                <strong>{source.label}</strong>
                <span>
                  Wersja {source.version} ·{" "}
                  {source.freshness === "current"
                    ? "Aktualne"
                    : source.freshness === "stale"
                      ? "Wymaga ponownego odczytu"
                      : "Źródło niedostępne"}
                </span>
                <span>Sprawdzono: {dateLabel(source.observedAt, true)}</span>
                {source.updatedAt && (
                  <span>
                    Zaktualizowano: {dateLabel(source.updatedAt, true)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function PendingConversationTurn({
  pending,
  busy,
  onResume,
}: {
  pending: NonNullable<Conversation["pendingTurn"]>;
  busy: boolean;
  onResume: () => void;
}) {
  return (
    <section
      className="pending-conversation-turn"
      aria-label="Niedokończona odpowiedź"
    >
      <strong>Ta wiadomość czeka na dokończenie</strong>
      <p>{pending.message}</p>
      <p className="small muted">
        Najpierw sprawdź wynik poprzedniej tury. Szkic i historia pozostają
        zachowane.
      </p>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={onResume}
      >
        <Icon name="refresh" size={16} />
        {busy ? "Sprawdzanie…" : "Sprawdź i wznów odpowiedź"}
      </button>
    </section>
  );
}
