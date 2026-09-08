import { useState, type FormEvent } from "react";
import type { OnboardingOverview } from "../../src/onboarding";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import {
  dateLabel,
  statusLabel,
  type Context,
  type Entity,
  type Run,
} from "./types";
import { Badge, Icon, Loading, Notice, Sheet } from "./ui";

const actionLabels = {
  submit: "Przekaż do odbioru",
  review: "Oceń gotowość",
  activate: "Potwierdź rozpoczęcie",
};
export function OnboardingCard({
  overview,
  onPrepare,
}: {
  overview: OnboardingOverview;
  onPrepare?: () => void;
}) {
  const activeTasks = overview.tasks.filter(
    (t) => !["completed", "cancelled"].includes(t.status),
  );
  return (
    <section className="card onboarding-card" aria-label="Przebieg onboardingu">
      <div className="card-heading">
        <div>
          <span className="eyebrow">
            START WSPÓŁPRACY · ZAKRES {overview.case.scopeRevision}
          </span>
          <h2>{overview.stage.title}</h2>
          <p>{overview.stage.next}</p>
        </div>
        <Icon name="people" size={24} />
      </div>
      <dl className="onboarding-context">
        <div>
          <dt>Osoba</dt>
          <dd>
            <button
              className="text-button"
              onClick={() => navigate(`module/people/${overview.person.id}`)}
            >
              {overview.person.title}
            </button>
          </dd>
        </div>
        <div>
          <dt>Rodzaj współpracy</dt>
          <dd>
            {overview.episode.kind === "contractor"
              ? "Konsultant klienta"
              : "Pracownik wewnętrzny"}
          </dd>
        </div>
        <div>
          <dt>Projekt / umowa</dt>
          <dd>
            {overview.engagement ? (
              <button
                className="text-button"
                onClick={() =>
                  navigate(
                    `module/${overview.engagement!.module}/${overview.engagement!.id}`,
                  )
                }
              >
                {overview.engagement.title}
              </button>
            ) : overview.engagementUnavailable ? (
              "Projekt niedostępny dla tego konta"
            ) : (
              "Nie wskazano projektu"
            )}
          </dd>
        </div>
        <div>
          <dt>Rola we współpracy</dt>
          <dd>{overview.episode.role}</dd>
        </div>
        <div>
          <dt>Data rozpoczęcia</dt>
          <dd>{dateLabel(overview.episode.startDate)}</dd>
        </div>
        <div>
          <dt>Właściciel odbioru</dt>
          <dd>{overview.case.ownerPrincipalId ?? "Wymaga przypisania"}</dd>
        </div>
      </dl>
      <div className="onboarding-work">
        <h3>
          {activeTasks.length
            ? "Praca do dokończenia"
            : "Potwierdzenia wykonanej pracy"}
        </h3>
        <ul>
          {(activeTasks.length ? activeTasks : overview.tasks).map((t) => (
            <li key={t.id}>
              <div>
                <strong>{t.title}</strong>
                <p className="small muted">
                  {t.assigneeRole === "hr"
                    ? "HR"
                    : t.assigneeRole === "it"
                      ? "IT"
                      : t.assigneeRole === "manager"
                        ? "Przełożony"
                        : "Wykonawca"}
                  : {t.assigneePrincipalId ?? "brak przypisania"}
                  {t.dueDate ? ` · termin ${dateLabel(t.dueDate)}` : ""}
                  {t.overdue ? " · po terminie" : ""}
                </p>
                {t.waitingFor.length > 0 && (
                  <p className="small">Najpierw: {t.waitingFor.join("; ")}</p>
                )}
              </div>
              <span
                className={`onboarding-task-state ${t.overdue ? "overdue" : ""}`}
              >
                {statusLabel(t.status)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="onboarding-footer">
        <p className="small muted">
          Sprawdzono {dateLabel(overview.evaluatedAt, true)} · dzień firmy{" "}
          {dateLabel(overview.today)} ({overview.timezone}) · profil{" "}
          {overview.case.profileVersion ?? "niepotwierdzony"}
        </p>
        {onPrepare && overview.command && (
          <button className="button primary" onClick={onPrepare}>
            {actionLabels[overview.command.action]}{" "}
            <Icon name="arrow" size={16} />
          </button>
        )}
        {!overview.command && overview.stage.action === "review" && (
          <p className="small muted">
            Decyzję podejmuje wskazany właściciel odbioru.
          </p>
        )}
      </div>
    </section>
  );
}

function OnboardingDecision({
  overview,
  onClose,
}: {
  overview: OnboardingOverview;
  onClose: () => void;
}) {
  const command = overview.command!;
  const [key] = useState(requestKey),
    [decision, setDecision] = useState("accepted"),
    [note, setNote] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const human = command.action !== "submit";
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || (human && !confirmed)) return;
    setBusy(true);
    setError("");
    try {
      const result = await post<{ run: Run }>("/api/commands", {
        toolId: command.toolId,
        input: {
          ...command.input,
          ...(human ? { humanDecision: true } : {}),
          ...(command.action === "review" ? { decision, note } : {}),
        },
        idempotencyKey: key,
      });
      navigate(`runs/${result.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={actionLabels[command.action]} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <p>
            <strong>{overview.person.title}</strong> ·{" "}
            {overview.engagement?.title ??
              (overview.episode.kind === "internal"
                ? "współpraca wewnętrzna"
                : "wskazana współpraca")}{" "}
            · start {dateLabel(overview.episode.startDate)}
          </p>
          <p>{overview.stage.next}</p>
          {command.action === "review" && (
            <>
              <label className="field">
                <span>Decyzja</span>
                <select
                  value={decision}
                  onChange={(e) => setDecision(e.target.value)}
                  disabled={busy}
                >
                  <option value="accepted">Odbieram aktualny zakres</option>
                  <option value="rejected">
                    Odmawiam odbioru — wymaga poprawy
                  </option>
                </select>
              </label>
              <label className="field">
                <span>Uzasadnienie decyzji</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  required
                  minLength={3}
                  maxLength={4000}
                  disabled={busy}
                />
              </label>
            </>
          )}
          {human && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                required
                disabled={busy}
              />
              {command.action === "activate"
                ? "Potwierdzam rozpoczęcie wskazanej współpracy."
                : "Potwierdzam osobistą ocenę zakresu i dowodów."}
            </label>
          )}
          <Notice>
            Przygotujesz operację do osobnego zatwierdzenia zapisu. Aktualność
            danych i uprawnienia zostaną ponownie sprawdzone przy wykonaniu.
          </Notice>
        </div>
        <div className="sheet-footer">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Anuluj
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || (human && !confirmed)}
          >
            {busy ? "Przygotowywanie…" : "Przygotuj operację"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function Onboarding({
  item,
  context,
  revision,
}: {
  item: Entity;
  context: Context;
  revision: number;
}) {
  const resource = useResource<{ onboarding: OnboardingOverview }>(
    `/api/cases/${item.id}/onboarding`,
    revision + item.version,
    7000,
  );
  const [selection, setSelection] = useState<OnboardingOverview | null>(null);
  if (resource.error)
    return (
      <Notice tone="error">
        Nie można odczytać przebiegu onboardingu: {resource.error}
      </Notice>
    );
  if (resource.loading || !resource.data) return <Loading />;
  const overview = resource.data.onboarding,
    canPrepare =
      overview.command &&
      context.tools.some((t) => t.id === overview.command!.toolId);
  return (
    <>
      {selection && (
        <OnboardingDecision
          overview={selection}
          onClose={() => setSelection(null)}
        />
      )}
      <OnboardingCard
        overview={overview}
        onPrepare={canPrepare ? () => setSelection(overview) : undefined}
      />
    </>
  );
}

export function PersonOnboardings({
  item,
  revision,
}: {
  item: Entity;
  revision: number;
}) {
  const resource = useResource<{
    episodes: {
      id: string;
      kind: string;
      status: string;
      startDate: string;
      engagementLabel?: string;
      onboardingCaseId: string | null;
    }[];
  }>(`/api/people/${item.id}/episodes`, revision + item.version);
  if (resource.error)
    return (
      <Notice tone="error">
        Nie można odczytać okresów współpracy: {resource.error}
      </Notice>
    );
  if (resource.loading || !resource.data) return <Loading />;
  const episodes = resource.data.episodes.filter((e) =>
    ["onboarding", "active"].includes(e.status),
  );
  if (!episodes.length) return null;
  return (
    <section
      className="card onboarding-card"
      aria-label="Rozpoczęcia współpracy"
    >
      <div className="card-heading">
        <div>
          <h2>Rozpoczęcia współpracy</h2>
          <p>Każdy projekt ma własny zakres, dowody i odbiór.</p>
        </div>
        <Icon name="people" />
      </div>
      <ul className="onboarding-periods">
        {episodes.map((e) => (
          <li key={e.id}>
            <div>
              <strong>
                {e.engagementLabel ??
                  (e.kind === "internal"
                    ? "Współpraca wewnętrzna"
                    : "Współpraca konsultanta")}
              </strong>
              <p className="small muted">Start {dateLabel(e.startDate)}</p>
            </div>
            <Badge status={e.status} />
            {e.onboardingCaseId && (
              <button
                className="button secondary"
                onClick={() => navigate(`module/cases/${e.onboardingCaseId}`)}
              >
                Otwórz onboarding <Icon name="arrow" size={16} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
