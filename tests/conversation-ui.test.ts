import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";

const options = {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
};
const {
  ConversationDraft,
  DraftChoicePanel,
  PendingConversationTurn,
  runStateCopy,
} = await tsImport("../web/src/ConversationDraft.tsx", options);
const {
  composerReducer,
  emptyComposer,
  prepareTurnRequest,
  latestConversation,
} = await tsImport("../web/src/conversation-turn.ts", options);

const draft = {
  id: "private-draft-id",
  version: 3,
  intent: "equipment_request",
  phase: "needs_choice",
  missingFields: ["personRef", "episodeRef", "readyOn"],
  linkedRuns: [],
};
const conversation = {
  id: "conversation-a",
  title: "Sprzęt dla Ani",
  createdAt: "2026-09-09T08:00:00Z",
  updatedAt: "2026-09-09T08:05:00Z",
  messages: [],
  draft,
};

test("loading a conversation draft cannot imply an empty successful workflow", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationDraft, {
      loading: true,
      onChoose: () => {},
      onOpenRun: () => {},
    }),
  );
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Pobieranie szkicu/);
  assert.doesNotMatch(html, /zakończone|Plan przygotowany/);
});

test("ambiguous people and employment episodes render local label choices, not opaque identifiers or editable UUID fields", () => {
  for (const clarification of [
    {
      kind: "person",
      question: "O którą Anię chodzi?",
      options: [
        { ref: "opaque-person-a", label: "Anna Kowalska", detail: "Operacje" },
        { ref: "opaque-person-b", label: "Anna Kowalska", detail: "Sprzedaż" },
      ],
    },
    {
      kind: "episode",
      question: "Której współpracy dotyczy sprzęt?",
      options: [
        {
          ref: "opaque-episode-a",
          label: "Projekt Alfa",
          detail: "Konsultant · od 1 września",
        },
        {
          ref: "opaque-episode-b",
          label: "Projekt Beta",
          detail: "Konsultant · od 15 września",
        },
      ],
    },
  ]) {
    const html = renderToStaticMarkup(
      createElement(DraftChoicePanel, {
        clarification,
        disabled: false,
        onChoose: () => {},
      }),
    );
    assert.equal((html.match(/class="draft-choice"/g) ?? []).length, 2);
    for (const option of clarification.options) {
      assert.ok(html.includes(option.label));
      assert.ok(html.includes(option.detail));
      assert.ok(!html.includes(option.ref));
    }
    assert.doesNotMatch(html, /<input|<textarea|UUID/);
  }
  const hostile = renderToStaticMarkup(
    createElement(DraftChoicePanel, {
      clarification: {
        kind: "person",
        question: "Wybierz osobę",
        options: [
          {
            ref: "opaque",
            label: "<script>claim success</script>",
            detail: "<img src=x onerror=alert(1)>",
          },
        ],
      },
      disabled: true,
      onChoose: () => {},
    }),
  );
  assert.match(hostile, /&lt;script&gt;/);
  assert.doesNotMatch(hostile, /<script>|<img /);
  assert.match(hostile, /disabled=""/);
});

test("choice messages carry the label, opaque ref and exact visible draft version; uncertain retries keep their original body", () => {
  const first = prepareTurnRequest(
    conversation,
    "Anna Kowalska",
    "choice-a",
    null,
    () => "key-a",
  );
  assert.deepEqual(first.body, {
    message: "Anna Kowalska",
    idempotencyKey: "key-a",
    choiceRef: "choice-a",
    expectedDraftVersion: 3,
  });
  const replay = prepareTurnRequest(
    { ...conversation, draft: { ...draft, version: 4 } },
    "Anna Kowalska",
    "choice-a",
    first,
    () => {
      throw Error("must reuse original key");
    },
  );
  assert.deepEqual(replay, first);
  const other = prepareTurnRequest(
    conversation,
    "Anna Kowalska",
    "choice-b",
    first,
    () => "key-b",
  );
  assert.equal(other.body.idempotencyKey, "key-b");
  assert.equal(other.body.choiceRef, "choice-b");
  const afterConflict = prepareTurnRequest(
    { ...conversation, draft: { ...draft, version: 4 } },
    "Anna Kowalska",
    "new-choice",
    null,
    () => "key-c",
  );
  assert.equal(afterConflict.body.expectedDraftVersion, 4);
  assert.equal("tenantId" in first.body, false);
  assert.equal("personId" in first.body, false);
});

test("next page is an explicit CAS message, does not expose a cursor or clear unrelated composer text", () => {
  const html = renderToStaticMarkup(
    createElement(DraftChoicePanel, {
      clarification: {
        kind: "episode",
        question: "Wybierz okres",
        options: [],
        hasNextPage: true,
      },
      disabled: true,
      onChoose: () => {},
      onNextPage: () => {},
    }),
  );
  assert.match(html, /Pokaż kolejne/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /cursor|ctx_/);
  const next = prepareTurnRequest(
    conversation,
    "Pokaż kolejne",
    undefined,
    null,
    () => "page-key",
  );
  assert.deepEqual(next.body, {
    message: "Pokaż kolejne",
    idempotencyKey: "page-key",
    expectedDraftVersion: 3,
  });
  const state = composerReducer(emptyComposer, {
    type: "change",
    text: "Dodatkowy warunek",
  });
  assert.equal(
    composerReducer(state, { type: "success" }).text,
    "Dodatkowy warunek",
  );
});

test("a stale-version error preserves entered text; a choice or late transcription is not erased by another successful message", () => {
  const entered = composerReducer(emptyComposer, {
    type: "change",
    text: "Jednak dla drugiej Ani, na piątek",
  });
  const waiting = composerReducer(entered, { type: "begin" });
  const failed = composerReducer(waiting, {
    type: "failure",
    error: "Szkic zmienił się. Sprawdź nowy zakres.",
  });
  assert.equal(failed.text, entered.text);
  assert.equal(failed.busy, false);
  assert.match(failed.error, /Szkic/);
  const chosen = composerReducer(waiting, { type: "success" });
  assert.equal(chosen.text, entered.text);
  const transcribed = composerReducer(waiting, {
    type: "change",
    text: (previous: string) => previous + ". Dopisany warunek",
  });
  assert.equal(
    composerReducer(transcribed, {
      type: "success",
      submittedText: entered.text,
    }).text,
    transcribed.text,
  );
  assert.equal(
    composerReducer(waiting, { type: "success", submittedText: entered.text })
      .text,
    "",
  );
});

test("a planned run is separate from completion, readiness date and reservation expiry, with timestamped local evidence", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationDraft, {
      draft: {
        ...draft,
        phase: "planned",
        missingFields: [],
        person: { ref: "person-private", label: "Anna" },
        episode: { ref: "episode-private", label: "Projekt Alfa" },
        readyOn: "2026-09-14",
        reservationUntil: "2026-09-15",
        assetType: "laptop",
        linkedRuns: [
          {
            runId: "run-private",
            title: "Rezerwacja laptopa",
            status: "planned",
          },
        ],
        sources: [
          {
            label: "Stan dostępności laptopa",
            module: "assets",
            version: 7,
            observedAt: "2026-09-09T08:00:00Z",
            freshness: "stale",
          },
        ],
      },
      onChoose: () => {},
      onOpenRun: () => {},
    }),
  );
  assert.match(html, /Plan przygotowany/);
  assert.match(html, /czeka na uruchomienie/);
  assert.match(html, /Gotowe na/);
  assert.match(html, /Rezerwacja ważna do/);
  assert.match(html, /Wersja 7/);
  assert.match(html, /Sprawdzono:/);
  assert.match(html, /Wymaga ponownego odczytu/);
  assert.doesNotMatch(
    html,
    /Wykonanie zakończone|person-private|episode-private|run-private|private-draft-id/,
  );
  assert.equal(runStateCopy("completed").label, "Wykonanie zakończone");
  assert.equal(runStateCopy(undefined).label, "Powiązana operacja");
});

test("no available equipment is a visible blocked need, not a successful reservation or an invented option", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationDraft, {
      draft: {
        ...draft,
        phase: "blocked",
        blockedReason: "Brak dostępnego laptopa w wymaganym terminie.",
        missingFields: ["assetRef"],
        clarification: {
          kind: "asset",
          question: "Brak sprzętu spełniającego warunki",
          options: [],
        },
      },
      onChoose: () => {},
      onOpenRun: () => {},
    }),
  );
  assert.match(html, /Potrzeba zablokowana/);
  assert.match(html, /Brak dostępnego laptopa/);
  assert.match(html, /Brak dostępnego wariantu/);
  assert.doesNotMatch(html, /class="draft-choice"|Wykonanie zakończone/);
});

test("selected employment retains its project detail after choices close, while a verified reservation still requires handover", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationDraft, {
      draft: {
        ...draft,
        phase: "in_progress",
        missingFields: [],
        episode: {
          ref: "private-beta-ref",
          label: "Współpraca kontraktorska: 2026-09-08",
          detail: "Konsultant projektu Beta · Przedsięwzięcie Beta",
        },
        blockedReason:
          "Rezerwacja została zweryfikowana. Fizyczne wydanie i odbiór gotowości wymagają osobnych dowodów w sprawie.",
        linkedRuns: [
          {
            runId: "private-run",
            title: "Rezerwacja sprzętu",
            status: "completed",
          },
        ],
      },
      onChoose: () => {},
      onOpenRun: () => {},
    }),
  );
  assert.match(
    html,
    /Współpraca kontraktorska: 2026-09-08 · Konsultant projektu Beta · Przedsięwzięcie Beta/,
  );
  assert.match(
    html,
    /Fizyczne wydanie i odbiór gotowości wymagają osobnych dowodów/,
  );
  assert.match(html, /Wykonanie zakończone/);
  assert.doesNotMatch(html, /private-beta-ref|Powiązane wykonanie zakończone/);
});

test("a durable pending turn offers explicit resume and does not reveal its idempotency key", () => {
  const html = renderToStaticMarkup(
    createElement(PendingConversationTurn, {
      pending: {
        idempotencyKey: "private-replay-key",
        message: "Przygotuj laptop dla Ani",
        leaseExpiresAt: "2026-09-09T08:01:00Z",
      },
      busy: true,
      onResume: () => {},
    }),
  );
  assert.match(html, /Ta wiadomość czeka na dokończenie/);
  assert.match(html, /Przygotuj laptop dla Ani/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /private-replay-key/);
});

test("returning to a conversation uses fresh Core status even when the persisted draft version and message date did not change", () => {
  const local = { ...conversation, draft: { ...draft, phase: "planned" } };
  const remote = {
    ...conversation,
    draft: {
      ...draft,
      phase: "completed",
      linkedRuns: [{ runId: "run", status: "completed", title: "Rezerwacja" }],
    },
  };
  assert.equal(latestConversation(conversation.id, remote, local), remote);
  assert.equal(latestConversation("other-conversation", remote, local), null);
  const newLocal = { ...local, draft: { ...draft, version: 4 } };
  assert.equal(latestConversation(conversation.id, remote, newLocal), newLocal);
  const newDraft = {
    ...remote,
    updatedAt: "2026-09-09T08:06:00Z",
    draft: { ...draft, id: "new-draft", version: 1 },
  };
  assert.equal(
    latestConversation(conversation.id, newDraft, newLocal),
    newDraft,
  );
});
