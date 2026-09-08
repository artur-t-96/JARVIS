import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { api, ApiError, post, setBearerToken } from "./api";
import { errorMessage, navigate, useResource, useRoute } from "./hooks";
import {
  dateLabel,
  displayValue,
  numberLabel,
  type AuthStatus,
  type Context,
  type Health,
  type Run,
  type Workspace,
} from "./types";
import { Badge, Empty, Icon, JsonView, Loading, Notice } from "./ui";
import { WorkspacePage } from "./WorkspacePage";
import { RunPage } from "./RunPage";
import { ConversationPage } from "./ConversationPage";
import { Initiatives, CompanySettings } from "./Initiatives";

function Login({
  status,
  onSuccess,
  error: initialError,
}: {
  status: AuthStatus | null;
  onSuccess: () => Promise<void>;
  error: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const accounts = status?.mode === "accounts";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (accounts) await post("/api/auth/login", { username, password });
      else setBearerToken(token);
      await onSuccess();
      setPassword("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="brand inverse">
          <span className="brand-mark">J</span>
          <span>
            JARVIS<small>TWOJE CENTRUM OPERACYJNE</small>
          </span>
        </div>
        <div>
          <span className="eyebrow">PRZESTRZEŃ DO DOBREJ PRACY</span>
          <h1>
            Od sprawy
            <br />
            do załatwienia.
          </h1>
          <p>
            Rozmawiaj, podejmuj decyzje i miej pewność, co zostało zrobione.
            Wszystko w jednej przestrzeni.
          </p>
          <div className="login-features">
            <span>
              <Icon name="cases" />
              Jasny zakres i odpowiedzialność
            </span>
            <span>
              <Icon name="shield" />
              Twoja kontrola nad działaniami
            </span>
            <span>
              <Icon name="check" />
              Wyniki potwierdzone dowodami
            </span>
          </div>
        </div>
        <span className="login-footnote">JARVIS · Instalacja lokalna</span>
      </section>
      <section className="login-form-area">
        <form className="login-form" onSubmit={(event) => void submit(event)}>
          <span className="eyebrow">WITAJ W JARVIS</span>
          <h2>Zaloguj się do pracy</h2>
          <p className="muted">
            {accounts
              ? "Użyj swojego lokalnego konta."
              : "Podaj token przypisany do Twojej tożsamości."}
          </p>
          {status?.setupRequired && (
            <Notice>
              Najpierw trzeba utworzyć lokalne konto administratora według
              instrukcji instalacji. Rejestracja publiczna jest wyłączona.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          {accounts ? (
            <>
              <label className="field">
                <span>Nazwa użytkownika</span>
                <input
                  autoFocus
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label className="field">
                <span>Hasło</span>
                <input
                  type="password"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>Token dostępu</span>
              <input
                autoFocus
                type="password"
                required
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <small>Token pozostaje w pamięci tej karty.</small>
            </label>
          )}
          <button
            className="button primary full-width"
            disabled={busy || status?.setupRequired}
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="arrow" size={18} />
            )}
            Otwórz JARVIS
          </button>
          <p className="login-security">
            <Icon name="shield" size={16} />
            Dostęp do danych wynika z Twojej roli i organizacji.
          </p>
        </form>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  icon,
  note,
  onClick,
}: {
  label: string;
  value: number | undefined;
  icon: string;
  note: string;
  onClick: () => void;
}) {
  return (
    <button className="stat-card" onClick={onClick}>
      <span className="stat-top">
        {label}
        <Icon name={icon} size={19} />
      </span>
      <strong>{value === undefined ? "—" : numberLabel(value)}</strong>
      <span className="stat-note">
        {note}
        <Icon name="arrow" size={15} />
      </span>
    </button>
  );
}
function RunList({
  runs,
  compact = false,
}: {
  runs: Run[];
  compact?: boolean;
}) {
  if (!runs.length)
    return (
      <Empty icon="check" title="Jeszcze bez wykonań">
        Opisz zadanie w rozmowie lub przygotuj operację w jednym z modułów.
      </Empty>
    );
  return (
    <div className={`run-list ${compact ? "compact" : ""}`}>
      {runs.map((run) => (
        <button
          className="run-row"
          key={run.id}
          onClick={() => navigate(`runs/${run.id}`)}
        >
          <span
            className={`run-row-icon ${run.status === "waiting_approval" ? "warm" : ""}`}
          >
            <Icon
              name={run.status === "waiting_approval" ? "shield" : "cases"}
              size={20}
            />
          </span>
          <span className="run-row-title">
            <strong>{run.title}</strong>
            <small>{dateLabel(run.updatedAt, true)}</small>
          </span>
          <Badge status={run.status} />
          <Icon name="chevron" size={17} />
        </button>
      ))}
    </div>
  );
}
function Overview({
  workspace,
  workspaceError,
  runsLoaded,
  runs,
  context,
}: {
  workspace: Workspace | null;
  workspaceError: string;
  runsLoaded: boolean;
  runs: Run[];
  context: Context;
}) {
  const waiting = runs.filter((run) => run.status === "waiting_approval");
  const unresolved = runs.filter((run) =>
    ["blocked", "failed", "needs_reconciliation"].includes(run.status),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TWOJA PRZESTRZEŃ PRACY</span>
          <h1>Centrum operacyjne</h1>
          <p>Sprawy, decyzje i postęp pracy w jednym miejscu.</p>
        </div>
        <button
          className="button secondary"
          onClick={() => navigate("conversation")}
        >
          <Icon name="chat" size={18} />
          Porozmawiaj z JARVIS
        </button>
      </div>
      {workspaceError && <Notice tone="error">{workspaceError}</Notice>}
      {context.mode === "local" && (
        <Notice>
          Laboratorium bez logowania — używaj danych testowych. Praca na danych
          firmy wymaga uruchomienia trybu kont lokalnych.
        </Notice>
      )}
      <section className="overview-hero">
        <div className="hero-copy">
          <span className="eyebrow">DOBRY PLAN. POTWIERDZONY WYNIK.</span>
          <h2>
            Czym zajmiemy
            <br />
            się dzisiaj?
          </h2>
          <p>
            Powiedz, co chcesz załatwić. JARVIS zbierze potrzebne informacje i
            przygotuje kolejne kroki.
          </p>
          <button
            className="button dark"
            onClick={() => navigate("conversation")}
          >
            Rozpocznij rozmowę
            <Icon name="arrow" size={18} />
          </button>
        </div>
        <div className="hero-process">
          <div className="process-orbit" />
          <span className="hero-j">J</span>
          <div className="process-label top">
            <span className="process-dot" />
            Cel i kontekst
          </div>
          <div className="process-label right">
            <Icon name="shield" size={16} />
            Twoja decyzja
          </div>
          <div className="process-label bottom">
            <Icon name="check" size={16} />
            Sprawdzony wynik
          </div>
        </div>
      </section>
      <div className="stats-grid">
        <Stat
          label="Otwarte sprawy"
          value={workspace?.summary.openCases}
          icon="cases"
          note="Przejdź do pracy nad sprawami"
          onClick={() => navigate("module/cases")}
        />
        <Stat
          label="Oczekujące zgody"
          value={runsLoaded ? waiting.length : undefined}
          icon="shield"
          note="Sprawdź zakres operacji"
          onClick={() => navigate(waiting[0] ? `runs/${waiting[0].id}` : "ops")}
        />
        <Stat
          label="Sprawy do odbioru"
          value={workspace?.summary.waitingAcceptance}
          icon="check"
          note="Potwierdź rezultat biznesowy"
          onClick={() => navigate("module/cases")}
        />
        <Stat
          label="Incydenty IT"
          value={workspace?.summary.incidents}
          icon="pulse"
          note="Zobacz sprawy wymagające reakcji"
          onClick={() => navigate("module/it")}
        />
      </div>
      <div className="overview-grid">
        <section className="card">
          <div className="card-heading">
            <h2>Teraz Twoja kolej</h2>
            <span className="count-bubble">
              {runsLoaded ? waiting.length + unresolved.length : "—"}
            </span>
          </div>
          {!runsLoaded ? (
            <p className="muted">Stan wykonań nie jest jeszcze dostępny.</p>
          ) : waiting.length || unresolved.length ? (
            <RunList runs={[...waiting, ...unresolved].slice(0, 5)} compact />
          ) : (
            <Empty icon="check" title="Brak oczekujących decyzji">
              W ostatnich wykonaniach nie ma zgód ani blokad wymagających
              obsługi.
            </Empty>
          )}
          <button
            className="text-button section-link"
            onClick={() => navigate("ops")}
          >
            Wszystkie wykonania
            <Icon name="arrow" size={16} />
          </button>
        </section>
        <section className="card workspace-shortcuts">
          <div className="card-heading">
            <h2>Obszary pracy</h2>
            <span className="small muted">Dane lokalne</span>
          </div>
          <div className="module-shortcuts">
            {(workspace?.catalog ?? [])
              .filter((module) => module.id !== "cases")
              .map((module) => (
                <button
                  key={module.id}
                  onClick={() => navigate(`module/${module.id}`)}
                >
                  <span className="shortcut-icon">
                    <Icon name={module.id} size={20} />
                  </span>
                  <span>
                    <strong>{module.label}</strong>
                    <small>
                      {workspace?.summary.modules.find(
                        (summary) => summary.id === module.id,
                      )?.total ?? "—"}{" "}
                      rekordów
                    </small>
                  </span>
                  <Icon name="chevron" size={15} />
                </button>
              ))}
          </div>
        </section>
      </div>
      <Initiatives context={context} />
      <section className="card">
        <div className="card-heading">
          <div>
            <h2>Ostatnie wykonania</h2>
            <p>Rzeczywisty stan operacji i potwierdzone wyniki.</p>
          </div>
          <button className="text-button" onClick={() => navigate("ops")}>
            Zobacz wszystkie
            <Icon name="arrow" size={16} />
          </button>
        </div>
        {runsLoaded ? (
          <RunList runs={runs.slice(0, 5)} />
        ) : (
          <p className="muted">Oczekiwanie na dane wykonań.</p>
        )}
      </section>
      <p className="workspace-footnote">
        Przestrzeń: {context.principal.tenantId} · Zasady: {context.policy.name}
      </p>
    </>
  );
}
function OpsPage({
  runs,
  health,
  revision,
}: {
  runs: Run[];
  health: Health | null;
  revision: number;
}) {
  const [tab, setTab] = useState("runs");
  const [filter, setFilter] = useState("");
  const ops = useResource<Record<string, unknown>>("/api/ops", revision, 7000);
  const [historyPage, setHistoryPage] = useState(0);
  const history = useResource<{ runs: Run[] }>(
    historyPage > 0 ? `/api/runs?limit=50&offset=${historyPage * 50}` : null,
    revision,
  );
  const pageRuns = historyPage > 0 ? (history.data?.runs ?? []) : runs;
  const visible = pageRuns.filter((run) => !filter || run.status === filter);
  const telemetry = ops.data?.telemetry as
    | {
        mode: string;
        metricsState: string;
        grafanaUrl?: string | null;
        exporter?: {
          status?: "waiting" | "ready" | "unavailable";
          exportedSpans: number;
          failedBatches: number;
          lastSuccessAt: string | null;
        } | null;
      }
    | undefined;
  const grafanaUrl =
    telemetry?.grafanaUrl &&
    /^http:\/\/127\.0\.0\.1:15[34]00$/.test(telemetry.grafanaUrl)
      ? telemetry.grafanaUrl
      : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PRZEJRZYSTOŚĆ DZIAŁANIA</span>
          <h1>Wykonania i stan systemu</h1>
          <p>Sprawdź postęp, przyczynę blokady i ślad każdej decyzji.</p>
        </div>
        {health && <Badge status={health.status} />}
      </div>
      <div className="tabs" role="tablist" aria-label="Obserwowalność">
        <button
          role="tab"
          aria-selected={tab === "runs"}
          className={tab === "runs" ? "active" : ""}
          onClick={() => setTab("runs")}
        >
          Wykonania
        </button>
        <button
          role="tab"
          aria-selected={tab === "diagnostics"}
          className={tab === "diagnostics" ? "active" : ""}
          onClick={() => setTab("diagnostics")}
        >
          Diagnostyka
        </button>
      </div>
      {tab === "runs" ? (
        <section className="card">
          <div className="card-heading">
            <h2>Historia pracy</h2>
            <select
              aria-label="Filtruj wykonania"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="">Wszystkie stany</option>
              {[...new Set(pageRuns.map((run) => run.status))].map((status) => (
                <option key={status} value={status}>
                  {status.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </div>
          {history.error && <Notice tone="error">{history.error}</Notice>}
          {historyPage > 0 && history.loading ? (
            <Loading />
          ) : (
            <RunList runs={visible} />
          )}
          <div className="history-pagination">
            <button
              className="button secondary"
              disabled={historyPage === 0 || history.loading}
              onClick={() => {
                setHistoryPage((page) => Math.max(0, page - 1));
                setFilter("");
              }}
            >
              <Icon name="back" size={15} />
              Nowsze
            </button>
            <span className="small muted">Strona {historyPage + 1}</span>
            <button
              className="button secondary"
              disabled={
                pageRuns.length < 50 || history.loading || !!history.error
              }
              onClick={() => {
                setHistoryPage((page) => page + 1);
                setFilter("");
              }}
            >
              Starsze
              <Icon name="arrow" size={15} />
            </button>
          </div>
          <p className="small muted">
            Widok obejmuje do 50 wykonań dla bieżącej organizacji. Filtr statusu
            dotyczy wyświetlonej strony.
          </p>
        </section>
      ) : (
        <>
          {ops.error && <Notice tone="error">{ops.error}</Notice>}
          {telemetry && (
            <section className="card diagnostics-summary">
              <div className="card-heading">
                <h2>Metryki, logi i ślady</h2>
                {grafanaUrl && (
                  <a
                    className="button secondary"
                    href={`${grafanaUrl}/d/jarvis-${grafanaUrl.endsWith("15300") ? "lab" : "operational"}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Otwórz Grafanę
                  </a>
                )}
              </div>
              {telemetry.mode === "local-oss" ? (
                <>
                  <p>
                    Połączenie z kolektorem:{" "}
                    {telemetry.exporter?.status === "ready"
                      ? "aktywne"
                      : telemetry.exporter?.status === "unavailable"
                        ? "niedostępne — JARVIS kontynuuje pracę"
                        : "oczekiwanie na pierwszy eksport"}
                    .
                  </p>
                  <p>
                    Lokalna Grafana zbiera technologię, procesy i użycie modelu.
                    Panel wymaga osobnego konta administratora instalacji.
                  </p>
                  <p className="small muted">
                    Eksporter metryk:{" "}
                    {telemetry.metricsState === "ready"
                      ? "aktywny"
                      : "niedostępny"}
                    . Wysłane ślady: {telemetry.exporter?.exportedSpans ?? 0}.
                    Nieudane wysyłki: {telemetry.exporter?.failedBatches ?? 0}.
                  </p>
                  <p className="small muted">
                    Ostatni potwierdzony eksport:{" "}
                    {telemetry.exporter?.lastSuccessAt
                      ? new Date(
                          telemetry.exporter.lastSuccessAt,
                        ).toLocaleString("pl-PL")
                      : "brak potwierdzenia"}
                    . Stan eksportera nie potwierdza gotowości magazynów ani
                    panelu.
                  </p>
                </>
              ) : (
                <p>
                  Eksport do lokalnego stosu diagnostycznego jest wyłączony.
                  Historia wykonań i audyt są dostępne w JARVIS.
                </p>
              )}
            </section>
          )}
          {ops.loading && !ops.data ? (
            <Loading />
          ) : (
            <div className="diagnostics-grid">
              {ops.data &&
                Object.entries(ops.data)
                  .filter(([key]) => key !== "telemetry")
                  .map(([key, value]) => (
                    <section className="card" key={key}>
                      <div className="card-heading">
                        <h2>
                          {(
                            {
                              modelUsage: "Model i koszt",
                              health: "Stan usług",
                              worker: "Praca silnika",
                              runs: "Wykonania",
                              counts: "Podsumowanie",
                              queue: "Kolejka",
                              storage: "Przechowywanie danych",
                              version: "Wersja systemu",
                              audit: "Audyt",
                              errors: "Błędy",
                              metrics: "Metryki",
                              backups: "Kopie zapasowe",
                              jobs: "Zadania w tle",
                            } as Record<string, string>
                          )[key] ?? key}
                        </h2>
                      </div>
                      {value != null && typeof value === "object" ? (
                        <JsonView value={value} />
                      ) : (
                        <p className="diagnostic-value">
                          {displayValue(value)}
                        </p>
                      )}
                    </section>
                  ))}
            </div>
          )}
        </>
      )}
      <p className="workspace-footnote">
        Wersja źródeł:{" "}
        <code>{health?.version ?? "Nie udało się odczytać wersji"}</code>
      </p>
    </>
  );
}
function SettingsPage({
  context,
  health,
  onLogout,
}: {
  context: Context;
  health: Health | null;
  onLogout: () => void;
}) {
  const voice = useResource<{ available: boolean; reason?: string }>(
    "/api/voice/status",
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TWOJA INSTALACJA</span>
          <h1>Ustawienia i dostęp</h1>
          <p>Sprawdź tożsamość, dostępne możliwości i sposób pracy JARVIS.</p>
        </div>
      </div>
      <CompanySettings context={context} />
      <div className="settings-grid">
        <section className="card">
          <div className="card-heading">
            <h2>Tożsamość i organizacja</h2>
            <Icon name="people" />
          </div>
          <dl className="data-grid">
            <div>
              <dt>Użytkownik</dt>
              <dd>
                {context.principal.displayName ??
                  context.principal.name ??
                  context.principal.id}
              </dd>
            </div>
            <div>
              <dt>Organizacja</dt>
              <dd>{context.principal.tenantId}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>
                {context.principal.roles
                  .map(
                    (role) =>
                      ({
                        operator: "Operator",
                        approver: "Zatwierdzający",
                        viewer: "Obserwator",
                      })[role] ?? role,
                  )
                  .join(", ")}
              </dd>
            </div>
            <div>
              <dt>Tryb dostępu</dt>
              <dd>
                {{
                  local: "Laboratorium bez logowania",
                  accounts: "Konta lokalne",
                  authenticated: "Token dostępu",
                }[context.mode] ?? context.mode}
              </dd>
            </div>
          </dl>
          {context.mode !== "local" && (
            <button className="button secondary" onClick={onLogout}>
              <Icon name="logout" size={17} />
              Wyloguj się
            </button>
          )}
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>Asystent i głos</h2>
            <Icon name="chat" />
          </div>
          <dl className="data-grid">
            <div>
              <dt>Planer</dt>
              <dd>{context.planner.kind}</dd>
            </div>
            <div>
              <dt>Dyktowanie</dt>
              <dd>
                {voice.data
                  ? voice.data.available
                    ? "Dostępne"
                    : "Nieaktywne"
                  : "Stan niedostępny"}
              </dd>
            </div>
          </dl>
          {voice.data?.reason && (
            <p className="small muted">{voice.data.reason}</p>
          )}
          <Notice>
            Dyktowanie przygotowuje tekst wiadomości. Możesz go sprawdzić przed
            wysłaniem.
          </Notice>
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>Zasady działania</h2>
            <Icon name="shield" />
          </div>
          <dl className="data-grid">
            <div>
              <dt>Konfiguracja</dt>
              <dd>{context.policy.name}</dd>
            </div>
            <div>
              <dt>Wersja</dt>
              <dd>{context.policy.version}</dd>
            </div>
            <div>
              <dt>Dostępne narzędzia</dt>
              <dd>{context.tools.length}</dd>
            </div>
          </dl>
          <p className="muted">
            Uprawnienia są sprawdzane przy każdej operacji. Zgoda jest związana
            z konkretnym zakresem zmiany.
          </p>
          <details className="technical-details">
            <summary>Katalog dostępnych narzędzi</summary>
            <ul className="tool-list">
              {context.tools.map((tool) => (
                <li key={tool.id}>
                  <code>{tool.id}</code>
                  <span>{tool.description}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
        <section className="card">
          <div className="card-heading">
            <h2>Stan instalacji</h2>
            <Icon name="pulse" />
          </div>
          {health ? (
            <Badge status={health.status} />
          ) : (
            <p className="muted">Stan jest niedostępny.</p>
          )}
          <p className="small muted">Wersja źródeł</p>
          <code className="wrap-code">{health?.version ?? "—"}</code>
          <button
            className="text-button section-link"
            onClick={() => navigate("ops")}
          >
            Otwórz diagnostykę
            <Icon name="arrow" size={16} />
          </button>
        </section>
      </div>
    </>
  );
}

function Shell({
  context,
  health,
  onRefresh,
  onLogout,
}: {
  context: Context;
  health: Health | null;
  onRefresh: () => Promise<void>;
  onLogout: () => void;
}) {
  const route = useRoute();
  const [mobileMenu, setMobileMenu] = useState(false);
  const [revision, setRevision] = useState(0);
  const workspace = useResource<Workspace>("/api/workspace", revision, 7000);
  const runResource = useResource<{ runs: Run[] }>("/api/runs", revision, 4500);
  const catalog = workspace.data?.catalog ?? [];
  const [page, sub, entityId] = route.split("/");
  const module =
    page === "module" ? catalog.find((item) => item.id === sub) : null;
  useEffect(() => {
    setMobileMenu(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [route]);
  const nav = (path: string, label: string, icon: string, badge?: number) => (
    <button
      key={path}
      className={`nav-link ${route === path || (path !== "overview" && route.startsWith(`${path}/`)) ? "active" : ""}`}
      onClick={() => navigate(path)}
    >
      <Icon name={icon} size={19} />
      <span>{label}</span>
      {!!badge && <span className="nav-count">{badge}</span>}
    </button>
  );
  const activeLabel =
    module?.label ??
    (
      {
        overview: "Przegląd",
        conversation: "Rozmowa",
        ops: "Obserwowalność",
        settings: "Ustawienia",
        runs: "Wykonanie",
      } as Record<string, string>
    )[page ?? ""] ??
    "Przestrzeń pracy";
  let content: ReactNode;
  if (page === "conversation")
    content = <ConversationPage selectedId={sub} context={context} />;
  else if (page === "runs" && sub)
    content = <RunPage id={sub} context={context} />;
  else if (page === "module" && module)
    content = (
      <WorkspacePage
        key={`${module.id}/${entityId ?? ""}`}
        module={module}
        entityId={entityId}
        context={context}
        revision={revision}
      />
    );
  else if (page === "module")
    content = workspace.loading ? (
      <Loading />
    ) : (
      <Notice tone="error">
        {workspace.error ||
          "Ten moduł nie jest dostępny dla Twojej tożsamości."}
      </Notice>
    );
  else if (page === "ops")
    content = (
      <OpsPage
        runs={runResource.data?.runs ?? []}
        health={health}
        revision={revision}
      />
    );
  else if (page === "settings")
    content = (
      <SettingsPage context={context} health={health} onLogout={onLogout} />
    );
  else
    content = (
      <Overview
        workspace={workspace.data}
        workspaceError={workspace.error}
        runsLoaded={runResource.data !== null && !runResource.error}
        runs={runResource.data?.runs ?? []}
        context={context}
      />
    );
  return (
    <div className="app-shell">
      {mobileMenu && (
        <button
          className="sidebar-backdrop"
          aria-label="Zamknij menu"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="JARVIS — przegląd"
        >
          <span className="brand-mark">J</span>
          <span>
            JARVIS<small>CENTRUM OPERACYJNE</small>
          </span>
        </button>
        <div className="workspace-tag">
          <span className="live-dot" />
          <span>{context.principal.tenantId}</span>
          <span className="local-tag">
            {context.mode === "local" ? "LAB" : "LOKALNIE"}
          </span>
        </div>
        <nav aria-label="Nawigacja główna">
          <div className="nav-section">PRZESTRZEŃ</div>
          {nav("overview", "Przegląd", "grid")}
          {nav("conversation", "Rozmowa z JARVIS", "chat")}
          {catalog.some((item) => item.id === "cases") &&
            nav(
              "module/cases",
              "Sprawy",
              "cases",
              workspace.data?.summary.openCases,
            )}
          <div className="nav-section spaced">OBSZARY PRACY</div>
          {catalog
            .filter((item) => item.id !== "cases")
            .map((item) => nav(`module/${item.id}`, item.label, item.id))}
          {workspace.error && (
            <span className="nav-error">Nie udało się pobrać modułów.</span>
          )}
        </nav>
        <div className="sidebar-bottom">
          {nav("ops", "Obserwowalność", "pulse")}
          {nav("settings", "Ustawienia", "settings")}
          <div className="identity">
            <span className="avatar">
              {(
                context.principal.displayName ??
                context.principal.name ??
                context.principal.id
              )
                .slice(0, 1)
                .toUpperCase()}
            </span>
            <span>
              <strong>
                {context.principal.displayName ??
                  context.principal.name ??
                  context.principal.id}
              </strong>
              <small>
                {context.principal.roles.includes("operator")
                  ? "Operator przestrzeni"
                  : "Użytkownik przestrzeni"}
              </small>
            </span>
            {context.mode !== "local" && (
              <button
                className="icon-button"
                title="Wyloguj"
                aria-label="Wyloguj"
                onClick={onLogout}
              >
                <Icon name="logout" size={17} />
              </button>
            )}
          </div>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Otwórz menu"
              aria-expanded={mobileMenu}
              onClick={() => setMobileMenu(true)}
            >
              <Icon name="menu" />
            </button>
            <span className="breadcrumb-root">Przestrzeń operacyjna</span>
            <Icon name="chevron" size={13} />
            <strong>{activeLabel}</strong>
          </div>
          <div className="topbar-right">
            <span className="today">
              {new Intl.DateTimeFormat("pl-PL", {
                day: "numeric",
                month: "long",
                year: "numeric",
              }).format(new Date())}
            </span>
            <button
              className="icon-button"
              title="Odśwież dane"
              aria-label="Odśwież dane"
              onClick={() => {
                setRevision((value) => value + 1);
                void onRefresh();
              }}
            >
              <Icon name="refresh" size={18} />
            </button>
            <span
              className={`health-indicator ${health?.status === "healthy" ? "good" : ""}`}
              title={
                health?.status === "healthy"
                  ? "System działa poprawnie"
                  : "Stan systemu niepotwierdzony"
              }
            >
              <span />
              {health?.status === "healthy" ? "System gotowy" : "Sprawdź stan"}
            </span>
          </div>
        </header>
        <main
          id="main"
          className={`page-content ${page === "conversation" ? "conversation-page" : ""}`}
        >
          {runResource.error && (
            <Notice tone="error">{runResource.error}</Notice>
          )}
          {content}
        </main>
        <footer className="app-footer">
          <span>JARVIS · Twoje sprawy, pod kontrolą</span>
          <span>
            {context.mode === "local"
              ? "Laboratorium · dane testowe"
              : "Instalacja lokalna"}
          </span>
        </footer>
      </div>
    </div>
  );
}

export function App() {
  const [context, setContext] = useState<Context | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const boot = useCallback(async () => {
    const results = await Promise.allSettled([
      api<AuthStatus>("/api/auth/status"),
      api<Health>("/api/health"),
    ]);
    if (results[0].status === "fulfilled") setAuth(results[0].value);
    if (results[1].status === "fulfilled") setHealth(results[1].value);
    else setHealth(null);
    try {
      setContext(await api<Context>("/api/context"));
      setError("");
    } catch (cause) {
      setContext(null);
      setError(
        cause instanceof ApiError && cause.status === 401
          ? ""
          : errorMessage(cause),
      );
      throw cause;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void boot().catch(() => {});
  }, [boot]);
  async function logout() {
    if (context?.mode === "accounts")
      await post("/api/auth/logout").catch(() => {});
    setBearerToken("");
    setContext(null);
    await boot().catch(() => {});
  }
  if (loading)
    return (
      <div className="boot-screen">
        <span className="brand-mark">J</span>
        <Loading />
      </div>
    );
  if (!context) return <Login status={auth} onSuccess={boot} error={error} />;
  return (
    <Shell
      context={context}
      health={health}
      onRefresh={() => boot().catch(() => {})}
      onLogout={() => void logout()}
    />
  );
}
