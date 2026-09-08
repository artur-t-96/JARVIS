import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Badge, Empty, Icon, Loading, Notice, Sheet } from "./ui";

type Initiative = {
  id: string;
  module: string;
  sourceId: string;
  title: string;
  summary: string;
  severity: string;
  status: string;
  version: number;
  dueDate: string | null;
  snoozedUntil: string | null;
  deliveryState: string;
};
type TemplateTask = {
  key: string;
  title: string;
  required: boolean;
  offsetDays: number;
  dependsOn: string[];
};
type CompanyProfile = {
  tenantId: string;
  version: number;
  companyName: string;
  timezone: string;
  licenseReminderDays: number;
  quietHours: { enabled: boolean; start: string; end: string };
  rules: Record<string, boolean>;
  processTemplates: { onboarding: TemplateTask[]; offboarding: TemplateTask[] };
  updatedAt: string | null;
  updatedBy: string | null;
};
const ruleLabels: Record<string, string> = {
  overdue_case: "Sprawy po terminie",
  overdue_task: "Zadania po terminie",
  expired_reservation: "Wygasłe rezerwacje sprzętu",
  license_expiry: "Zbliżający się koniec licencji",
  high_severity_incident: "Pilne incydenty IT",
};

export function Initiatives({ context }: { context: Context }) {
  const canRead =
    context.principal.scopes?.some(
      (scope) => scope === "*" || scope === "initiatives",
    ) ?? true;
  const resource = useResource<{ items: Initiative[] }>(
    canRead ? "/api/initiatives" : null,
    0,
    10000,
  );
  const [filter, setFilter] = useState("open");
  const [selected, setSelected] = useState<{
    item: Initiative;
    action: string;
  } | null>(null);
  if (!canRead) return null;
  const items = (resource.data?.items ?? []).filter(
    (item) => !filter || item.status === filter,
  );
  const allowed = (action: string) =>
    context.principal.roles.includes("operator") &&
    context.tools.some((tool) => tool.id === `initiatives.${action}`);
  return (
    <section className="card initiatives-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">JARVIS ZWRACA UWAGĘ</span>
          <h2>Sprawy, które warto podjąć</h2>
          <p>
            Propozycje wynikające z terminów, zasobów i otwartych incydentów.
          </p>
        </div>
        <select
          aria-label="Stan propozycji"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="open">Aktualne</option>
          <option value="snoozed">Odłożone</option>
          <option value="dismissed">Odrzucone</option>
          <option value="resolved">Rozwiązane</option>
          <option value="">Wszystkie</option>
        </select>
      </div>
      {resource.error ? (
        <Notice tone="error">{resource.error}</Notice>
      ) : resource.loading && !resource.data ? (
        <Loading />
      ) : items.length ? (
        <div className="initiative-list">
          {items.map((item) => (
            <article className="initiative-row" key={item.id}>
              <span className={`initiative-severity ${item.severity}`}>
                <Icon name="alert" size={19} />
              </span>
              <div className="initiative-body">
                <button
                  className="table-link"
                  onClick={() =>
                    navigate(`module/${item.module}/${item.sourceId}`)
                  }
                >
                  {item.title}
                </button>
                <p>{item.summary}</p>
                <div className="heading-meta">
                  <Badge status={item.status} />
                  {item.dueDate && (
                    <span>Termin: {dateLabel(item.dueDate)}</span>
                  )}
                  {item.snoozedUntil && (
                    <span>
                      Odłożone do {dateLabel(item.snoozedUntil, true)}
                    </span>
                  )}
                  {item.deliveryState === "quiet_hours" && (
                    <span>Godziny ciszy</span>
                  )}
                </div>
              </div>
              <div className="initiative-actions">
                {item.status === "open" && (
                  <>
                    {allowed("snooze") && (
                      <button
                        className="text-button"
                        onClick={() => setSelected({ item, action: "snooze" })}
                      >
                        Odłóż
                      </button>
                    )}
                    {allowed("dismiss") && (
                      <button
                        className="text-button"
                        onClick={() => setSelected({ item, action: "dismiss" })}
                      >
                        Odrzuć
                      </button>
                    )}
                  </>
                )}
                {["snoozed", "dismissed"].includes(item.status) &&
                  allowed("resume") && (
                    <button
                      className="text-button"
                      onClick={() => setSelected({ item, action: "resume" })}
                    >
                      Przywróć
                    </button>
                  )}
                <button
                  className="icon-button"
                  aria-label={`Otwórz: ${item.title}`}
                  onClick={() =>
                    navigate(`module/${item.module}/${item.sourceId}`)
                  }
                >
                  <Icon name="chevron" size={17} />
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Empty icon="check" title="Brak propozycji w tym widoku">
          JARVIS sprawdza dostępne dane według zapisanych reguł firmy. Nowe
          propozycje pojawią się, gdy spełnione będą ich warunki.
        </Empty>
      )}
      {selected && (
        <InitiativeForm {...selected} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}

function InitiativeForm({
  item,
  action,
  onClose,
}: {
  item: Initiative;
  action: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(requestKey);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await post<{ run: Run }>("/api/commands", {
        toolId: `initiatives.${action}`,
        input: {
          id: item.id,
          expectedVersion: item.version,
          reason,
          ...(action === "snooze"
            ? { until: new Date(until).toISOString() }
            : {}),
        },
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${response.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title={
        action === "snooze"
          ? "Odłóż propozycję"
          : action === "dismiss"
            ? "Odrzuć propozycję"
            : "Przywróć propozycję"
      }
      subtitle={item.title}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <label className="field">
            <span>Powód decyzji</span>
            <textarea
              required
              maxLength={2000}
              rows={4}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {action === "snooze" && (
            <label className="field">
              <span>Przypomnij po</span>
              <input
                type="datetime-local"
                required
                disabled={busy}
                value={until}
                onChange={(event) => setUntil(event.target.value)}
              />
              <small>Data w strefie czasowej tego komputera.</small>
            </label>
          )}
          <Notice>
            Przygotujesz operację do zatwierdzenia. Dane sprawy źródłowej
            pozostaną bez zmian.
          </Notice>
        </div>
        <div className="sheet-footer">
          <button className="button secondary" type="button" onClick={onClose}>
            Anuluj
          </button>
          <button className="button primary" disabled={busy}>
            Przygotuj operację
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function CompanySettings({ context }: { context: Context }) {
  const allowed =
    context.principal.scopes?.some(
      (scope) => scope === "*" || scope === "company",
    ) ?? true;
  const resource = useResource<{ profile: CompanyProfile }>(
    allowed ? "/api/profile" : null,
  );
  const [editing, setEditing] = useState(false);
  const profile = resource.data?.profile;
  if (!allowed) return null;
  return (
    <section className="card company-profile">
      <div className="card-heading">
        <div>
          <h2>Firma, reguły i sposób pracy</h2>
          <p>Kontekst wspólny dla asystenta i lokalnych procesów.</p>
        </div>
        {profile &&
          context.principal.roles.includes("operator") &&
          context.tools.some((tool) => tool.id === "initiatives.configure") && (
            <button
              className="button secondary"
              onClick={() => setEditing(true)}
            >
              <Icon name="edit" size={16} />
              Edytuj
            </button>
          )}
      </div>
      {resource.error ? (
        <Notice tone="error">{resource.error}</Notice>
      ) : !profile ? (
        <Loading />
      ) : (
        <>
          <dl className="data-grid">
            <div>
              <dt>Firma</dt>
              <dd>{profile.companyName}</dd>
            </div>
            <div>
              <dt>Strefa czasowa</dt>
              <dd>{profile.timezone}</dd>
            </div>
            <div>
              <dt>Przypomnienie o licencji</dt>
              <dd>{profile.licenseReminderDays} dni przed końcem</dd>
            </div>
            <div>
              <dt>Godziny ciszy</dt>
              <dd>
                {profile.quietHours.enabled
                  ? `${profile.quietHours.start}–${profile.quietHours.end}`
                  : "Wyłączone"}
              </dd>
            </div>
          </dl>
          <div className="profile-rules">
            {Object.entries(profile.rules).map(([key, enabled]) => (
              <span key={key} className={enabled ? "enabled" : ""}>
                <Icon name={enabled ? "check" : "cancel"} size={14} />
                {ruleLabels[key] ?? key}
              </span>
            ))}
          </div>
          <details className="technical-details">
            <summary>Szablony onboardingu i offboardingu</summary>
            {(["onboarding", "offboarding"] as const).map((kind) => (
              <div key={kind}>
                <h3>{kind === "onboarding" ? "Onboarding" : "Offboarding"}</h3>
                <ol>
                  {profile.processTemplates[kind].map((task) => (
                    <li key={task.key}>
                      {task.title} · {task.required ? "wymagane" : "opcjonalne"}{" "}
                      · {task.offsetDays} dni od daty procesu
                      {task.dependsOn.length
                        ? ` · po: ${task.dependsOn.map((key) => profile.processTemplates[kind].find((item) => item.key === key)?.title ?? key).join(", ")}`
                        : ""}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </details>
          <p className="small muted">
            Wersja ustawień: {profile.version}
            {profile.updatedAt
              ? ` · ${dateLabel(profile.updatedAt, true)}`
              : " · ustawienia początkowe"}
          </p>
          {editing && (
            <ProfileForm profile={profile} onClose={() => setEditing(false)} />
          )}
        </>
      )}
    </section>
  );
}

function ProfileForm({
  profile,
  onClose,
}: {
  profile: CompanyProfile;
  onClose: () => void;
}) {
  const [values, setValues] = useState(() => structuredClone(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(requestKey);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const {
        companyName,
        timezone,
        licenseReminderDays,
        quietHours,
        rules,
        processTemplates,
      } = values;
      const response = await post<{ run: Run }>("/api/commands", {
        toolId: "initiatives.configure",
        input: {
          expectedVersion: profile.version,
          companyName,
          timezone,
          licenseReminderDays,
          quietHours,
          rules,
          processTemplates,
        },
        idempotencyKey: key,
      });
      onClose();
      navigate(`runs/${response.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function taskChange(
    kind: "onboarding" | "offboarding",
    index: number,
    patch: Partial<TemplateTask>,
  ) {
    setValues((current) => ({
      ...current,
      processTemplates: {
        ...current.processTemplates,
        [kind]: current.processTemplates[kind].map((task, position) =>
          position === index ? { ...task, ...patch } : task,
        ),
      },
    }));
  }
  return (
    <Sheet
      title="Kontekst i reguły firmy"
      subtitle={`Wersja ${profile.version}`}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <div className="form-grid">
            <label className="field">
              <span>Nazwa firmy</span>
              <input
                required
                maxLength={160}
                value={values.companyName}
                onChange={(event) =>
                  setValues({ ...values, companyName: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Strefa czasowa</span>
              <input
                required
                value={values.timezone}
                onChange={(event) =>
                  setValues({ ...values, timezone: event.target.value })
                }
              />
            </label>
            <label className="field wide">
              <span>Przypomnij o licencji — ile dni wcześniej</span>
              <input
                type="number"
                required
                min={0}
                max={365}
                value={values.licenseReminderDays}
                onChange={(event) =>
                  setValues({
                    ...values,
                    licenseReminderDays: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="checkbox-field wide">
              <input
                type="checkbox"
                checked={values.quietHours.enabled}
                onChange={(event) =>
                  setValues({
                    ...values,
                    quietHours: {
                      ...values.quietHours,
                      enabled: event.target.checked,
                    },
                  })
                }
              />
              Włącz godziny ciszy
            </label>
            <label className="field">
              <span>Cisza od</span>
              <input
                type="time"
                required
                value={values.quietHours.start}
                onChange={(event) =>
                  setValues({
                    ...values,
                    quietHours: {
                      ...values.quietHours,
                      start: event.target.value,
                    },
                  })
                }
              />
            </label>
            <label className="field">
              <span>Cisza do</span>
              <input
                type="time"
                required
                value={values.quietHours.end}
                onChange={(event) =>
                  setValues({
                    ...values,
                    quietHours: {
                      ...values.quietHours,
                      end: event.target.value,
                    },
                  })
                }
              />
            </label>
          </div>
          <h3>Aktywne reguły</h3>
          <div className="profile-rule-inputs">
            {Object.entries(values.rules).map(([key, checked]) => (
              <label className="checkbox-field" key={key}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) =>
                    setValues({
                      ...values,
                      rules: { ...values.rules, [key]: event.target.checked },
                    })
                  }
                />
                {ruleLabels[key] ?? key}
              </label>
            ))}
          </div>
          {(["onboarding", "offboarding"] as const).map((kind) => (
            <details className="template-editor" key={kind}>
              <summary>
                {kind === "onboarding"
                  ? "Szablon onboardingu"
                  : "Szablon offboardingu"}
              </summary>
              {values.processTemplates[kind].map((task, index) => (
                <div className="nested-entry" key={task.key}>
                  <label className="field">
                    <span>Zadanie {index + 1}</span>
                    <input
                      required
                      maxLength={200}
                      value={task.title}
                      onChange={(event) =>
                        taskChange(kind, index, { title: event.target.value })
                      }
                    />
                  </label>
                  <div className="form-grid">
                    <label className="field">
                      <span>Dni od daty procesu</span>
                      <input
                        type="number"
                        required
                        min={-365}
                        max={365}
                        value={task.offsetDays}
                        onChange={(event) =>
                          taskChange(kind, index, {
                            offsetDays: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={task.required}
                        onChange={(event) =>
                          taskChange(kind, index, {
                            required: event.target.checked,
                          })
                        }
                      />
                      Wymagane do odbioru
                    </label>
                  </div>
                  {index > 0 && (
                    <fieldset className="dependency-options">
                      <legend>Wymagane wcześniejsze zadania</legend>
                      {values.processTemplates[kind]
                        .slice(0, index)
                        .map((candidate) => (
                          <label className="checkbox-field" key={candidate.key}>
                            <input
                              type="checkbox"
                              checked={task.dependsOn.includes(candidate.key)}
                              onChange={(event) =>
                                taskChange(kind, index, {
                                  dependsOn: event.target.checked
                                    ? [...task.dependsOn, candidate.key]
                                    : task.dependsOn.filter(
                                        (key) => key !== candidate.key,
                                      ),
                                })
                              }
                            />
                            {candidate.title}
                          </label>
                        ))}
                    </fieldset>
                  )}
                </div>
              ))}
            </details>
          ))}
          <Notice>
            Nowy profil zacznie działać po zatwierdzeniu operacji. Zmiana
            szablonu dotyczy nowych procesów; istniejące sprawy zachowują swój
            zakres.
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
          <button className="button primary" disabled={busy}>
            Przygotuj zmianę
          </button>
        </div>
      </form>
    </Sheet>
  );
}
