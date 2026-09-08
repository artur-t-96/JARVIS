import type { Conversation } from "./ConversationDraft";

export type TurnRequest = {
  conversationId: string;
  body: {
    message: string;
    idempotencyKey: string;
    choiceRef?: string;
    expectedDraftVersion?: number;
  };
};

/** A lost response retries the exact original body, including its version. */
export function prepareTurnRequest(
  conversation: Conversation,
  text: string,
  choiceRef: string | undefined,
  pending: TurnRequest | null,
  createKey: () => string,
): TurnRequest {
  const message = text.trim();
  if (
    pending?.conversationId === conversation.id &&
    pending.body.message === message &&
    pending.body.choiceRef === choiceRef
  )
    return pending;
  return {
    conversationId: conversation.id,
    body: {
      message,
      idempotencyKey: createKey(),
      ...(choiceRef ? { choiceRef } : {}),
      ...(conversation.draft
        ? { expectedDraftVersion: conversation.draft.version }
        : {}),
    },
  };
}

export interface ComposerState {
  text: string;
  busy: boolean;
  error: string;
}
type ComposerAction =
  | { type: "change"; text: string | ((previous: string) => string) }
  | { type: "error"; error: string }
  | { type: "begin" }
  | { type: "success"; submittedText?: string }
  | { type: "failure"; error: string }
  | { type: "clearError" }
  | { type: "reset" };
export const emptyComposer: ComposerState = {
  text: "",
  busy: false,
  error: "",
};
export function composerReducer(
  state: ComposerState,
  action: ComposerAction,
): ComposerState {
  switch (action.type) {
    case "change":
      return {
        ...state,
        text:
          typeof action.text === "function"
            ? action.text(state.text)
            : action.text,
      };
    case "error":
      return { ...state, error: action.error };
    case "begin":
      return { ...state, busy: true, error: "" };
    case "success":
      return {
        text:
          action.submittedText !== undefined &&
          state.text.trim() === action.submittedText
            ? ""
            : state.text,
        busy: false,
        error: "",
      };
    case "failure":
      return { ...state, busy: false, error: action.error };
    case "clearError":
      return { ...state, error: "" };
    case "reset":
      return { ...emptyComposer };
  }
}

/** Detail snapshots win ties so current Core states replace historical local replies. */
export function latestConversation(
  id: string | undefined,
  ...candidates: (Conversation | null | undefined)[]
): Conversation | null {
  if (!id) return null;
  return candidates
    .filter((value): value is Conversation => value?.id === id)
    .reduce<Conversation | null>((best, value) => {
      if (!best) return value;
      const version =
        value.draft?.id === best.draft?.id
          ? (value.draft?.version ?? 0) - (best.draft?.version ?? 0)
          : 0;
      const date = Date.parse(value.updatedAt) - Date.parse(best.updatedAt);
      if (
        version > 0 ||
        (version === 0 &&
          (date > 0 ||
            (date === 0 && value.messages.length > best.messages.length)))
      )
        return value;
      return best;
    }, null);
}
