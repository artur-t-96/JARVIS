const byId = (id) => document.getElementById(id);
const linkedRunId = new URLSearchParams(location.hash.slice(1)).get("run");
const state = {
  context: null,
  runs: [],
  selectedId:
    linkedRunId && /^[a-zA-Z0-9_-]{1,100}$/.test(linkedRunId)
      ? linkedRunId
      : null,
  detail: null,
  token: "",
  busy: false,
  refreshing: false,
  draftKey: null,
  detailSignature: "",
  historySignature: "",
  connected: false,
  authEpoch: 0,
};

const statusNames = {
  planned: "Plan gotowy",
  pending: "Oczekuje",
  running: "W toku",
  executing: "Wykonywanie",
  verifying: "Weryfikacja",
  waiting_approval: "Oczekuje na zgodę",
  completed: "Zakończone",
  succeeded: "Zweryfikowano",
  blocked: "Zablokowane",
  failed: "Błąd",
  cancelled: "Anulowane",
  needs_reconciliation: "Wymaga uzgodnienia",
  unknown: "Wynik nieustalony",
  approved: "Zatwierdzone",
  rejected: "Odrzucone",
  not_run: "Nie wykonano",
};
const roleNames = {
  operator: "Operator",
  approver: "Zatwierdzający",
  viewer: "Podgląd",
};
const effectNames = { read: "Odczyt", write: "Zapis" };
const eventNames = {
  plan_created: "Utworzono plan",
  run_started: "Uruchomiono wykonanie",
  run_completed: "Zakończono wykonanie",
  cancellation_requested: "Zlecono zatrzymanie",
  cancelled_without_effect: "Anulowano przed zapisem",
  step_started: "Rozpoczęto krok",
  step_verified: "Krok zweryfikowany",
  step_blocked: "Krok zablokowany",
  effect_recorded: "Zapisano wynik operacji",
  approval_requested: "Poproszono o zgodę",
  approval_approved: "Zatwierdzono operację",
  approval_rejected: "Odrzucono operację",
  reconciliation_requested: "Zlecono uzgodnienie wyniku",
  reconciliation_started: "Rozpoczęto uzgodnienie wyniku",
  outcome_unknown: "Wynik operacji nieustalony",
  verification_resumed: "Wznowiono weryfikację",
  verification_failed: "Weryfikacja nie potwierdziła wyniku",
};
const dateFormat = new Intl.DateTimeFormat("pl-PL", {
  dateStyle: "short",
  timeStyle: "short",
});
const shortDateFormat = new Intl.DateTimeFormat("pl-PL", {
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}
function date(value, short = false) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "—"
    : (short ? shortDateFormat : dateFormat).format(parsed);
}
function json(value) {
  return JSON.stringify(value ?? null, null, 2);
}
function badge(status) {
  return node(
    "span",
    `status ${Object.hasOwn(statusNames, status) ? status : ""}`,
    statusNames[status] || status || "—",
  );
}
function hasRole(role) {
  return Boolean(state.context?.principal?.roles?.includes(role));
}
function showMessage(id, message) {
  const element = byId(id);
  element.textContent = message || "";
  element.hidden = !message;
}
function connection(connected) {
  state.connected = connected;
  byId("connection").className =
    `connection ${connected ? "connected" : "disconnected"}`;
  byId("connection-text").textContent = connected
    ? state.context?.mode === "local"
      ? "Tryb lokalny"
      : "Uwierzytelniono"
    : "Brak połączenia";
  updateButtons();
}
function clearSessionView(message) {
  state.context = null;
  state.detail = null;
  state.selectedId = null;
  state.runs = [];
  state.detailSignature = "";
  state.historySignature = "";
  state.draftKey = null;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  for (const id of ["principal", "tenant", "roles", "policy"])
    byId(id).textContent = "—";
  byId("tool-list").replaceChildren();
  byId("run-detail").replaceChildren(node("p", "empty-state", message));
  renderHistory();
  connection(false);
}
function updateButtons() {
  byId("create-plan").disabled =
    state.busy || !state.connected || !hasRole("operator");
  document.querySelectorAll("[data-mutation]").forEach((element) => {
    element.disabled =
      state.busy || !state.connected || element.dataset.permitted !== "true";
  });
  byId("run-detail").setAttribute("aria-busy", String(state.busy));
}
function actionButton(label, className, action, role = "operator") {
  const button = node("button", `button ${className}`, label);
  button.type = "button";
  button.dataset.mutation = "true";
  button.dataset.permitted = String(hasRole(role));
  if (!hasRole(role))
    button.title = `Wymagana rola: ${roleNames[role] || role}`;
  button.addEventListener("click", action);
  return button;
}
async function api(path, body) {
  const epoch = state.authEpoch;
  const headers = { Accept: "application/json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (epoch !== state.authEpoch) {
    const error = new Error("Pominięto odpowiedź wcześniejszej sesji.");
    error.staleSession = true;
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401) byId("access").open = true;
    const message =
      data.message ||
      data.error?.message ||
      (typeof data.error === "string" ? data.error : null);
    const error = new Error(
      message ||
        (response.status === 401
          ? "Ta instancja wymaga prawidłowego tokenu dostępu."
          : `Żądanie nie powiodło się (HTTP ${response.status}).`),
    );
    error.status = response.status;
    throw error;
  }
  return data;
}

function renderContext() {
  const context = state.context;
  byId("principal").textContent = context.principal.id;
  byId("tenant").textContent = context.principal.tenantId;
  byId("roles").textContent =
    context.principal.roles
      .map((role) => roleNames[role] || role)
      .join(" · ") || "Brak";
  byId("policy").textContent =
    `${context.policy.name} · ${context.policy.version}`;
  byId("planner").textContent = ["demo", "deterministic"].includes(
    context.planner.kind,
  )
    ? "Stały plan · bez AI"
    : `Planer: ${context.planner.kind}`;
  const list = byId("tool-list");
  list.replaceChildren();
  for (const tool of context.tools || []) {
    const row = node("div", "tool-row");
    row.append(
      node("code", "", tool.id),
      node("span", "effect", effectNames[tool.effect] || tool.effect),
      node("p", "", tool.description),
    );
    list.append(row);
  }
  if (!hasRole("operator"))
    byId("request-hint").textContent =
      "Tworzenie planów wymaga roli Operator. Możesz przeglądać historię zgodnie ze swoimi uprawnieniami.";
  else
    byId("request-hint").textContent =
      "Utworzenie planu nie uruchamia jego kroków.";
}

function renderHistory() {
  const signature = json([state.runs, state.selectedId]);
  if (signature === state.historySignature) return;
  state.historySignature = signature;
  const list = byId("run-list");
  list.replaceChildren();
  byId("run-count").textContent = state.runs.length;
  if (!state.runs.length) {
    list.append(node("p", "history-empty", "Brak zapisanych wykonań."));
    return;
  }
  for (const run of state.runs) {
    const button = node("button", "history-item");
    button.type = "button";
    button.setAttribute("aria-current", String(run.id === state.selectedId));
    button.append(node("span", "history-item-title", run.title));
    if (run.request)
      button.append(
        node(
          "span",
          "history-item-request",
          run.request.length > 96
            ? `${run.request.slice(0, 96)}…`
            : run.request,
        ),
      );
    const meta = node("span", "history-item-meta");
    meta.append(badge(run.status), node("span", "", date(run.createdAt, true)));
    button.append(meta);
    button.addEventListener("click", () => selectRun(run.id));
    list.append(button);
  }
}

function disclosure(title, value, className = "step-details") {
  const details = node("details", className);
  details.append(node("summary", "", title), node("pre", "", json(value)));
  return details;
}
function metadataRow(label, value) {
  const row = node("div", "meta-row");
  row.append(node("dt", "", label), node("dd", "mono", value || "—"));
  return row;
}
function renderEvidence(verification) {
  const box = node(
    "div",
    `evidence ${verification.ok ? "" : "failed-verification"}`,
  );
  box.append(
    node(
      "p",
      "evidence-heading",
      verification.ok
        ? "Wynik potwierdzony"
        : "Weryfikacja nie potwierdziła wyniku",
    ),
    node("p", "evidence-summary", verification.summary),
  );
  for (const evidence of verification.evidence || []) {
    box.append(
      node("p", "evidence-source", `Źródło: ${evidence.source}`),
      node("p", "evidence-time", `Odczytano: ${date(evidence.observedAt)}`),
    );
    if (evidence.summary && evidence.summary !== verification.summary)
      box.append(node("p", "evidence-summary", evidence.summary));
    box.append(disclosure("Dane źródłowe", evidence.data, ""));
  }
  return box;
}
function renderApproval(run, step) {
  const approval = step.approval;
  if (!approval) return null;
  if (approval.status !== "pending" || step.status !== "waiting_approval") {
    const record = node("p", "approval-record");
    record.append(node("span", "", "Decyzja: "), badge(approval.status));
    if (approval.decidedBy)
      record.append(node("span", "", ` · ${approval.decidedBy}`));
    return record;
  }
  const box = node("section", "approval-box");
  box.setAttribute("aria-label", `Zatwierdzenie kroku: ${step.title}`);
  box.append(
    node("h3", "", "Ten zapis wymaga Twojej decyzji"),
    node(
      "p",
      "",
      "Zgoda dotyczy dokładnie poniższego narzędzia i danych. Sprawdź zakres przed zatwierdzeniem.",
    ),
    node("span", "field-label", "Narzędzie"),
    node("code", "", step.toolId),
    node("span", "field-label", "Dane operacji"),
    node("pre", "", json(step.input)),
    node("span", "field-label", "Powiązanie zgody z operacją"),
    node("code", "approval-binding", approval.bindingHash),
  );
  const actions = node("div", "button-row");
  const decide = (decision) =>
    mutateRun(
      run.id,
      "approve",
      { approvalId: approval.id, bindingHash: approval.bindingHash, decision },
      decision === "approved"
        ? "Zgoda zapisana. Sprawdź wynik wykonania i dowody."
        : "Operacja została odrzucona.",
    );
  actions.append(
    actionButton(
      "Zatwierdź tę operację",
      "primary",
      () => decide("approved"),
      "approver",
    ),
    actionButton("Odrzuć", "danger", () => decide("rejected"), "approver"),
  );
  box.append(actions);
  if (!hasRole("approver"))
    box.append(
      node("p", "hint", "Podjęcie decyzji wymaga roli Zatwierdzający."),
    );
  return box;
}
function renderRun(force = false) {
  const run = state.detail;
  if (!run) return;
  const signature = json([run, state.context?.principal]);
  if (!force && signature === state.detailSignature) return;
  state.detailSignature = signature;
  const container = byId("run-detail");
  const openDetails = new Set(
    [...container.querySelectorAll("details[open]")]
      .map((element) => element.dataset.key)
      .filter(Boolean),
  );
  const focusedAction = document.activeElement?.dataset.focusKey;
  container.replaceChildren();
  const header = node("div", "run-header");
  const top = node("div", "run-header-top");
  top.append(node("h2", "", run.title), badge(run.status));
  header.append(
    top,
    node("p", "run-summary", run.plan?.summary || run.request),
  );
  const meta = node("div", "run-meta");
  meta.append(
    node("span", "", `Utworzono ${date(run.createdAt)}`),
    node("span", "", `Aktualizacja ${date(run.updatedAt)}`),
  );
  header.append(meta);
  const actions = node("div", "button-row run-actions");
  if (run.status === "planned")
    actions.append(
      actionButton("Uruchom plan", "primary", () =>
        mutateRun(
          run.id,
          "start",
          {},
          "Plan uruchomiony. Śledź kroki poniżej.",
        ),
      ),
    );
  const incompleteStep = (run.steps || []).find(
    (step) => step.status !== "succeeded",
  );
  if (
    ["needs_reconciliation", "failed", "blocked"].includes(run.status) &&
    incompleteStep &&
    (incompleteStep.status === "unknown" || incompleteStep.output)
  )
    actions.append(
      actionButton("Sprawdź wynik ponownie", "secondary", () =>
        mutateRun(
          run.id,
          "retry",
          {},
          "Zlecono uzgodnienie lub ponowną weryfikację zapisanego wyniku.",
        ),
      ),
    );
  if (!["completed", "cancelled"].includes(run.status))
    actions.append(
      actionButton("Anuluj wykonanie", "secondary", () =>
        mutateRun(
          run.id,
          "cancel",
          {},
          "Wykonanie anulowane. Wcześniejsze operacje zachowują swoją historię.",
        ),
      ),
    );
  if (actions.childElementCount) header.append(actions);
  if (run.status === "needs_reconciliation")
    header.append(
      node(
        "p",
        "message notice",
        "Wynik operacji jest nieustalony. Sprawdź historię i stan źródła przed podjęciem dalszej decyzji.",
      ),
    );
  const details = node("details", "run-meta-details");
  details.dataset.key = "run-metadata";
  details.append(node("summary", "", "Żądanie i identyfikatory"));
  const metadata = node("dl");
  metadata.append(
    metadataRow("Żądanie", run.request),
    metadataRow("Wykonanie", run.id),
    metadataRow("Hash planu", run.planHash),
    metadataRow("Wersja polityki", run.policyVersion),
  );
  details.append(metadata);
  header.append(details);
  container.append(header);

  const steps = run.steps || [];
  const heading = node("div", "steps-heading");
  heading.append(
    node("h3", "", "Przebieg wykonania"),
    node(
      "span",
      "",
      `${steps.filter((step) => step.status === "succeeded").length} z ${steps.length} kroków zweryfikowanych`,
    ),
  );
  container.append(heading);
  const list = node("ol", "steps");
  steps.forEach((step, index) => {
    const item = node(
      "li",
      `step ${Object.hasOwn(statusNames, step.status) ? step.status : ""}`,
    );
    item.append(
      node(
        "span",
        "step-number",
        step.status === "succeeded" ? "✓" : String(index + 1).padStart(2, "0"),
      ),
    );
    const head = node("div", "step-head");
    head.append(
      node("h3", "", step.title),
      badge(
        run.status === "cancelled" && step.status === "pending"
          ? "not_run"
          : step.status,
      ),
    );
    item.append(head);
    const tool = state.context?.tools?.find(
      (candidate) => candidate.id === step.toolId,
    );
    const subtitle = node("div", "step-subtitle");
    subtitle.append(node("code", "", step.toolId));
    if (tool)
      subtitle.append(
        node("span", "effect", effectNames[tool.effect] || tool.effect),
      );
    subtitle.append(node("span", "", `Próby: ${step.attempts || 0}`));
    item.append(subtitle);
    if (tool) item.append(node("p", "step-description", tool.description));
    const input = disclosure("Dane wejściowe operacji", step.input);
    input.dataset.key = `${step.id}-input`;
    item.append(input);
    const approval = renderApproval(run, step);
    if (approval) item.append(approval);
    if (step.error)
      item.append(
        node(
          "p",
          "message error",
          typeof step.error === "string" ? step.error : json(step.error),
        ),
      );
    if (step.verification) item.append(renderEvidence(step.verification));
    if (step.output !== undefined && step.output !== null) {
      const output = disclosure("Pełny wynik narzędzia", step.output);
      output.dataset.key = `${step.id}-output`;
      item.append(output);
    }
    list.append(item);
  });
  container.append(list);
  const log = node("details", "event-log");
  log.dataset.key = "event-log";
  log.append(
    node("summary", "", `Dziennik zdarzeń (${(run.events || []).length})`),
  );
  const events = node("ol", "events");
  for (const event of run.events || []) {
    const row = node("li", "event");
    const timestamp = node("time", "", date(event.createdAt));
    if (event.createdAt && !Number.isNaN(new Date(event.createdAt).getTime()))
      timestamp.dateTime = new Date(event.createdAt).toISOString();
    const content = node("div");
    content.append(
      node("span", "event-type", eventNames[event.type] || event.type),
    );
    const data = disclosure("Szczegóły zdarzenia", event.details, "");
    data.dataset.key = `event-${event.id}`;
    content.append(data);
    row.append(timestamp, content);
    events.append(row);
  }
  log.append(events);
  container.append(log);
  container.querySelectorAll("details").forEach((element) => {
    if (openDetails.has(element.dataset.key)) element.open = true;
  });
  container.querySelectorAll("[data-mutation]").forEach((element, index) => {
    element.dataset.focusKey = `${run.id}-action-${index}`;
  });
  if (focusedAction)
    [...container.querySelectorAll("[data-focus-key]")]
      .find((element) => element.dataset.focusKey === focusedAction)
      ?.focus({ preventScroll: true });
  updateButtons();
}

async function loadRun(id) {
  const data = await api(`/runs/${encodeURIComponent(id)}`);
  if (state.selectedId !== id) return;
  state.detail = data.run;
  renderRun();
}
async function selectRun(id) {
  state.selectedId = id;
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}#run=${encodeURIComponent(id)}`,
  );
  renderHistory();
  showMessage("error", "");
  try {
    await loadRun(id);
  } catch (error) {
    if (!error.staleSession) showMessage("error", error.message);
  }
}
async function refreshHistory() {
  const data = await api("/runs");
  state.runs = data.runs || [];
  renderHistory();
}
async function refresh({ explicit = false } = {}) {
  if (state.refreshing || state.busy) return;
  state.refreshing = true;
  try {
    await refreshHistory();
    if (state.selectedId) await loadRun(state.selectedId);
    connection(true);
    if (explicit) {
      showMessage("error", "");
      showMessage("notice", "Historia odświeżona.");
    }
  } catch (error) {
    if (error.staleSession) return;
    connection(false);
    showMessage("error", `Nie udało się odświeżyć danych. ${error.message}`);
  } finally {
    state.refreshing = false;
  }
}
async function connect() {
  try {
    const context = await api("/context");
    const previousIdentity = state.context
      ? json(state.context.principal)
      : null;
    if (previousIdentity && previousIdentity !== json(context.principal)) {
      state.detail = null;
      state.selectedId = null;
      state.runs = [];
      state.detailSignature = "";
      state.historySignature = "";
      byId("run-detail").replaceChildren(
        node(
          "p",
          "empty-state",
          "Zmieniono kontekst dostępu. Wybierz wykonanie z historii.",
        ),
      );
    }
    state.context = context;
    renderContext();
    connection(true);
    showMessage("error", "");
    await refresh();
    if (state.detail) renderRun(true);
  } catch (error) {
    if (error.staleSession) return;
    connection(false);
    showMessage("error", error.message);
  }
}
async function mutateRun(id, endpoint, body, message) {
  if (state.busy) return;
  state.busy = true;
  updateButtons();
  showMessage("error", "");
  showMessage("notice", "");
  try {
    const result = await api(
      `/runs/${encodeURIComponent(id)}/${endpoint}`,
      body,
    );
    await refreshHistory();
    if (state.selectedId === id) await loadRun(id);
    showMessage(
      "notice",
      endpoint === "cancel" && result.run?.status === "needs_reconciliation"
        ? "Zlecono zatrzymanie. Wynik rozpoczętej operacji wymaga jeszcze uzgodnienia."
        : message,
    );
  } catch (error) {
    showMessage("error", error.message);
    if (state.selectedId === id) await loadRun(id).catch(() => {});
  } finally {
    state.busy = false;
    updateButtons();
  }
}

byId("request").addEventListener("input", () => {
  state.draftKey = null;
});
byId("example").addEventListener("click", () => {
  byId("request").value =
    "Przygotuj demonstracyjne przekazanie wygranego deala do realizacji. Sprawdź kompletność danych, a przed zapisem poproś o moją zgodę.";
  state.draftKey = null;
  byId("request").focus();
});
byId("request-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy || !hasRole("operator")) return;
  const request = byId("request").value.trim();
  if (request.length < 3) {
    showMessage("error", "Opisz zadanie, używając przynajmniej 3 znaków.");
    return;
  }
  state.busy = true;
  updateButtons();
  showMessage("error", "");
  showMessage("notice", "");
  state.draftKey ||= crypto.randomUUID();
  try {
    const data = await api("/runs", {
      request,
      idempotencyKey: state.draftKey,
    });
    state.selectedId = data.run.id;
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}#run=${encodeURIComponent(data.run.id)}`,
    );
    await refreshHistory();
    await loadRun(state.selectedId);
    showMessage(
      "notice",
      state.detail?.status === "planned"
        ? "Plan zapisany. Sprawdź kroki i wybierz „Uruchom plan”, aby rozpocząć."
        : "To żądanie ma już zapisane wykonanie. Pokazano jego aktualny stan.",
    );
  } catch (error) {
    showMessage("error", error.message);
  } finally {
    state.busy = false;
    updateButtons();
  }
});
byId("access-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  state.authEpoch += 1;
  state.refreshing = false;
  state.token = byId("token").value.trim();
  byId("token").value = "";
  clearSessionView(
    "Łączenie z instancją. Dane poprzedniej sesji zostały wyczyszczone.",
  );
  await connect();
  if (state.connected) byId("access").open = false;
});
byId("clear-token").addEventListener("click", async () => {
  if (state.busy) return;
  state.authEpoch += 1;
  state.refreshing = false;
  state.token = "";
  byId("token").value = "";
  clearSessionView(
    "Token usunięty. Dane wcześniejszej sesji zostały wyczyszczone.",
  );
  showMessage("notice", "Token usunięty z pamięci karty.");
  await connect();
});
byId("refresh").addEventListener("click", () =>
  state.context ? refresh({ explicit: true }) : connect(),
);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.context) refresh();
});
setInterval(() => {
  if (!document.hidden && state.context) refresh();
}, 5000);
connect();
