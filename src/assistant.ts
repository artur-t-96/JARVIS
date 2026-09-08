import type { Diagnostics } from "./diagnostics.js";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z, ZodError } from "zod";
import {
  DomainError,
  hasToolAccess,
  type JsonObject,
  type Plan,
  type Principal,
  type ToolDefinition,
} from "./contracts.js";
import { Engine, hash } from "./engine.js";
import { WorkspaceStore } from "./workspace.js";
import { migrateDatabase } from "./migrations.js";
import {
  AssistantDraftStore,
  type DraftClaim,
  type DraftTurnBody,
  type NeedDraft,
  type PreparedProposal,
  conversationAuthority,
} from "./assistant-drafts.js";
import {
  ContextBroker,
  type BrokerCompanyProfile,
  type ContextTurn,
} from "./context-broker.js";
import {
  askBusinessModel,
  type BusinessModelOptions,
} from "./business-model.js";
import { advanceEquipment } from "./equipment-conversation.js";
export type { BusinessModelOptions } from "./business-model.js";

export type MessageKind = "answer" | "needs_input" | "ready" | "unsupported";
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  kind?: MessageKind;
  runId?: string;
  createdAt: string;
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  draft?: NeedDraft;
  pendingTurn?: ReturnType<AssistantDraftStore["pending"]>;
}
type Row = Record<string, unknown>;
interface Slots {
  intent?: "reserve" | "create";
  module?: string;
  personId?: string;
  assetId?: string;
  until?: string;
  title?: string;
  data?: JsonObject;
  pending?: string;
}
interface Proposal {
  kind: MessageKind;
  message: string;
  plan?: Plan;
  slots?: Slots;
}
const folded = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .toLowerCase();

export class Conversations {
  private db: DatabaseSync;
  private drafts: AssistantDraftStore;
  private broker: ContextBroker;
  private principalProvider?: (tenantId: string) => Principal[];
  constructor(
    path: string,
    private workspace: WorkspaceStore,
    private engine: Engine,
    private tools: ToolDefinition[],
    private model?: BusinessModelOptions,
    private diagnostics?: Diagnostics,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    migrateDatabase(this.db, {
      namespace: "assistant",
      migrations: [
        {
          version: 1,
          name: "private conversations",
          up: (db) =>
            db.exec(`
  CREATE TABLE IF NOT EXISTS assistant_schema(version INTEGER PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,actor_id TEXT NOT NULL,title TEXT NOT NULL,slots_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,authority_hash TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,kind TEXT,run_id TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS chat_requests(conversation_id TEXT NOT NULL,request_key TEXT NOT NULL,input_hash TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(conversation_id,request_key));
  CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,model TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,status TEXT NOT NULL,created_at TEXT NOT NULL);
  INSERT OR IGNORE INTO assistant_schema VALUES(1);`),
        },
        {
          version: 2,
          name: "authority binding and model accounting",
          up: () => {
            const columns = this.db
              .prepare("PRAGMA table_info(conversations)")
              .all() as Row[];
            if (!columns.some((c) => c.name === "authority_hash"))
              this.db.exec(
                "ALTER TABLE conversations ADD COLUMN authority_hash TEXT NOT NULL DEFAULT ''",
              );
            const usageColumns = this.db
              .prepare("PRAGMA table_info(model_usage)")
              .all() as Row[];
            if (!usageColumns.some((c) => c.name === "duration_ms"))
              this.db.exec(
                "ALTER TABLE model_usage ADD COLUMN duration_ms INTEGER; ALTER TABLE model_usage ADD COLUMN estimated_cost REAL; ALTER TABLE model_usage ADD COLUMN pricing_json TEXT;",
              );
          },
        },
      ],
    });
    if (model?.pricing)
      z.object({
        version: z.string().min(1).max(80),
        currency: z.enum(["USD", "PLN", "EUR"]),
        inputPerMillion: z.number().finite().nonnegative(),
        outputPerMillion: z.number().finite().nonnegative(),
      })
        .strict()
        .parse(model.pricing);
    if (
      Number(
        (
          this.db
            .prepare("SELECT MAX(version) AS v FROM assistant_schema")
            .get() as Row
        ).v,
      ) !== 1
    )
      throw new Error("Unsupported assistant schema");
    this.drafts = new AssistantDraftStore(this.db);
    this.broker = new ContextBroker(this.db, workspace);
  }
  setPrincipalProvider(provider: (tenantId: string) => Principal[]) {
    this.principalProvider = provider;
    this.drafts.setPrincipalProvider((tenantId, actorId) =>
      provider(tenantId).find((p) => p.id === actorId),
    );
    this.broker.setPrincipalProvider(provider);
  }
  setCompanyProvider(provider: (tenantId: string) => BrokerCompanyProfile) {
    this.broker.setCompanyProvider(provider);
  }
  private authority(p: Principal) {
    return hash({
      roles: [...p.roles].sort(),
      scopes: [...(p.scopes ?? [])].sort(),
    });
  }
  private actor(p: Principal) {
    const live = this.principalProvider?.(p.tenantId).find(
      (actor) => actor.id === p.id,
    );
    if (
      !live ||
      live.tenantId !== p.tenantId ||
      !live.roles.includes("operator")
    )
      throw new DomainError(
        "FORBIDDEN",
        "Rozmowa wykonawcza wymaga roli operatora.",
        403,
      );
    if (conversationAuthority(live) !== conversationAuthority(p))
      throw new DomainError(
        "CONVERSATION_AUTHORITY_CHANGED",
        "Uprawnienia zmieniły się. Rozpocznij nową rozmowę.",
        403,
      );
  }
  private row(p: Principal, id: string) {
    this.actor(p);
    const live = this.principalProvider!(p.tenantId).find(
      (actor) => actor.id === p.id,
    )!;
    if (conversationAuthority(live) !== conversationAuthority(p))
      throw new DomainError(
        "CONVERSATION_AUTHORITY_CHANGED",
        "Uprawnienia zmieniły się. Rozpocznij nową rozmowę.",
        403,
      );
    const r = this.db
      .prepare(
        "SELECT * FROM conversations WHERE id=? AND tenant_id=? AND actor_id=?",
      )
      .get(id, p.tenantId, p.id) as Row | undefined;
    if (!r) throw new DomainError("NOT_FOUND", "Nie znaleziono rozmowy.", 404);
    if (r.authority_hash !== this.authority(p))
      throw new DomainError(
        "CONVERSATION_AUTHORITY_CHANGED",
        "Uprawnienia zmieniły się. Rozpocznij nową rozmowę.",
        403,
      );
    return r;
  }
  create(p: Principal): Conversation {
    this.actor(p);
    const live = this.principalProvider!(p.tenantId).find(
      (actor) => actor.id === p.id,
    )!;
    if (conversationAuthority(live) !== conversationAuthority(p))
      throw new DomainError(
        "CONVERSATION_AUTHORITY_CHANGED",
        "Uprawnienia zmieniły się.",
        403,
      );
    const id = randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)")
      .run(
        id,
        p.tenantId,
        p.id,
        "Nowa rozmowa",
        "{}",
        now,
        now,
        this.authority(p),
      );
    return this.get(p, id);
  }
  list(p: Principal) {
    this.actor(p);
    return (
      this.db
        .prepare(
          "SELECT id,title,created_at,updated_at FROM conversations WHERE tenant_id=? AND actor_id=? AND authority_hash=? ORDER BY updated_at DESC LIMIT 100",
        )
        .all(p.tenantId, p.id, this.authority(p)) as Row[]
    ).map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }
  get(p: Principal, id: string): Conversation {
    const r = this.row(p, id);
    const messages = (
      this.db
        .prepare(
          "SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY rowid",
        )
        .all(id) as Row[]
    ).map((m) => ({
      id: String(m.id),
      role: m.role as ChatMessage["role"],
      content: String(m.content),
      ...(m.kind ? { kind: m.kind as MessageKind } : {}),
      ...(m.run_id ? { runId: String(m.run_id) } : {}),
      createdAt: String(m.created_at),
    }));
    return {
      id,
      title: String(r.title),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      messages,
      ...(this.drafts.get(p, id)
        ? { draft: this.liveDraft(p, this.drafts.get(p, id)!) }
        : {}),
      ...(this.drafts.pending(p, id)
        ? { pendingTurn: this.drafts.pending(p, id) }
        : {}),
    };
  }
  usage(p: Principal) {
    this.actor(p);
    return this.db
      .prepare(
        "SELECT model,status,COUNT(*) AS calls,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,AVG(duration_ms) AS averageLatencyMs,SUM(estimated_cost) AS estimatedCost,pricing_json AS pricing FROM model_usage WHERE tenant_id=? GROUP BY model,status,pricing_json",
      )
      .all(p.tenantId);
  }
  private allowed(p: Principal) {
    return this.tools.filter((t) => hasToolAccess(p, t));
  }
  private ready(toolId: string, input: JsonObject, message: string): Proposal {
    return {
      kind: "ready",
      message,
      slots: {},
      plan: {
        title: message.slice(0, 160),
        summary:
          "Plan dotyczy lokalnych danych JARVIS. Każdy zapis wymaga sprawdzenia i zgody.",
        steps: [
          { id: "operation", title: message.slice(0, 160), toolId, input },
        ],
      },
    };
  }
  private offline(p: Principal, text: string, previous: Slots): Proposal {
    const t = folded(text),
      slots = { ...previous };
    if (/^(anuluj|nowe zadanie|zacznij od nowa)/.test(t))
      return {
        kind: "answer",
        message:
          "Wyczyściłem szkic rozmowy. Istniejące wykonania pozostają w historii.",
        slots: {},
      };
    if (
      !slots.intent &&
      /(sprawdz|zdiagnozuj)/.test(t) &&
      /(laboratorium|it|uslug)/.test(t)
    )
      return this.ready(
        "lab.inspect",
        {},
        "Diagnostyka lokalnego laboratorium",
      );
    if (!slots.intent && /^(dodaj|utworz|zarejestruj)/.test(t)) {
      const words: Record<string, RegExp> = {
        people: /(osob|pracownik)/,
        cases: /(spraw|onboarding|offboarding)/,
        assets: /(sprzet|urzadzen|laptop)/,
        purchases: /(zakup|dostawc|zamowien)/,
        licenses: /licencj/,
        sales: /(sprzedaz|klient|ofert|szans)/,
        recruitment: /(rekrutac|kandyd|wakat)/,
        documents: /(dokument|raport|zasad)/,
        it: /(incydent|obserwac|problem it)/,
      };
      const module = Object.entries(words).find(([, regex]) =>
        regex.test(t),
      )?.[0];
      if (module) {
        slots.intent = "create";
        slots.module = module;
        slots.data = {};
      }
    }
    if (slots.intent === "create" && slots.module) {
      const def = this.workspace.catalog().find((m) => m.id === slots.module)!;
      if (
        !this.allowed(p).some(
          (tool) => tool.id === `ops.${slots.module}.create`,
        )
      )
        throw new DomainError(
          "FORBIDDEN",
          "Brak uprawnienia do tego modułu.",
          403,
        );
      if (slots.pending === "title") slots.title = text.trim();
      else if (slots.pending) {
        const field = def.fields.find((f) => f.key === slots.pending)!;
        let value: string | number | boolean = text.trim();
        if (field.type === "number") {
          value = Number(text);
          if (!Number.isFinite(value))
            return {
              kind: "needs_input",
              message: "Podaj poprawną liczbę.",
              slots,
            };
        }
        if (field.type === "boolean") value = /^(tak|true|1)$/i.test(text);
        if (field.options && !field.options.includes(String(value)))
          return {
            kind: "needs_input",
            message: `Wybierz: ${field.options.join(", ")}.`,
            slots,
          };
        slots.data = { ...slots.data, [slots.pending]: value };
      }
      if (!slots.title)
        return {
          kind: "needs_input",
          message: `Podaj tytuł/nazwę nowego wpisu: ${def.label}.`,
          slots: { ...slots, pending: "title" },
        };
      const missing = def.fields.find(
        (f) => f.required && slots.data?.[f.key] === undefined,
      );
      if (missing)
        return {
          kind: "needs_input",
          message: `${missing.label}${missing.options ? ` — wybierz ${missing.options.join(", ")}` : ""}.`,
          slots: { ...slots, pending: missing.key },
        };
      return this.ready(
        `ops.${slots.module}.create`,
        { title: slots.title, data: slots.data ?? {} },
        `Dodanie: ${slots.title}`,
      );
    }
    return {
      kind: "unsupported",
      message:
        "Nie rozpoznałem obsługiwanej potrzeby. Mogę przygotować wyposażenie dla konkretnej współpracy, zebrać dane nowego wpisu lub sprawdzić powiązane wykonanie. Opisz rezultat, którego potrzebujesz.",
      slots,
    };
  }
  private liveDraft(p: Principal, stored: NeedDraft): NeedDraft {
    const draft = structuredClone(stored);
    let last: ReturnType<Engine["getRun"]> | undefined;
    draft.linkedRuns = draft.linkedRuns.map((link) => {
      try {
        const run = this.engine.getRun(p, link.runId);
        last = run;
        return {
          runId: run.id,
          status: run.status,
          title: run.title.slice(0, 240),
        };
      } catch {
        return {
          ...link,
          status: "unavailable",
          title: "Wykonanie niedostępne",
        };
      }
    });
    if (
      last &&
      [
        "planned",
        "awaiting_approval",
        "in_progress",
        "completed",
        "blocked",
      ].includes(stored.phase)
    ) {
      if (last.status === "waiting_approval") draft.phase = "awaiting_approval";
      else if (["running", "waiting_human"].includes(last.status))
        draft.phase = "in_progress";
      else if (
        ["blocked", "failed", "needs_reconciliation"].includes(last.status)
      )
        draft.phase = "blocked";
      else if (last.status === "cancelled") draft.phase = "cancelled";
      else if (last.status === "completed") {
        draft.phase =
          draft.intent === "equipment_request" ? "in_progress" : "completed";
        if (draft.intent === "equipment_request")
          draft.blockedReason =
            "Rezerwacja została zweryfikowana. Fizyczne wydanie i odbiór gotowości wymagają osobnych dowodów w sprawie.";
      }
    }
    if (stored.phase === "blocked" && stored.blockedReason) {
      draft.phase = "blocked";
      draft.blockedReason = stored.blockedReason;
    }
    return draft;
  }
  private followup(
    p: Principal,
    claim: DraftClaim,
    turn: ContextTurn,
  ): PreparedProposal {
    const draft = this.liveDraft(p, claim.draft);
    let message = draft.linkedRuns
      .map((link) => `${link.title}: ${runLabel(link.status)}.`)
      .join("\n");
    if (draft.intent === "equipment_request")
      message +=
        "\nRezerwacja nie potwierdza fizycznego wydania ani gotowości onboardingu.";
    if (draft.case) {
      try {
        const saved = (
          claim.state.equipment as
            { records?: { case?: { source?: { id?: string } } } } | undefined
        )?.records?.case?.source?.id;
        const caseId =
          saved ?? this.broker.resolve(turn, draft.case.ref, "case").id;
        const c = this.broker.reference(
          turn,
          { module: "cases", id: caseId },
          "case_followup",
        ).items[0]!;
        draft.case = { ref: c.ref, label: c.label };
        draft.sources = [
          {
            label: c.label,
            module: c.source.module,
            version: c.source.version,
            observedAt: c.source.observedAt,
            freshness: "current",
            ...(c.source.updatedAt ? { updatedAt: c.source.updatedAt } : {}),
          },
        ];
        message += `\n${c.label}: ${c.data.acceptanceCurrent ? "odbiór aktualny" : "odbiór niepotwierdzony"}; brakujące wymagania: ${c.data.missingRequirementCount}, blokady zadań: ${c.data.taskBlockerCount}. Odczyt ${c.source.observedAt}.`;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        draft.sources = (draft.sources ?? []).map((source) => ({
          ...source,
          freshness: "stale" as const,
        }));
        message +=
          "\nŹródło sprawy zmieniło się lub wygasło. Otwórz sprawę, aby ponownie sprawdzić aktualne wymagania. Historia rozmowy zachowuje dawny odczyt.";
      }
    }
    return {
      draft,
      message:
        message || "Szkic nie ma jeszcze wykonania. Uzupełnij brakujące dane.",
      kind: "answer",
      state: claim.state,
    };
  }
  private changeScope(
    p: Principal,
    claim: DraftClaim,
    text: string,
  ): PreparedProposal {
    // Only a wholly unexecuted proposal can be replaced. Do not erase an uncertain or committed effect.
    const runs = claim.draft.linkedRuns.map((link) =>
      this.engine.getRun(p, link.runId),
    );
    const unsafe = runs.some(
      (run) =>
        run.status === "completed" ||
        run.steps.some((step) => step.attempts > 0),
    );
    if (unsafe)
      return {
        draft: {
          ...this.liveDraft(p, claim.draft),
          phase: "blocked",
          blockedReason:
            "Zakres ma rozpoczęte lub zapisane skutki. Uzgodnij wynik w wykonaniu przed zmianą osoby lub rozpocznij osobną rozmowę dla nowej potrzeby.",
        },
        kind: "needs_input",
        message:
          "Zakres ma już rozpoczęte lub zapisane skutki. Najpierw sprawdź wykonanie; zmiana szkicu nie cofnie operacji.",
        state: claim.state,
      };
    for (const run of runs) {
      if (run.status === "cancelled") continue;
      const cancelledRun = this.engine.cancel(p, run.id);
      if (
        cancelledRun.status !== "cancelled" ||
        cancelledRun.steps.some((step) => step.attempts > 0)
      )
        return {
          draft: {
            ...this.liveDraft(p, claim.draft),
            phase: "blocked",
            blockedReason:
              "Wykonanie rozpoczęło się podczas anulowania. Najpierw uzgodnij skutek w Core.",
          },
          state: claim.state,
          kind: "needs_input",
          message:
            "Wykonanie rozpoczęło się podczas anulowania. Najpierw uzgodnij jego skutek; dotychczasowy zakres zachowano.",
        };
    }
    const cancelled = /^anuluj/.test(folded(text));
    return {
      draft: {
        id: claim.draft.id,
        version: claim.draft.version,
        intent: cancelled ? "unknown" : "equipment_request",
        phase: cancelled ? "cancelled" : "collecting",
        missingFields: cancelled ? [] : ["person"],
        linkedRuns: runs.map((run) => ({
          runId: run.id,
          status: "cancelled",
          title: run.title.slice(0, 240),
        })),
      },
      state: {},
      kind: cancelled ? "answer" : "needs_input",
      message: cancelled
        ? "Szkic anulowany. Niewykonane propozycje anulowano w Core; historia pozostaje dostępna."
        : "Poprzednią niewykonaną propozycję anulowano. Podaj imię i nazwisko osoby dla nowego zakresu; przygotuję nowy plan i nową zgodę.",
    };
  }
  private async caseInformation(
    claim: DraftClaim,
    turn: ContextTurn,
  ): Promise<PreparedProposal> {
    const selected = claim.body.choiceRef;
    const previous = claim.state.followup as
      { module?: string; id?: string } | undefined;
    let record;
    if (selected) {
      const option = claim.draft.clarification?.options.find(
        (item) => item.ref === selected,
      );
      if (!option)
        throw new DomainError(
          "INVALID_CHOICE",
          "Wybierz bieżącą sprawę lub zadanie.",
        );
      const ref = this.broker.resolve(turn, selected);
      if (ref.kind !== "case" && ref.kind !== "task")
        throw new DomainError(
          "INVALID_CHOICE",
          "Wybór nie dotyczy sprawy lub zadania.",
        );
      record = this.broker.read(turn, "context.readRecord", {
        ref: selected,
        purpose: "case_followup",
      }).items[0]!;
    } else if (
      claim.draft.intent === "case_followup" &&
      previous?.module === "cases" &&
      previous.id &&
      !/^(pokaz|lista|inne)/.test(folded(claim.body.message))
    ) {
      // IDs are saved only from a broker-issued selection. Refresh preserves no prior authority.
      record = this.broker.reference(
        turn,
        { module: "cases", id: previous.id },
        "case_followup",
      ).items[0]!;
    }
    if (!record) {
      const page = this.broker.read(turn, "context.findCases", {
        state: "open",
        limit: 5,
      });
      const question = page.items.length
        ? "Którą sprawę lub zadanie mam sprawdzić?"
        : "Brak dostępnych otwartych spraw lub przypisanych zadań. Otwórz moduł Sprawy, aby przygotować nową potrzebę.";
      return {
        draft: {
          ...claim.draft,
          intent: "case_followup",
          phase: page.items.length ? "needs_choice" : "blocked",
          missingFields: ["case"],
          clarification: {
            kind: "case",
            question,
            options: page.items.map((item) => ({
              ref: item.ref,
              label: item.label,
              detail: `${item.kind === "task" ? "Zadanie" : "Sprawa"}; odczyt ${item.source.observedAt}`,
            })),
          },
        },
        message: question,
        kind: "needs_input",
        state: { ...claim.state, followup: {} },
      };
    }
    const fields = record.data;
    const status = String(fields.status ?? "brak wiedzy");
    const facts =
      record.kind === "case"
        ? `Stan: ${status}. Odbiór: ${fields.acceptanceCurrent ? "aktualny" : "niepotwierdzony"}. Brakujące wymagania: ${fields.missingRequirementCount}; blokady zadań: ${fields.taskBlockerCount}.`
        : `Stan zadania: ${status}. Termin: ${fields.dueDate ?? "brak"}. Niespełnione zależności: ${fields.blockedDependencies}.`;
    let message = `${record.label}\n${facts}\nŹródło: ${record.source.module}, wersja ${record.source.version}, odczyt ${record.source.observedAt}.`;
    if (this.model && record.kind === "case") {
      const suggestion = await askBusinessModel({
        db: this.db,
        options: this.model,
        diagnostics: this.diagnostics,
        broker: this.broker,
        turn,
        task: { intent: "case_followup", selectedRefs: { case: record.ref } },
        tools: this.tools,
      });
      // An information request never authorizes expanding the scope into a write.
      if (suggestion.plan)
        throw new DomainError(
          "INTENT_UNRESOLVED",
          "Pytanie o stan nie uzgadnia zakresu zapisu. Najpierw określ potrzebną zmianę.",
        );
      message += `\n\nSugestia asystenta — niepotwierdzona propozycja:\n${suggestion.message}`;
    }
    const draft: NeedDraft = {
      ...claim.draft,
      intent: "case_followup",
      phase: "collecting",
      missingFields: [],
      sources: [
        {
          label: record.label,
          module: record.source.module,
          version: record.source.version,
          observedAt: record.source.observedAt,
          freshness: "current",
          ...(record.source.updatedAt
            ? { updatedAt: record.source.updatedAt }
            : {}),
        },
      ],
    };
    delete draft.clarification;
    if (record.kind === "case")
      draft.case = { ref: record.ref, label: record.label };
    return {
      draft,
      message,
      kind: "answer",
      state: {
        ...claim.state,
        followup: { module: record.source.module, id: record.source.id },
      },
    };
  }
  private validateEquipmentProposal(
    turn: ContextTurn,
    canonical: Plan,
    proposed: Plan,
  ) {
    const step = proposed.steps[0],
      expected = canonical.steps[0]!;
    const fail = () => {
      throw new DomainError(
        "MODEL_SCOPE_CHANGED",
        "Propozycja modelu wykracza poza wybrane wyposażenie, współpracę lub termin. Uzgodniony szkic zachowano; model nie utworzył wykonania.",
        409,
      );
    };
    if (
      proposed.steps.length !== 1 ||
      !step ||
      step.toolId !== "ops.assets.reserve"
    )
      return fail();
    const input = { ...step.input };
    const kinds = {
      id: "asset",
      personId: "person",
      employmentEpisodeId: "episode",
      caseId: "case",
    } as const;
    for (const [field, kind] of Object.entries(kinds)) {
      if (typeof input[field] !== "string") return fail();
      const resolved = this.broker.resolve(turn, input[field] as string, kind);
      if (resolved.id !== expected.input[field]) return fail();
      input[field] = resolved.id;
      if (field === "id" && resolved.version !== expected.input.expectedVersion)
        return fail();
      if (
        field === "employmentEpisodeId" &&
        resolved.version !== expected.input.expectedEpisodeVersion
      )
        return fail();
    }
    for (const field of ["expectedVersion", "expectedEpisodeVersion", "until"])
      if (input[field] !== expected.input[field]) return fail();
    if (
      input.profileVersion !== undefined &&
      input.profileVersion !== expected.input.profileVersion
    )
      return fail();
    this.tools
      .find((tool) => tool.id === step.toolId)!
      .inputSchema.parse(input);
  }
  private async propose(
    p: Principal,
    claim: DraftClaim,
  ): Promise<PreparedProposal> {
    const text = claim.body.message,
      t = folded(text);
    const turn = this.broker.beginTurn(p, claim.conversationId, claim.turnId);
    if (/^(anuluj|nowe zadanie|zacznij od nowa|jednak dla|zmien osobe)/.test(t))
      return this.changeScope(p, claim, text);
    if (
      claim.draft.linkedRuns.some((link) => link.status !== "cancelled") &&
      /^(co dalej|status|kontynuuj|sprawdz|jak idzie)/.test(t)
    )
      return this.followup(p, claim, turn);
    if (
      claim.draft.intent === "equipment_request" ||
      ((claim.state.slots as Slots | undefined)?.intent !== "create" &&
        /(laptop|sprzet|komputer|monitor|telefon)/.test(t) &&
        /(przygotuj|zarezerwuj|dla)/.test(t))
    ) {
      if (claim.draft.linkedRuns.some((link) => link.status !== "cancelled"))
        return this.followup(p, claim, turn);
      const local = advanceEquipment({
        broker: this.broker,
        turn,
        claim,
        text,
        choiceRef: claim.body.choiceRef,
      });
      if (!local.plan || !this.model) return local;
      const draft = local.draft;
      const suggestion = await askBusinessModel({
        db: this.db,
        options: this.model,
        diagnostics: this.diagnostics,
        broker: this.broker,
        turn,
        task: {
          intent: "equipment_request",
          assetType: draft.assetType,
          readyOn: draft.readyOn,
          reservationUntil: draft.reservationUntil,
          selectedRefs: {
            person: draft.person!.ref,
            episode: draft.episode!.ref,
            asset: draft.asset!.ref,
            case: draft.case!.ref,
          },
        },
        tools: this.tools,
      });
      if (suggestion.plan)
        this.validateEquipmentProposal(turn, local.plan, suggestion.plan);
      // The local contract owns scope and wording of the operation. Provider text is
      // displayed only as an unverified suggestion, never a claim that it ran a tool.
      local.message += `\n\nSugestia asystenta — niepotwierdzona propozycja:\n${suggestion.message}`;
      return local;
    }
    if (
      (claim.state.slots as Slots | undefined)?.intent !== "create" &&
      (claim.draft.intent === "case_followup" ||
        /^(pokaz sprawy|moje zadania|lista spraw|co wymaga uwagi)/.test(t))
    )
      return this.caseInformation(claim, turn);
    if (claim.body.choiceRef)
      throw new DomainError(
        "INVALID_CHOICE",
        "Wybór nie dotyczy aktywnej potrzeby.",
      );
    const local = this.offline(p, text, (claim.state.slots ?? {}) as Slots);
    if (local.kind !== "unsupported")
      return {
        draft: {
          ...claim.draft,
          intent:
            local.slots?.intent ?? (local.plan ? "local_operation" : "unknown"),
          phase: local.plan ? "ready_to_plan" : "collecting",
          missingFields: local.slots?.pending ? [local.slots.pending] : [],
        },
        kind: local.kind,
        message: local.message,
        ...(local.plan ? { plan: local.plan } : {}),
        state: { slots: (local.slots ?? {}) as JsonObject },
      };
    if (!this.model)
      return {
        draft: {
          ...claim.draft,
          intent: "unknown",
          phase: "collecting",
          missingFields: ["intent"],
        },
        message: local.message,
        kind: "unsupported",
        state: claim.state,
      };
    const proposal = await askBusinessModel({
      db: this.db,
      options: this.model,
      diagnostics: this.diagnostics,
      broker: this.broker,
      turn,
      task: { intent: "unknown" },
      tools: this.tools,
    });
    // An unrecognized need has no agreed scope. A provider cannot turn it into a write.
    if (proposal.plan)
      throw new DomainError(
        "INTENT_UNRESOLVED",
        "Najpierw trzeba uzgodnić obsługiwaną potrzebę. Model nie może sam wybrać zakresu zapisu.",
      );
    return {
      draft: {
        ...claim.draft,
        intent: "unknown",
        phase: "collecting",
        missingFields: ["intent"],
      },
      message: `Sugestia asystenta — niepotwierdzona w rejestrach:\n${proposal.message}`,
      kind: proposal.kind === "ready" ? "needs_input" : proposal.kind,
      state: claim.state,
    };
  }
  async message(
    p: Principal,
    id: string,
    text: string,
    key: string,
    options: Omit<DraftTurnBody, "message"> = {},
  ): Promise<Conversation> {
    this.row(p, id);
    const claim = this.drafts.claim(p, id, key, { message: text, ...options });
    if (claim.replay) return this.get(p, id);
    try {
      if (!claim.prepared) {
        const recent = Number(
          (
            this.db
              .prepare(
                "SELECT COUNT(*) AS n FROM chat_messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.tenant_id=? AND c.actor_id=? AND m.role='user' AND m.created_at>?",
              )
              .get(
                p.tenantId,
                p.id,
                new Date(Date.now() - 60_000).toISOString(),
              ) as Row
          ).n,
        );
        if (recent >= 12)
          throw new DomainError(
            "RATE_LIMIT",
            "Limit 12 wiadomości na minutę.",
            429,
          );
        let proposal: PreparedProposal;
        try {
          proposal = await this.propose(p, claim);
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            ![
              "CONTEXT_READ_LIMIT",
              "CONTEXT_BYTE_LIMIT",
              "CONTEXT_SOURCE_STALE",
              "CONTEXT_REFERENCE_EXPIRED",
              "CONTEXT_MODEL_CALL_LIMIT",
            ].includes(error.code)
          )
            throw error;
          // A completed failed read has no business effect. Close this bounded turn so a
          // new user message can refresh context; never reset its durable read budget.
          const message =
            "Nie udało się uzyskać aktualnego kontekstu w granicach tej tury. Żadnego planu nie utworzono. Ponów pytanie, aby odczytać nowe źródła.";
          proposal = {
            draft: {
              ...claim.draft,
              phase: "blocked",
              blockedReason: message,
              sources: (claim.draft.sources ?? []).map((source) => ({
                ...source,
                freshness: "stale" as const,
              })),
            },
            kind: "needs_input",
            message,
            state: claim.state,
          };
        }
        if (proposal.plan)
          for (const step of proposal.plan.steps) {
            const tool = this.tools.find((tool) => tool.id === step.toolId);
            if (
              !tool ||
              !hasToolAccess(p, tool, step.input, { purpose: "propose" })
            )
              throw new DomainError(
                "FORBIDDEN_TOOL",
                "Brak uprawnienia do konkretnej operacji.",
                403,
              );
            // Pin defaults once, before durable sealing; recovery never changes a supplied pin.
            if (tool.prepareInput)
              step.input = tool.prepareInput(step.input, p.tenantId);
            tool.inputSchema.parse(step.input);
          }
        this.drafts.prepare(claim, proposal);
      }
      const prepared = claim.prepared!;
      this.drafts.assertCurrent(claim);
      let runId: string | undefined;
      if (prepared.plan) {
        const request = `Szkic ${prepared.draft.id}; tura ${claim.turnId}`;
        const existing = this.engine.replayRun(p, request, claim.engineKey);
        // Core rechecks registry, policy and concrete input even after proposal recovery.
        runId =
          existing?.id ??
          this.engine.createRun(p, request, prepared.plan, claim.engineKey).id;
      }
      this.drafts.finish(claim, runId);
      return this.get(p, id);
    } catch (error) {
      try {
        if (!claim.prepared && error instanceof ZodError)
          this.drafts.abandonBeforePlan(claim);
        else if (
          !claim.prepared &&
          error instanceof DomainError &&
          [
            "RATE_LIMIT",
            "INVALID_CHOICE",
            "FORBIDDEN_TOOL",
            "INTENT_UNRESOLVED",
          ].includes(error.code)
        )
          this.drafts.abandonBeforePlan(claim);
        else this.drafts.release(claim);
      } catch {
        /* A newer lease/authority owns recovery; never erase its proposal. */
      }
      throw error;
    }
  }
  async resume(p: Principal, id: string): Promise<Conversation> {
    this.row(p, id);
    const pending = this.drafts.pending(p, id);
    if (!pending) return this.get(p, id);
    return this.message(p, id, pending.message, pending.idempotencyKey, {
      ...(pending.choiceRef ? { choiceRef: pending.choiceRef } : {}),
      ...(pending.expectedDraftVersion !== undefined
        ? { expectedDraftVersion: pending.expectedDraftVersion }
        : {}),
    });
  }
  close() {
    this.db.close();
  }
}
const runLabel = (status: string): string =>
  ({
    planned: "plan przygotowany, jeszcze nieuruchomiony",
    waiting_approval: "oczekuje na zgodę",
    running: "wykonywane",
    completed: "operacje wykonane i niezależnie zweryfikowane",
    cancelled: "anulowane",
    failed: "błąd",
    blocked: "zablokowane",
    needs_reconciliation: "skutek wymaga uzgodnienia",
    unavailable: "brak aktualnego dostępu",
  })[status] ?? status;
