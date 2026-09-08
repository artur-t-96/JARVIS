import { useCallback, useEffect, useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import {
  dateLabel,
  displayValue,
  statusLabel,
  type Context,
  type Entity,
  type Field,
  type ModuleDefinition,
  type Run,
} from "./types";
import { Badge, Empty, Icon, Loading, Notice, Sheet } from "./ui";
import {
  optionLabel,
  referenceModule,
  referenceLabel,
  referenceOptions,
  useReferences,
} from "./references";
import { EntityContent, RecordDownload } from "./EntityContent";
import { LaboratoryPanel } from "./LaboratoryPanel";
import { DocumentTemplate } from "./DocumentTemplate";
import { DocumentReadiness, DocumentRevision } from "./DocumentReadiness";
import { DocumentFiles } from "./DocumentFiles";
import { CaseReadiness } from "./CaseReadiness";
import { Onboarding, PersonOnboardings } from "./Onboarding";
import { HumanTasks } from "./HumanTasks";
import { CaseAccess } from "./CaseAccess";
import { AccessDefinitions, isAccessDefinition } from "./AccessDefinitions";
import {
  AllocationSelect,
  allocationActions,
  allocationSelection,
  type CustodyAllocation,
} from "./AssetCustody";
import {
  RequirementEditor,
  cloneRequirementDefinitions,
  type RequirementDefinition,
} from "./RequirementEditor";
import { EngagementSelect } from "./EngagementSelect";
import {
  EmploymentPeriodSelect,
  employmentPeriodLabel,
  useEmploymentPeriods,
} from "./EmploymentPeriodSelect";
import {
  availableEmploymentPeriods,
  changeCommandField,
  employmentCaseOptions,
  employmentPersonId,
  requiresEmploymentPeriod,
  selectedEmploymentInput,
} from "./employment-periods";

type FormSpec = {
  title: string;
  action: string;
  fields: Field[];
  entity?: Entity;
  dataForm: boolean;
  initialValues?: Record<string, unknown>;
};
const actionFields = (
  module: ModuleDefinition,
  action: ModuleDefinition["actions"][number],
) =>
  (action.fields ?? []).filter(
    (field) =>
      !(
        module.id === "assets" &&
        action.id === "replaceReservation" &&
        [
          "personId",
          "employmentEpisodeId",
          "expectedEpisodeVersion",
          "caseId",
          "reservedUntil",
          "expiresAt",
          "reservationTimezone",
          "reservationProfileVersion",
          "profileVersion",
          "expectedReplacementVersion",
          "expectedCaseVersion",
          "expectedScopeRevision",
        ].includes(field.key)
      ) &&
      !(
        module.id === "cases" &&
        action.id === "addTask" &&
        ["assigneeId", "assigneePrincipalId"].includes(field.key)
      ),
  );
function CommandForm({
  module,
  spec,
  onClose,
}: {
  module: ModuleDefinition;
  spec: FormSpec;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...(spec.dataForm ? spec.entity?.data : {}),
    title: spec.dataForm ? (spec.entity?.title ?? "") : "",
    ...spec.initialValues,
  }));
  const editRequirements = module.id === "cases" && spec.action === "revise";
  const definitions = useResource<{
    readiness: { definitions?: RequirementDefinition[] };
  }>(
    editRequirements && spec.entity
      ? `/api/cases/${encodeURIComponent(spec.entity.id)}/readiness`
      : null,
  );
  const [requirementsEdited, setRequirementsEdited] = useState(false);
  useEffect(() => {
    if (!editRequirements || requirementsEdited) return;
    const loaded = cloneRequirementDefinitions(
      definitions.data?.readiness.definitions,
    );
    if (loaded) setValues((current) => ({ ...current, requirements: loaded }));
  }, [definitions.data, editRequirements, requirementsEdited]);
  const needsPeriod =
    !spec.dataForm && requiresEmploymentPeriod(module.id, spec.action);
  const needsAllocation =
    module.id === "assets" &&
    !spec.dataForm &&
    allocationActions.includes(spec.action);
  const custody = useResource<{
    custody: { assetId: string; allocations: CustodyAllocation[] };
  }>(
    needsAllocation && spec.entity
      ? `/api/assets/${encodeURIComponent(spec.entity.id)}/custody?limit=1&offset=0`
      : null,
  );
  const allocations =
    custody.data?.custody.assetId === spec.entity?.id
      ? (custody.data?.custody.allocations ?? [])
      : [];
  const selectedAllocation = allocations.find(
    (entry) => entry.id === values.allocationId,
  );
  const revisesPeriodDate =
    module.id === "cases" &&
    spec.action === "revise" &&
    Boolean(spec.entity?.data.employmentEpisodeId) &&
    Boolean(values.startDate);
  const personId = needsPeriod
    ? employmentPersonId(module.id, spec.entity, values)
    : revisesPeriodDate
      ? String(spec.entity?.data.personId ?? "")
      : "";
  const periods = useEmploymentPeriods(personId || null);
  const choices = availableEmploymentPeriods(
    module.id,
    spec.action,
    personId,
    periods.episodes,
  );
  const selectedPeriod = choices.find(
    (episode) => episode.id === values.employmentEpisodeId,
  );
  const refs = useReferences(
    spec.fields.filter(
      (field) =>
        field.key !== "employmentEpisodeId" &&
        field.key !== "expectedEpisodeVersion",
    ),
    spec.entity,
  );
  const assignees = useResource<{
    assignees: { id: string; label: string }[];
  }>(
    spec.entity &&
      spec.fields.some((field) =>
        ["ownerPrincipalId", "custodianPrincipalId"].includes(field.key),
      )
      ? module.id === "assets"
        ? `/api/assets/${encodeURIComponent(spec.entity.id)}/custodians`
        : `/api/cases/${encodeURIComponent(spec.entity.id)}/owners`
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [idempotencyKey] = useState(requestKey);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (editRequirements && !Array.isArray(values.requirements)) {
      setError(
        "Pobierz pełne definicje warunków odbioru przed przygotowaniem rewizji.",
      );
      return;
    }
    setError("");
    const periodInput: Record<string, unknown> = {};
    try {
      if (needsAllocation) {
        if (custody.loading || custody.error)
          throw new Error(
            "Odczytaj aktualne przydziały przed przygotowaniem operacji.",
          );
        Object.assign(
          periodInput,
          allocationSelection(allocations, spec.action, values.allocationId),
        );
        if (spec.action === "replaceReservation") {
          const target = refs.records.assets?.find(
            (asset) => asset.id === values.replacementAssetId,
          );
          if (!target)
            throw new Error("Wybierz dostępne urządzenie zastępcze.");
          periodInput.expectedReplacementVersion = target.version;
        }
        if (
          spec.action === "issue" &&
          (values.personId !== selectedAllocation?.personId ||
            values.employmentEpisodeId !==
              selectedAllocation?.employmentEpisodeId ||
            values.caseId !== selectedAllocation?.caseId)
        )
          throw new Error(
            "Wybierz ponownie przydział. Powiązanie odbiorcy i współpracy uległo zmianie.",
          );
      }
      if (needsPeriod || revisesPeriodDate) {
        if (periods.loading || periods.error)
          throw new Error(
            "Poczekaj na aktualne okresy współpracy lub ponów ich odczyt.",
          );
        const selection = selectedEmploymentInput(
          module.id,
          spec.action,
          personId,
          needsPeriod
            ? values.employmentEpisodeId
            : spec.entity?.data.employmentEpisodeId,
          periods.episodes,
        );
        periodInput.expectedEpisodeVersion = selection.expectedEpisodeVersion;
        if (needsPeriod)
          periodInput.employmentEpisodeId = selection.employmentEpisodeId;
      }
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    setBusy(true);
    const data: Record<string, unknown> = { ...periodInput };
    for (const field of spec.fields) {
      if (
        field.key === "expectedEpisodeVersion" ||
        (needsAllocation &&
          ["allocationId", "expectedAllocationVersion"].includes(field.key)) ||
        (needsPeriod && field.key === "employmentEpisodeId")
      )
        continue;
      const value = values[field.key];
      if (field.key === "dependsOn")
        data[field.key] = Array.isArray(value) ? value : [];
      else if (field.type === "boolean") data[field.key] = value === true;
      else if (value !== undefined && value !== "")
        data[field.key] = field.type === "number" ? Number(value) : value;
    }
    const input = spec.dataForm
      ? {
          ...(spec.entity
            ? { id: spec.entity.id, expectedVersion: spec.entity.version }
            : {}),
          title: String(values.title ?? "").trim(),
          ...(spec.action === "update" && module.id !== "assets"
            ? {}
            : { data }),
        }
      : { id: spec.entity!.id, expectedVersion: spec.entity!.version, ...data };
    try {
      const response = await post<{ run: Run }>("/api/commands", {
        toolId: `ops.${module.id}.${spec.action}`,
        input,
        idempotencyKey,
      });
      onClose();
      navigate(`runs/${response.run.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function fieldInput(field: Field) {
    if (needsAllocation && field.key === "allocationId")
      return (
        <AllocationSelect
          allocations={allocations}
          action={spec.action}
          selectedId={String(values.allocationId ?? "")}
          disabled={busy || custody.loading || Boolean(custody.error)}
          onSelect={(allocation) =>
            setValues((current) => ({
              ...current,
              allocationId: allocation?.id ?? "",
              personId: allocation?.personId ?? "",
              employmentEpisodeId: allocation?.employmentEpisodeId ?? "",
              caseId: allocation?.caseId ?? "",
              humanConfirmed: false,
            }))
          }
        />
      );
    if (
      needsAllocation &&
      spec.action === "issue" &&
      ["personId", "employmentEpisodeId", "caseId"].includes(field.key)
    )
      return (
        <div className="field">
          <span>{referenceLabel(field.key, field.label)}</span>
          <p>
            {!selectedAllocation
              ? "Najpierw wybierz przydział"
              : field.key === "personId"
                ? (selectedAllocation.recipientLabel ??
                  refs.label("personId", selectedAllocation.personId))
                : field.key === "employmentEpisodeId"
                  ? selectedPeriod
                    ? employmentPeriodLabel(selectedPeriod)
                    : periods.loading
                      ? "Pobieranie współpracy…"
                      : "Współpraca niedostępna lub nieaktywna"
                  : refs.label("caseId", selectedAllocation.caseId)}
          </p>
          {field.key === "employmentEpisodeId" && periods.error && (
            <Notice tone="error">{periods.error}</Notice>
          )}
        </div>
      );
    if (field.key === "engagementRef")
      return (
        <EngagementSelect
          value={values.engagementRef}
          disabled={busy}
          onSelect={(reference) =>
            setValues((current) => ({ ...current, engagementRef: reference }))
          }
        />
      );
    if (needsPeriod && field.key === "employmentEpisodeId")
      return (
        <EmploymentPeriodSelect
          personId={personId}
          episodes={choices}
          selectedId={String(values.employmentEpisodeId ?? "")}
          loading={periods.loading}
          error={periods.error}
          disabled={busy}
          onSelect={(id) =>
            setValues((current) => ({
              ...changeCommandField(current, "employmentEpisodeId", id),
              ...(spec.action === "endEmployment"
                ? {
                    endDate:
                      choices.find((episode) => episode.id === id)?.endDate ??
                      "",
                  }
                : {}),
            }))
          }
          onRefresh={() => {
            setValues((current) =>
              changeCommandField(current, "employmentEpisodeId", ""),
            );
            periods.refresh();
          }}
        />
      );
    const common = {
      id: `field-${field.key}`,
      required: field.required,
      disabled: busy,
    };
    const options = ["ownerPrincipalId", "custodianPrincipalId"].includes(
      field.key,
    )
      ? (assignees.data?.assignees ?? [])
      : needsPeriod && field.key === "caseId"
        ? employmentCaseOptions(
            refs.records.cases ?? [],
            personId,
            values.employmentEpisodeId,
          )
        : referenceOptions(field.key, refs.records, values, spec.entity);
    const set = (value: unknown) =>
      setValues((current) => changeCommandField(current, field.key, value));
    if (field.key === "dependsOn")
      return (
        <fieldset className="dependency-options">
          <legend>Wymagane wcześniejsze zadania</legend>
          {options?.length ? (
            options.map((option) => (
              <label className="checkbox-field" key={option.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={
                    Array.isArray(values.dependsOn) &&
                    values.dependsOn.includes(option.id)
                  }
                  onChange={(event) =>
                    set(
                      event.target.checked
                        ? [
                            ...(Array.isArray(values.dependsOn)
                              ? values.dependsOn
                              : []),
                            option.id,
                          ]
                        : (Array.isArray(values.dependsOn)
                            ? values.dependsOn
                            : []
                          ).filter((id) => id !== option.id),
                    )
                  }
                />
                {option.label}
              </label>
            ))
          ) : (
            <p className="small muted">
              Brak wcześniejszych zadań w bieżącym zakresie sprawy.
            </p>
          )}
        </fieldset>
      );
    if (field.type === "boolean")
      return (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={values[field.key] === true}
            required={
              field.required &&
              ["humanDecision", "humanConfirmed"].includes(field.key)
            }
            onChange={(event) => set(event.target.checked)}
            disabled={busy}
          />
          {field.label}
        </label>
      );
    return (
      <label
        className={field.type === "textarea" ? "field wide" : "field"}
        htmlFor={common.id}
      >
        <span>
          {options ? referenceLabel(field.key, field.label) : field.label}
          {field.required && <span className="required"> *</span>}
        </span>
        {options ? (
          <>
            <select
              {...common}
              value={String(values[field.key] ?? "")}
              onChange={(event) => set(event.target.value)}
            >
              <option value="">
                {["ownerPrincipalId", "custodianPrincipalId"].includes(
                  field.key,
                )
                  ? assignees.loading
                    ? "Pobieranie kont…"
                    : module.id === "assets"
                      ? "Wybierz opiekuna ewidencji…"
                      : "Wybierz konto właściciela…"
                  : options.length
                    ? "Wybierz rekord…"
                    : field.key === "employmentEpisodeId"
                      ? "Najpierw wybierz osobę…"
                      : "Brak dostępnych rekordów"}
              </option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {!options.length && (
              <small>
                {["ownerPrincipalId", "custodianPrincipalId"].includes(
                  field.key,
                )
                  ? module.id === "assets"
                    ? "Opiekun musi mieć dostęp do ewidencji sprzętu. JARVIS sprawdzi aktywne konto przed zapisem."
                    : "Właściciel musi mieć dostęp do całej sprawy. JARVIS sprawdzi uprawnienia konta przed zapisem."
                  : "Dodaj potrzebny rekord w odpowiednim obszarze, a następnie wróć do tej operacji."}
              </small>
            )}
          </>
        ) : field.type === "textarea" ? (
          <textarea
            {...common}
            rows={4}
            value={String(values[field.key] ?? "")}
            onChange={(event) => set(event.target.value)}
          />
        ) : field.type === "select" ? (
          <select
            {...common}
            value={String(values[field.key] ?? "")}
            onChange={(event) => set(event.target.value)}
          >
            <option value="">Wybierz…</option>
            {field.options?.map((option) => (
              <option key={option} value={option}>
                {optionLabel(option)}
              </option>
            ))}
          </select>
        ) : (
          <input
            {...common}
            type={
              field.type === "number"
                ? "number"
                : field.type === "date"
                  ? "date"
                  : "text"
            }
            step={field.type === "number" ? "any" : undefined}
            value={String(values[field.key] ?? "")}
            onChange={(event) => set(event.target.value)}
          />
        )}
      </label>
    );
  }
  return (
    <Sheet title={spec.title} subtitle={module.label} onClose={onClose}>
      <form onSubmit={submit} className="command-form">
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          {assignees.error && <Notice tone="error">{assignees.error}</Notice>}
          {definitions.error && (
            <Notice tone="error">{definitions.error}</Notice>
          )}
          {needsAllocation && custody.error && (
            <Notice tone="error">{custody.error}</Notice>
          )}
          {revisesPeriodDate && periods.error && (
            <Notice tone="error">{periods.error}</Notice>
          )}
          {refs.errors.map((error) => (
            <Notice key={error}>{error}</Notice>
          ))}
          <div className="form-grid">
            {spec.dataForm && (
              <label className="field wide">
                <span>
                  Nazwa <span className="required">*</span>
                </span>
                <input
                  autoFocus
                  required
                  maxLength={200}
                  disabled={busy}
                  value={String(values.title ?? "")}
                  onChange={(event) =>
                    setValues({ ...values, title: event.target.value })
                  }
                  placeholder="Wpisz czytelną nazwę"
                />
              </label>
            )}
            {spec.fields
              .filter(
                (field) =>
                  field.key !== "expectedEpisodeVersion" &&
                  field.key !== "expectedAllocationVersion" &&
                  !(editRequirements && field.key === "requirements"),
              )
              .map((field) => (
                <div
                  className={
                    field.type === "textarea" ||
                    field.type === "boolean" ||
                    field.key === "dependsOn" ||
                    field.key === "employmentEpisodeId" ||
                    field.key === "engagementRef"
                      ? "wide"
                      : ""
                  }
                  key={field.key}
                >
                  {fieldInput(field)}
                </div>
              ))}
          </div>
          {editRequirements &&
            (Array.isArray(values.requirements) ? (
              <RequirementEditor
                value={values.requirements as RequirementDefinition[]}
                disabled={busy}
                onboarding={spec.entity?.data.caseType === "onboarding"}
                onChange={(requirements) => {
                  setRequirementsEdited(true);
                  setValues((current) => ({ ...current, requirements }));
                }}
              />
            ) : definitions.loading ? (
              <Loading />
            ) : (
              <Notice tone="error">
                Brak pełnych definicji warunków odbioru. Odśwież sprawę;
                przygotowanie rewizji jest wstrzymane.
              </Notice>
            ))}
          <Notice>
            Przygotujesz plan operacji. Przed zapisem zobaczysz dokładny zakres
            zmiany i przejdziesz do jej zatwierdzenia.
          </Notice>
          {spec.entity && (
            <p className="muted small">
              Zmiana dotyczy wersji {spec.entity.version} rekordu „
              {spec.entity.title}”.
            </p>
          )}
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Anuluj
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={
              busy ||
              (needsAllocation &&
                (custody.loading ||
                  Boolean(custody.error) ||
                  !selectedAllocation)) ||
              ((needsPeriod || revisesPeriodDate) &&
                (periods.loading || Boolean(periods.error))) ||
              (needsPeriod && !selectedPeriod) ||
              (editRequirements && !Array.isArray(values.requirements))
            }
          >
            {busy ? (
              <span className="spinner" />
            ) : (
              <Icon name="arrow" size={17} />
            )}
            Przygotuj operację
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function WorkspacePage({
  module,
  entityId,
  context,
  revision,
}: {
  module: ModuleDefinition;
  entityId?: string;
  context: Context;
  revision: number;
}) {
  const resource = useResource<{ items: Entity[] }>(
    `/api/workspace/${module.id}`,
    revision,
  );
  const detail = useResource<{ item: Entity }>(
    entityId
      ? `/api/workspace/${module.id}/${encodeURIComponent(entityId)}`
      : null,
    revision,
  );
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [form, setForm] = useState<FormSpec | null>(null);
  const [documentTemplate, setDocumentTemplate] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const closeForm = useCallback(() => setForm(null), []);
  const allowed = context.principal.roles.includes("operator");
  const allowedTool = (action: string) =>
    allowed &&
    context.tools.some((tool) => tool.id === `ops.${module.id}.${action}`);
  const create = () =>
    setForm({
      title: `Dodaj: ${module.label.toLocaleLowerCase("pl")}`,
      action: "create",
      fields: module.fields,
      dataForm: true,
    });
  const items = (resource.data?.items ?? []).filter(
    (item) =>
      (!status || item.status === status) &&
      `${item.title} ${Object.values(item.data).join(" ")}`
        .toLocaleLowerCase("pl")
        .includes(search.toLocaleLowerCase("pl")),
  );
  const states = [
    ...new Set((resource.data?.items ?? []).map((item) => item.status)),
  ];
  const item = detail.data?.item;
  const refs = useReferences(module.fields, item);
  const showAction = (id: string, initialValues?: Record<string, unknown>) => {
    const action = module.actions.find((action) => action.id === id);
    if (action && item && allowedTool(id))
      setForm({
        title: action.label,
        action: id,
        fields: actionFields(module, action),
        entity: item,
        dataForm: false,
        initialValues,
      });
  };
  if (entityId)
    return (
      <>
        {form?.action === "revise" &&
        module.id === "documents" &&
        form.entity ? (
          <DocumentRevision item={form.entity} onClose={closeForm} />
        ) : (
          form && (
            <CommandForm module={module} spec={form} onClose={closeForm} />
          )
        )}
        <button
          className="text-button back-link"
          onClick={() => navigate(`module/${module.id}`)}
        >
          <Icon name="back" size={16} />
          {module.label}
        </button>
        {detail.loading ? (
          <Loading />
        ) : detail.error ? (
          <Notice tone="error">{detail.error}</Notice>
        ) : (
          item && (
            <>
              <div className="page-heading">
                <div>
                  <span className="eyebrow">{module.label.toUpperCase()}</span>
                  <h1>{item.title}</h1>
                  <div className="heading-meta">
                    <Badge status={item.status} />
                    <span>Wersja {item.version}</span>
                    <span>
                      Zaktualizowano {dateLabel(item.updatedAt, true)}
                    </span>
                  </div>
                </div>
                {allowedTool("update") &&
                  module.id !== "documents" &&
                  !(module.id === "assets" && item.status === "retired") && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        setForm({
                          title:
                            module.id === "assets"
                              ? "Zmień dane ewidencji"
                              : "Zmień nazwę",
                          action: "update",
                          fields:
                            module.id === "assets"
                              ? module.fields.filter((f) =>
                                  ["manufacturer", "model"].includes(f.key),
                                )
                              : [],
                          entity: item,
                          dataForm: true,
                        })
                      }
                    >
                      <Icon name="edit" size={17} />
                      Edytuj
                    </button>
                  )}
              </div>
              {item.module === "people" &&
                context.principal.scopes?.some(
                  (s) => s === "*" || s === "cases",
                ) && <PersonOnboardings item={item} revision={revision} />}
              {item.module === "cases" &&
                item.data.caseType === "onboarding" && (
                  <Onboarding
                    item={item}
                    context={context}
                    revision={revision}
                  />
                )}
              {item.module === "cases" && (
                <CaseReadiness
                  item={item}
                  context={context}
                  revision={revision}
                />
              )}
              {item.module === "documents" && (
                <>
                  <DocumentReadiness key={item.id} item={item} />
                  <DocumentFiles
                    item={item}
                    canWrite={
                      allowedTool("attachFile") && allowedTool("detachFile")
                    }
                  />
                </>
              )}
              {item.module === "cases" &&
                context.principal.scopes?.some(
                  (s) => s === "*" || s === "it",
                ) && (
                  <CaseAccess
                    item={item}
                    context={context}
                    revision={revision}
                  />
                )}
              {isAccessDefinition(item) && (
                <AccessDefinitions context={context} item={item} />
              )}
              <div className="detail-grid">
                <section className="card">
                  <div className="card-heading">
                    <h2>Dane rekordu</h2>
                    <Icon name={module.id} />
                  </div>
                  <dl className="data-grid">
                    {module.fields
                      .filter(
                        (field) =>
                          !isAccessDefinition(item) ||
                          ["kind", "description"].includes(field.key),
                      )
                      .map((field) => (
                        <div
                          key={field.key}
                          className={field.type === "textarea" ? "wide" : ""}
                        >
                          <dt>{referenceLabel(field.key, field.label)}</dt>
                          <dd>
                            {referenceModule[field.key]
                              ? refs.label(field.key, item.data[field.key])
                              : field.type === "date"
                                ? dateLabel(String(item.data[field.key] ?? ""))
                                : field.type === "select"
                                  ? optionLabel(
                                      String(item.data[field.key] ?? "—"),
                                    )
                                  : displayValue(item.data[field.key])}
                          </dd>
                        </div>
                      ))}
                  </dl>
                  <div className="record-id">
                    <span>ID rekordu</span>
                    <code>{item.id}</code>
                    <button
                      className="icon-button"
                      title="Kopiuj identyfikator"
                      aria-label="Kopiuj identyfikator"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(item.id)
                          .then(() =>
                            setCopyMessage("Identyfikator skopiowany."),
                          )
                          .catch(() =>
                            setCopyMessage(
                              "Nie udało się skopiować identyfikatora.",
                            ),
                          );
                      }}
                    >
                      <Icon name="copy" size={16} />
                    </button>
                  </div>
                  {copyMessage && (
                    <p className="small muted" role="status">
                      {copyMessage}
                    </p>
                  )}
                </section>
                <aside>
                  <section className="card">
                    <div className="card-heading">
                      <h2>Kolejny krok</h2>
                    </div>
                    <p className="muted">
                      Wybierz operację. JARVIS przygotuje jej zakres do
                      sprawdzenia.
                    </p>
                    <div className="action-list">
                      {module.actions
                        .filter(
                          (action) =>
                            allowedTool(action.id) &&
                            !(
                              module.id === "people" &&
                              action.id === "cancelStart"
                            ) &&
                            !(
                              module.id === "cases" &&
                              item.data.caseType === "onboarding" &&
                              ["submit", "accept"].includes(action.id)
                            ) &&
                            !(
                              module.id === "documents" &&
                              ["attachFile", "detachFile"].includes(action.id)
                            ) &&
                            (module.id !== "it" ||
                              (isAccessDefinition(item)
                                ? action.id === "retireAccessDefinition" &&
                                  item.status === "active"
                                : ![
                                    "reviseApplication",
                                    "reviseAccessBundle",
                                    "retireAccessDefinition",
                                  ].includes(action.id))) &&
                            (module.id !== "assets" ||
                              action.id === "assignCustodian" ||
                              (action.id === "reserve" &&
                                item.status === "available" &&
                                item.data.condition === "good") ||
                              ([
                                "issue",
                                "release",
                                "expireReservation",
                                "replaceReservation",
                              ].includes(action.id) &&
                                item.status === "reserved") ||
                              (action.id === "return" &&
                                item.status === "issued") ||
                              (["move", "sendToService", "retire"].includes(
                                action.id,
                              ) &&
                                ["available", "maintenance"].includes(
                                  item.status,
                                )) ||
                              (action.id === "markRepaired" &&
                                item.status === "maintenance")) &&
                            !(
                              module.id === "assets" &&
                              action.id.endsWith("ForTask")
                            ) &&
                            !(
                              module.id === "cases" &&
                              [
                                "acceptTask",
                                "declineTask",
                                "transferTask",
                                "completeTask",
                                "cancelTask",
                                "bindEvidence",
                                "attestAccessForTask",
                                "renewAccessForTask",
                                "revokeAccessForTask",
                                "bindAccessForTask",
                                "attestAccess",
                                "renewAccess",
                                "revokeAccess",
                              ].includes(action.id)
                            ),
                        )
                        .map((action) => (
                          <button
                            className="action-row"
                            key={action.id}
                            onClick={() =>
                              setForm({
                                title: action.label,
                                action: action.id,
                                fields: actionFields(module, action),
                                entity: item,
                                dataForm: false,
                              })
                            }
                          >
                            <span>{action.label}</span>
                            <Icon name="arrow" size={17} />
                          </button>
                        ))}
                      {!module.actions.some((action) =>
                        allowedTool(action.id),
                      ) && (
                        <p className="small muted">
                          Brak dostępnych operacji dla Twojej roli.
                        </p>
                      )}
                    </div>
                  </section>
                  <RecordDownload item={item} />
                  <div className="small muted detail-note">
                    <Icon name="shield" size={18} />
                    <span>
                      Dane należą do bieżącej organizacji. Każda zmiana
                      pozostawia ślad w historii wykonania.
                    </span>
                  </div>
                </aside>
              </div>
              {item.module === "cases" && (
                <HumanTasks
                  context={context}
                  revision={revision + item.version}
                  caseId={item.id}
                />
              )}
              <EntityContent
                item={item}
                onAction={showAction}
                allowedTool={allowedTool}
                hideTasks={item.module === "cases"}
              />
            </>
          )
        )}
      </>
    );
  return (
    <>
      {documentTemplate && (
        <DocumentTemplate onClose={() => setDocumentTemplate(false)} />
      )}
      {form && <CommandForm module={module} spec={form} onClose={closeForm} />}
      <div className="page-heading">
        <div>
          <span className="eyebrow">PRACA OPERACYJNA</span>
          <h1>{module.label}</h1>
          <p>{module.description}</p>
        </div>
        {allowedTool("create") && (
          <button className="button primary" onClick={create}>
            <Icon name="plus" size={18} />
            Dodaj rekord
          </button>
        )}
      </div>
      {resource.error && <Notice tone="error">{resource.error}</Notice>}
      {module.id === "documents" && allowedTool("create") && (
        <section className="card document-template-callout">
          <div>
            <h2>Dokument na podstawie Twoich danych</h2>
            <p className="muted">
              Przygotuj brief sprawy, raport sprzętu, ofertę lub wniosek
              zakupowy z opisanym źródłem.
            </p>
          </div>
          <button
            className="button secondary"
            onClick={() => setDocumentTemplate(true)}
          >
            <Icon name="documents" size={17} />
            Użyj szablonu
          </button>
        </section>
      )}
      {module.id === "it" && <LaboratoryPanel context={context} />}
      {module.id === "it" && <AccessDefinitions context={context} />}
      <section className="card table-card">
        <div className="table-toolbar">
          <label className="search-field">
            <Icon name="search" size={18} />
            <input
              aria-label={`Szukaj: ${module.label}`}
              placeholder="Szukaj po nazwie lub danych…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <select
            aria-label="Filtruj według statusu"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Wszystkie statusy</option>
            {states.map((value) => (
              <option value={value} key={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
          <span className="record-count">{items.length} rekordów</span>
        </div>
        {resource.loading ? (
          <Loading />
        ) : items.length === 0 ? (
          <Empty
            icon={module.id}
            title={
              search || status
                ? "Brak pasujących wyników"
                : `Tutaj pojawią się Twoje dane`
            }
            action={
              !search && !status && allowedTool("create") ? (
                <button className="button secondary" onClick={create}>
                  <Icon name="plus" size={17} />
                  Dodaj pierwszy rekord
                </button>
              ) : undefined
            }
          >
            {search || status
              ? "Zmień wyszukiwanie lub wyczyść filtr statusu."
              : "Dodaj pierwszy rekord albo opisz zadanie w rozmowie z JARVIS. Zapis nastąpi po sprawdzeniu i zatwierdzeniu operacji."}
          </Empty>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nazwa</th>
                  <th>Status</th>
                  {module.fields.slice(0, 2).map((field) => (
                    <th className="optional-column" key={field.key}>
                      {field.label}
                    </th>
                  ))}
                  <th>Aktualizacja</th>
                  <th>
                    <span className="sr-only">Szczegóły</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <button
                        className="table-link"
                        onClick={() =>
                          navigate(`module/${module.id}/${record.id}`)
                        }
                      >
                        {record.title}
                      </button>
                      <span className="table-subtitle">
                        Wersja {record.version}
                      </span>
                    </td>
                    <td>
                      <Badge status={record.status} />
                    </td>
                    {module.fields.slice(0, 2).map((field) => (
                      <td
                        className="optional-column cell-truncate"
                        key={field.key}
                      >
                        {referenceModule[field.key]
                          ? refs.label(field.key, record.data[field.key])
                          : field.type === "select"
                            ? optionLabel(String(record.data[field.key] ?? "—"))
                            : displayValue(record.data[field.key])}
                      </td>
                    ))}
                    <td className="nowrap muted">
                      {dateLabel(record.updatedAt)}
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        aria-label={`Otwórz: ${record.title}`}
                        onClick={() =>
                          navigate(`module/${module.id}/${record.id}`)
                        }
                      >
                        <Icon name="chevron" size={17} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
