import { useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Run } from "./types";
import { Empty, Icon, Loading, Notice, Sheet } from "./ui";
import { TaskEquipment } from "./TaskEquipment";

export type TaskAction =
  "acceptTask" | "declineTask" | "transferTask" | "completeTask" | "cancelTask";
export interface HumanTask {
  id: string;
  caseId: string;
  caseVersion?: number;
  scopeRevision: number;
  version: number;
  title: string;
  kind: "information" | "decision" | "work" | "attestation";
  status: string;
  assigneePrincipalId: string | null;
  assigneeLabel?: string;
  assigneeRole: "hr" | "it" | "manager" | null;
  dueDate: string | null;
  overdue: boolean;
  dependsOn: { id: string; title?: string; completed: boolean }[];
  allowedActions: TaskAction[];
  performedBy: string | null;
  performedByLabel?: string;
  evidenceNote: string | null;
  operationalContext?: {
    recipientLabel: string;
    engagementLabel: string;
    equipment: true;
  };
  events: {
    action: string;
    requestedBy: string | null;
    approvedBy: string | null;
    performedBy: string | null;
    reason: string | null;
    createdAt: string;
    taskVersion: number;
  }[];
}
const taskKinds: Record<HumanTask["kind"], string> = {
  information: "Uzupełnienie danych",
  decision: "Decyzja człowieka",
  work: "Praca człowieka",
  attestation: "Poświadczenie",
};
const taskStates: Record<string, string> = {
  unassigned: "Brak wykonawcy",
  offered: "Do przyjęcia",
  accepted: "Przyjęte do pracy",
  declined: "Odmowa wykonania",
  completed: "Wykonane",
  cancelled: "Anulowane",
  open: "Wymaga przypisania",
};
const roleLabels = { hr: "HR", it: "IT", manager: "Przełożony" };
const actionLabels: Record<TaskAction, string> = {
  acceptTask: "Przyjmij zadanie",
  declineTask: "Odmów wykonania",
  transferTask: "Przekaż zadanie",
  completeTask: "Potwierdź wykonanie",
  cancelTask: "Anuluj zadanie",
};
const eventLabels: Record<string, string> = {
  acceptTask: "Przyjęcie zadania",
  declineTask: "Odmowa wykonania",
  transferTask: "Przekazanie zadania",
  completeTask: "Potwierdzenie wykonania",
  cancelTask: "Anulowanie zadania",
  created: "Utworzenie zadania",
  assigned: "Przypisanie wykonawcy",
  issueForTask: "Poświadczenie wydania sprzętu",
  returnForTask: "Poświadczenie zwrotu sprzętu",
  bindAssetForTask: "Powiązanie dowodu wydania",
  accepted: "Przyjęcie zadania",
  declined: "Odmowa wykonania",
  transferred: "Przekazanie zadania",
  completed: "Potwierdzenie wykonania",
  cancelled: "Anulowanie zadania",
};

export function taskCommand(
  task: HumanTask,
  action: TaskAction,
  values: { reason: string; assigneePrincipalId: string; evidenceNote: string },
) {
  if (!task.allowedActions.includes(action))
    throw new Error("Ta czynność nie jest dostępna dla tego zadania.");
  if (!Number.isInteger(task.caseVersion) || (task.caseVersion ?? 0) < 1)
    throw new Error(
      "Brak aktualnej wersji sprawy. Odśwież zadanie przed przygotowaniem operacji.",
    );
  return {
    toolId: `ops.cases.${action}`,
    input: {
      id: task.caseId,
      expectedVersion: task.caseVersion,
      taskId: task.id,
      expectedTaskVersion: task.version,
      humanConfirmed: true,
      ...(["declineTask", "transferTask", "cancelTask"].includes(action)
        ? { reason: values.reason.trim() }
        : {}),
      ...(action === "transferTask"
        ? { assigneePrincipalId: values.assigneePrincipalId }
        : {}),
      ...(action === "completeTask"
        ? { evidenceNote: values.evidenceNote.trim() }
        : {}),
    },
  };
}

export function HumanTaskCard({
  task,
  onAction,
  actions = task.allowedActions,
  onEquipment,
}: {
  task: HumanTask;
  onAction: (action: TaskAction) => void;
  actions?: TaskAction[];
  onEquipment?: () => void;
}) {
  const blocked = task.dependsOn.filter((dependency) => !dependency.completed);
  return (
    <article className="human-task-entry">
      <div className="task-heading">
        <div>
          <span className="eyebrow">
            {taskKinds[task.kind] ?? "Zadanie człowieka"}
          </span>
          <h3>{task.title}</h3>
        </div>
        <span className={`task-state ${task.status}`}>
          {taskStates[task.status] ?? "Stan do sprawdzenia"}
        </span>
      </div>
      {task.operationalContext && (
        <dl className="equipment-context">
          <div>
            <dt>Odbiorca</dt>
            <dd>{task.operationalContext.recipientLabel}</dd>
          </div>
          <div>
            <dt>Współpraca</dt>
            <dd>{task.operationalContext.engagementLabel}</dd>
          </div>
        </dl>
      )}
      <dl className="human-task-meta">
        <div>
          <dt>Wykonawca</dt>
          <dd>
            {task.assigneeLabel ??
              (task.assigneePrincipalId
                ? `Konto: ${task.assigneePrincipalId}`
                : "Do wyznaczenia")}
            {task.assigneeRole && (
              <span className="muted"> · {roleLabels[task.assigneeRole]}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Termin</dt>
          <dd>
            {dateLabel(task.dueDate ?? undefined)}
            {task.overdue && <span className="overdue-label">Po terminie</span>}
          </dd>
        </div>
        <div>
          <dt>Zakres</dt>
          <dd>Rewizja {task.scopeRevision}</dd>
        </div>
      </dl>
      {blocked.length > 0 && (
        <p className="task-dependency-note">
          <Icon name="clock" size={15} />
          <span>
            Oczekuje na{" "}
            {blocked.length === 1
              ? "zadanie poprzedzające"
              : `${blocked.length} zadania poprzedzające`}
            {blocked.some((dependency) => dependency.title)
              ? `: ${blocked.flatMap((dependency) => (dependency.title ? [dependency.title] : [])).join(", ")}`
              : "."}
          </span>
        </p>
      )}
      {task.evidenceNote && (
        <div className="human-evidence">
          <span className="eyebrow">POŚWIADCZENIE WYKONANIA</span>
          <p>{task.evidenceNote}</p>
          <small>
            {task.performedByLabel ??
              (task.performedBy
                ? `Wykonano przez: ${task.performedBy}`
                : "Brak zapisanego autora wykonania")}
          </small>
        </div>
      )}
      {actions.length > 0 && (
        <div className="task-actions">
          {actions.map((action) => (
            <button
              key={action}
              className={`button ${action === "acceptTask" || action === "completeTask" ? "secondary" : "ghost"}`}
              disabled={action === "completeTask" && blocked.length > 0}
              onClick={() => onAction(action)}
            >
              {actionLabels[action]}
            </button>
          ))}
        </div>
      )}
      {task.operationalContext?.equipment && onEquipment && (
        <button
          className="button secondary equipment-open"
          onClick={onEquipment}
        >
          <Icon name="assets" size={16} />
          Sprzęt i przekazanie
        </button>
      )}
      {task.events.length > 0 && (
        <details className="task-history">
          <summary>Historia zadania ({task.events.length})</summary>
          <ol>
            {task.events.map((entry, index) => (
              <li key={`${entry.taskVersion}-${index}`}>
                <strong>{eventLabels[entry.action] ?? "Zmiana zadania"}</strong>
                <time>{dateLabel(entry.createdAt, true)}</time>
                {entry.reason &&
                  ![
                    "issueForTask",
                    "returnForTask",
                    "bindAssetForTask",
                  ].includes(entry.action) && <p>{entry.reason}</p>}
                <span className="small muted">
                  Wersja zadania {entry.taskVersion}
                  {entry.requestedBy ? ` · zlecono: ${entry.requestedBy}` : ""}
                  {entry.performedBy ? ` · wykonano: ${entry.performedBy}` : ""}
                  {entry.approvedBy
                    ? ` · zgoda na zapis: ${entry.approvedBy}`
                    : ""}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

function TaskActionForm({
  task,
  action,
  onClose,
}: {
  task: HumanTask;
  action: TaskAction;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [evidenceNote, setEvidenceNote] = useState("");
  const [assigneePrincipalId, setAssigneePrincipalId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [key] = useState(requestKey);
  const assignees = useResource<{
    assignees: { id: string; label?: string }[];
  }>(
    action === "transferTask"
      ? `/api/task-assignees?taskId=${encodeURIComponent(task.id)}`
      : null,
  );
  const needsReason = ["declineTask", "transferTask", "cancelTask"].includes(
    action,
  );
  const allowedAssignees = (assignees.data?.assignees ?? []).filter(
    (person) => person.id !== task.assigneePrincipalId,
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !confirmed ||
      (action === "transferTask" &&
        !allowedAssignees.some((person) => person.id === assigneePrincipalId))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const command = taskCommand(task, action, {
        reason,
        evidenceNote,
        assigneePrincipalId,
      });
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
    <Sheet title={actionLabels[action]} subtitle={task.title} onClose={onClose}>
      <form className="command-form" onSubmit={submit}>
        <div className="sheet-body">
          {error && <Notice tone="error">{error}</Notice>}
          <p>
            Dotyczy rewizji {task.scopeRevision} i aktualnej wersji zadania.
            JARVIS przygotuje konkretną operację do sprawdzenia i zgody na
            zapis.
          </p>
          {action === "transferTask" && (
            <>
              <label className="field">
                <span>Nowy wykonawca</span>
                <select
                  value={assigneePrincipalId}
                  required
                  disabled={busy || assignees.loading || !!assignees.error}
                  onChange={(event) =>
                    setAssigneePrincipalId(event.target.value)
                  }
                >
                  <option value="">Wybierz uprawnione konto…</option>
                  {allowedAssignees.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.label ?? person.id}
                    </option>
                  ))}
                </select>
              </label>
              {assignees.error && (
                <Notice tone="error">{assignees.error}</Notice>
              )}
              {!assignees.loading &&
                !assignees.error &&
                !allowedAssignees.length && (
                  <Notice>
                    Brak innego dostępnego wykonawcy. Właściciel sprawy musi
                    uzupełnić obsadę.
                  </Notice>
                )}
              <p className="small muted">
                Nowy wykonawca będzie musiał przyjąć zadanie.
              </p>
            </>
          )}
          {needsReason && (
            <label className="field">
              <span>
                {action === "declineTask"
                  ? "Powód odmowy"
                  : action === "cancelTask"
                    ? "Powód anulowania"
                    : "Powód przekazania"}
              </span>
              <textarea
                required
                maxLength={2000}
                rows={4}
                disabled={busy}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          )}
          {action === "completeTask" && (
            <label className="field">
              <span>Co zostało wykonane i z jakim wynikiem?</span>
              <textarea
                required
                maxLength={2000}
                rows={4}
                disabled={busy}
                value={evidenceNote}
                onChange={(event) => setEvidenceNote(event.target.value)}
              />
              <small>
                Opis wykonania nie zastępuje wymaganego sprzętu, dokumentu ani
                dostępu.
              </small>
            </label>
          )}
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={confirmed}
              required
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            {action === "completeTask"
              ? "Potwierdzam wykonanie opisanej pracy."
              : action === "acceptTask"
                ? "Przyjmuję odpowiedzialność za wykonanie zadania."
                : "Potwierdzam tę decyzję dotyczącą zadania."}
          </label>
          <p className="small muted">
            To decyzja o zadaniu człowieka. Nie stanowi odbioru całej sprawy ani
            zgody na inne operacje.
          </p>
        </div>
        <div className="sheet-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Wróć
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={
              busy ||
              !confirmed ||
              (needsReason && !reason.trim()) ||
              (action === "completeTask" && !evidenceNote.trim()) ||
              (action === "transferTask" &&
                (!assigneePrincipalId || !!assignees.error))
            }
          >
            {busy ? "Przygotowywanie…" : "Przygotuj operację"}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

export function HumanTasks({
  context,
  revision,
  caseId,
}: {
  context: Context;
  revision: number;
  caseId?: string;
}) {
  const canOperate = context.principal.roles.includes("operator");
  const resource = useResource<{ tasks: HumanTask[] }>(
    canOperate ? "/api/tasks" : null,
    revision,
    7000,
  );
  const [filter, setFilter] = useState("current");
  const [kind, setKind] = useState("");
  const [equipmentTask, setEquipmentTask] = useState<HumanTask | null>(null);
  const [selected, setSelected] = useState<{
    task: HumanTask;
    action: TaskAction;
  } | null>(null);
  const tasks = (resource.data?.tasks ?? []).filter(
    (task) =>
      (!caseId || task.caseId === caseId) &&
      (!kind || task.kind === kind) &&
      (filter === "all" ||
        (filter === "overdue"
          ? task.overdue
          : !["completed", "cancelled"].includes(task.status))),
  );
  if (!canOperate)
    return (
      <Notice>
        Lista zadań roboczych jest dostępna wykonawcom. Warunki odbioru sprawy i
        zgody na zapis pozostają osobnymi widokami.
      </Notice>
    );
  return (
    <>
      {equipmentTask && (
        <TaskEquipment
          key={equipmentTask.id}
          taskId={equipmentTask.id}
          title={equipmentTask.title}
          onClose={() => setEquipmentTask(null)}
        />
      )}
      {selected && (
        <TaskActionForm
          task={selected.task}
          action={selected.action}
          onClose={() => setSelected(null)}
        />
      )}
      {!caseId && (
        <div className="page-heading">
          <div>
            <span className="eyebrow">PRACA LUDZI</span>
            <h1>Zadania i decyzje</h1>
            <p>
              Przyjmij odpowiedzialność, uzupełnij dane lub potwierdź wykonanie
              swojej pracy.
            </p>
          </div>
        </div>
      )}
      <section className="card human-tasks-card">
        <div className="card-heading">
          <div>
            <h2>{caseId ? "Praca nad tą sprawą" : "Twoja kolejka pracy"}</h2>
            <p>
              Widzisz zadania dostępne dla Twojej tożsamości. Zgody na konkretne
              zapisy znajdziesz w wykonaniach.
            </p>
          </div>
          <Icon name="people" />
        </div>
        <div className="task-filters">
          <label>
            <span className="sr-only">Stan zadań</span>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            >
              <option value="current">Aktualne zadania</option>
              <option value="overdue">Po terminie</option>
              <option value="all">Wraz z historią</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Rodzaj zadania</span>
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="">Wszystkie rodzaje</option>
              {Object.entries(taskKinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {resource.error ? (
          <Notice tone="error">{resource.error}</Notice>
        ) : !resource.data ? (
          <Loading />
        ) : tasks.length ? (
          <div className="human-task-list">
            {tasks.map((task) => (
              <HumanTaskCard
                key={task.id}
                task={task}
                actions={
                  canOperate
                    ? task.allowedActions.filter((action) =>
                        context.tools.some(
                          (tool) => tool.id === `ops.cases.${action}`,
                        ),
                      )
                    : []
                }
                onAction={(action) => setSelected({ task, action })}
                onEquipment={() => setEquipmentTask(task)}
              />
            ))}
          </div>
        ) : (
          <Empty icon="people" title="Brak zadań w tym widoku">
            Nie ma dostępnej pracy pasującej do filtrów. Nie oznacza to
            automatycznie gotowości całej sprawy.
          </Empty>
        )}
      </section>
    </>
  );
}
