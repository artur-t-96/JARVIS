import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Badge, Empty, Icon, Loading, Notice, Sheet } from "./ui";
import {
  OnboardingVariantsEditor,
  OnboardingVariantsSummary,
} from "./OnboardingVariants";
import type {
  OnboardingVariant,
  OnboardingVariants,
} from "../../src/onboarding-profile";
import {
  EmploymentPolicyEditor,
  safeEmploymentPolicy,
  type EmploymentPolicy,
} from "./EmploymentPolicyEditor";

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
  kind?: "information" | "decision" | "work" | "attestation";
  assigneeRole?: "hr" | "it" | "manager";
  requirementKeys?: string[];
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
  onboardingVariants?: OnboardingVariants;
  roleBindings?: { hr?: string; it?: string; manager?: string };
  employmentPolicy?: EmploymentPolicy;
  updatedAt: string | null;
  updatedBy: string | null;
};
type CompanyTemplate = {
  id: "internal" | "contractor";
  label: string;
  processTemplates: CompanyProfile["processTemplates"];
  onboardingVariant?: OnboardingVariant;
};
export function applyCompanyTemplate(
  profile: CompanyProfile,
  template: CompanyTemplate,
): CompanyProfile {
  if (profile.onboardingVariants) {
    if (!template.onboardingVariant)
      throw new Error("Brak typowanego wariantu onboardingu.");
    return {
      ...profile,
      onboardingVariants: {
        ...profile.onboardingVariants,
        [template.id]: structuredClone(template.onboardingVariant),
      },
    };
  }
  return {
    ...profile,
    processTemplates: structuredClone(template.processTemplates),
  };
}
export function applyOnboardingBaselines(
  profile: CompanyProfile,
  templates: CompanyTemplate[],
): CompanyProfile {
  const internal = templates.find(
    (t) => t.id === "internal",
  )?.onboardingVariant;
  const contractor = templates.find(
    (t) => t.id === "contractor",
  )?.onboardingVariant;
  if (!internal || !contractor)
    throw new Error("Brak dwóch bazowych wariantów onboardingu.");
  return {
    ...profile,
    onboardingVariants: structuredClone({ internal, contractor }),
  };
}
export function companyProfileInput(
  profile: CompanyProfile,
  expectedVersion: number,
) {
  const {
    companyName,
    timezone,
    licenseReminderDays,
    quietHours,
    rules,
    roleBindings,
  } = profile;
  return {
    expectedVersion,
    companyName,
    timezone,
    licenseReminderDays,
    quietHours,
    rules,
    roleBindings: roleBindings ?? {},
    employmentPolicy: { ...(profile.employmentPolicy ?? safeEmploymentPolicy) },
    ...(profile.onboardingVariants
      ? { onboardingVariants: structuredClone(profile.onboardingVariants) }
      : {}),
    processTemplates: {
      onboarding: profile.processTemplates.onboarding.map((task) => ({
        ...task,
        requirementKeys: task.requirementKeys ?? [],
      })),
      offboarding: profile.processTemplates.offboarding.map((task) => ({
        ...task,
        requirementKeys: task.requirementKeys ?? [],
      })),
    },
  };
}
const ruleLabels: Record<string, string> = {
  overdue_case: "Sprawy po terminie",
  overdue_task: "Zadania po terminie",
  expired_reservation: "Wygasłe rezerwacje sprzętu",
  license_expiry: "Zbliżający się koniec licencji",
  high_severity_incident: "Pilne incydenty IT",
};
const responsibilityLabels = { hr: "HR", it: "IT", manager: "Przełożony" };
const taskKindLabels = {
  information: "Uzupełnienie danych",
  decision: "Decyzja człowieka",
  work: "Praca człowieka",
  attestation: "Poświadczenie",
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
  const directory = useResource<{ assignees: { id: string; label: string }[] }>(
    allowed ? "/api/company/assignees" : null,
  );
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
          <h3>Zasady współpracy</h3>
          <p>
            {profile.employmentPolicy?.mode === "parallel_projects"
              ? `Równoległe projekty konsultanta: do ${profile.employmentPolicy.maxConcurrent} otwartych współprac.`
              : "Jedna otwarta współpraca jednej osoby."}{" "}
            Współpraca wewnętrzna nie może nakładać się na inną.
          </p>
          <h3>Odpowiedzialność za proces</h3>
          <dl className="data-grid">
            {Object.entries(responsibilityLabels).map(([role, label]) => {
              const id =
                profile.roleBindings?.[
                  role as keyof typeof responsibilityLabels
                ];
              return (
                <div key={role}>
                  <dt>{label}</dt>
                  <dd>
                    {id
                      ? (directory.data?.assignees.find(
                          (entry) => entry.id === id,
                        )?.label ?? "Przypisane konto · szczegóły niedostępne")
                      : "Brak przypisanej osoby"}
                  </dd>
                </div>
              );
            })}
          </dl>
          {directory.error && (
            <p className="small muted">
              Nie udało się potwierdzić aktualnej obsady ról.
            </p>
          )}
          <details className="technical-details">
            <summary>Szablony onboardingu i offboardingu</summary>
            {profile.onboardingVariants && (
              <OnboardingVariantsSummary
                variants={profile.onboardingVariants}
              />
            )}
            {(["onboarding", "offboarding"] as const)
              .filter(
                (kind) => kind !== "onboarding" || !profile.onboardingVariants,
              )
              .map((kind) => (
                <div key={kind}>
                  <h3>
                    {kind === "onboarding" ? "Onboarding" : "Offboarding"}
                  </h3>
                  <ol>
                    {profile.processTemplates[kind].map((task) => (
                      <li key={task.key}>
                        {task.title} ·{" "}
                        {task.required ? "wymagane" : "opcjonalne"} ·{" "}
                        {task.offsetDays} dni od daty procesu
                        {task.assigneeRole
                          ? ` · ${responsibilityLabels[task.assigneeRole]}`
                          : " · brak roli wykonawcy"}
                        {task.kind ? ` · ${taskKindLabels[task.kind]}` : ""}
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
            <ProfileForm
              profile={profile}
              canReadIT={
                !!context.principal.scopes?.some((s) => s === "*" || s === "it")
              }
              onClose={() => setEditing(false)}
            />
          )}
        </>
      )}
    </section>
  );
}

function ProfileForm({
  profile,
  onClose,
  canReadIT,
}: {
  profile: CompanyProfile;
  onClose: () => void;
  canReadIT: boolean;
}) {
  const [values, setValues] = useState(() => structuredClone(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(requestKey);
  const directory = useResource<{ assignees: { id: string; label: string }[] }>(
    "/api/company/assignees",
  );
  const templates = useResource<{ templates: CompanyTemplate[] }>(
    "/api/company/templates",
  );
  const [templateId, setTemplateId] = useState("");
  const [templateNotice, setTemplateNotice] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await post<{ run: Run }>("/api/commands", {
        toolId: "initiatives.configure",
        input: companyProfileInput(values, profile.version),
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
          <EmploymentPolicyEditor
            value={values.employmentPolicy ?? safeEmploymentPolicy}
            disabled={busy}
            onChange={(employmentPolicy) =>
              setValues((current) => ({ ...current, employmentPolicy }))
            }
          />
          <h3>Osoby odpowiedzialne</h3>
          <p className="small muted">
            Konto wskazuje wykonawcę roli. Nie nadaje mu dodatkowych uprawnień.
            Brak obsady pozostawi zadania nieprzypisane.
          </p>
          {directory.error && <Notice tone="error">{directory.error}</Notice>}
          <div className="form-grid">
            {Object.entries(responsibilityLabels).map(([role, label]) => {
              const key = role as keyof typeof responsibilityLabels;
              const selected = values.roleBindings?.[key] ?? "";
              return (
                <label className="field" key={role}>
                  <span>{label}</span>
                  <select
                    disabled={busy || directory.loading || !!directory.error}
                    value={selected}
                    onChange={(event) =>
                      setValues((current) => {
                        const roleBindings = { ...current.roleBindings };
                        if (event.target.value)
                          roleBindings[key] = event.target.value;
                        else delete roleBindings[key];
                        return { ...current, roleBindings };
                      })
                    }
                  >
                    <option value="">Bez przypisania</option>
                    {selected &&
                      !directory.data?.assignees.some(
                        (entry) => entry.id === selected,
                      ) && (
                        <option value={selected}>
                          Dotychczasowe konto · dostępność niepotwierdzona
                        </option>
                      )}
                    {directory.data?.assignees.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
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
          <h3>Bazowy wariant procesu</h3>
          <p className="small muted">
            {values.onboardingVariants
              ? "Wczytanie zastąpi wyłącznie wybrany wariant onboardingu w formularzu."
              : "Profil korzysta ze wspólnego szablonu. Możesz wczytać dwa osobne warianty onboardingu z wymaganiami i terminami."}{" "}
            Zapisany profil firmy zmieni się dopiero po zatwierdzeniu operacji.
          </p>
          {templates.error && <Notice tone="error">{templates.error}</Notice>}
          {!values.onboardingVariants && (
            <button
              type="button"
              className="button secondary"
              disabled={busy || !templates.data || !!templates.error}
              onClick={() => {
                try {
                  setValues(
                    applyOnboardingBaselines(
                      values,
                      templates.data?.templates ?? [],
                    ),
                  );
                  setTemplateNotice(
                    "Wczytano dwa bazowe warianty onboardingu. Sprawdź wymagania i terminy obu rodzajów współpracy. Offboarding i zapisane sprawy zachowają swój zakres.",
                  );
                } catch (cause) {
                  setError(errorMessage(cause));
                }
              }}
            >
              Wczytaj dwa warianty onboardingu
            </button>
          )}
          <div className="task-filters">
            <label className="field">
              <span>Wariant</span>
              <select
                disabled={busy || templates.loading || !!templates.error}
                value={templateId}
                onChange={(event) => setTemplateId(event.target.value)}
              >
                <option value="">Wybierz wariant…</option>
                {templates.data?.templates.map((template) => (
                  <option value={template.id} key={template.id}>
                    {template.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={busy || !templateId || !!templates.error}
              onClick={() => {
                const template = templates.data?.templates.find(
                  (candidate) => candidate.id === templateId,
                );
                if (template) {
                  setValues((current) =>
                    applyCompanyTemplate(current, template),
                  );
                  setTemplateNotice(
                    `Wczytano wariant „${template.label}” do formularza. Sprawdź obsadę i terminy przed przygotowaniem zmiany.`,
                  );
                }
              }}
            >
              Wczytaj do formularza
            </button>
          </div>
          {templateNotice && <Notice>{templateNotice}</Notice>}
          {values.onboardingVariants && (
            <OnboardingVariantsEditor
              variants={values.onboardingVariants}
              onChange={(onboardingVariants) =>
                setValues((current) => ({ ...current, onboardingVariants }))
              }
              canReadIT={canReadIT}
              busy={busy}
            />
          )}
          {(["onboarding", "offboarding"] as const)
            .filter(
              (kind) => kind !== "onboarding" || !values.onboardingVariants,
            )
            .map((kind) => (
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
                        <span>Rodzaj zadania</span>
                        <select
                          required
                          disabled={busy}
                          value={task.kind ?? ""}
                          onChange={(event) =>
                            taskChange(kind, index, {
                              kind: event.target.value as TemplateTask["kind"],
                            })
                          }
                        >
                          <option value="">Wybierz rodzaj…</option>
                          {Object.entries(taskKindLabels).map(
                            ([value, label]) => (
                              <option value={value} key={value}>
                                {label}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label className="field">
                        <span>Rola wykonawcy</span>
                        <select
                          required
                          disabled={busy}
                          value={task.assigneeRole ?? ""}
                          onChange={(event) =>
                            taskChange(kind, index, {
                              assigneeRole: event.target
                                .value as TemplateTask["assigneeRole"],
                            })
                          }
                        >
                          <option value="">Wybierz odpowiedzialność…</option>
                          {Object.entries(responsibilityLabels).map(
                            ([value, label]) => (
                              <option value={value} key={value}>
                                {label}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
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
                    {!!task.requirementKeys?.length && (
                      <p className="small muted">
                        Zadanie ma {task.requirementKeys.length} powiązanych
                        warunków odbioru. Zmiana opisu nie usuwa tych wymagań.
                      </p>
                    )}
                    {index > 0 && (
                      <fieldset className="dependency-options">
                        <legend>Wymagane wcześniejsze zadania</legend>
                        {values.processTemplates[kind]
                          .slice(0, index)
                          .map((candidate) => (
                            <label
                              className="checkbox-field"
                              key={candidate.key}
                            >
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
