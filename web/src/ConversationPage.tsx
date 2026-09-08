import { useEffect, useRef, useState, type FormEvent } from "react";
import { post, requestKey } from "./api";
import { browserAudioToWav } from "./audio";
import { errorMessage, navigate, useResource } from "./hooks";
import { dateLabel, type Context, type Conversation } from "./types";
import { Icon, Loading, Notice } from "./ui";

function VoiceButton({
  onTranscript,
  onError,
}: {
  onTranscript: (text: string) => void;
  onError: (error: string) => void;
}) {
  const status = useResource<{ available: boolean; reason?: string }>(
    "/api/voice/status",
  );
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const held = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      held.current = false;
      if (timeout.current) clearTimeout(timeout.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  const stop = () => {
    held.current = false;
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  async function start() {
    if (busy || recording || held.current) return;
    held.current = true;
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!held.current || !mounted.current) {
        audio.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = audio;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const instance = new MediaRecorder(
        audio,
        mimeType ? { mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      recorder.current = instance;
      instance.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      instance.onstop = async () => {
        audio.getTracks().forEach((track) => track.stop());
        if (timeout.current) clearTimeout(timeout.current);
        if (!mounted.current) return;
        setRecording(false);
        setBusy(true);
        try {
          const recorded = new Blob(chunks, { type: instance.mimeType });
          const blob = await browserAudioToWav(recorded);
          if (!blob.size) return;
          if (blob.size > 2 * 1024 * 1024)
            throw new Error("Nagranie jest za duże. Nagraj krótszą wiadomość.");
          const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve(String(reader.result).split(",")[1] ?? "");
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
          const result = await post<{ text: string }>("/api/voice/transcribe", {
            audio: base64,
            mimeType: "audio/wav",
          });
          if (mounted.current) onTranscript(result.text);
        } catch (cause) {
          if (mounted.current) onError(errorMessage(cause));
        } finally {
          if (mounted.current) setBusy(false);
        }
      };
      instance.start();
      setRecording(true);
      timeout.current = setTimeout(stop, 29_000);
    } catch (cause) {
      held.current = false;
      onError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "Udostępnij mikrofon w przeglądarce, aby nagrać wiadomość."
          : errorMessage(cause),
      );
    }
  }
  const available =
    status.data?.available &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;
  const label = recording
    ? "Nagrywanie — puść, aby zakończyć"
    : busy
      ? "Przepisywanie nagrania…"
      : available
        ? "Przytrzymaj, aby mówić. Tekst sprawdzisz przed wysłaniem."
        : (status.data?.reason ?? "Dyktowanie nie jest skonfigurowane.");
  return (
    <button
      type="button"
      className={`icon-button voice-button ${recording ? "recording" : ""}`}
      disabled={!available || busy}
      aria-label={label}
      title={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        void start();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={(event) => {
        if ((event.key === " " || event.key === "Enter") && !event.repeat) {
          event.preventDefault();
          void start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === " " || event.key === "Enter") {
          event.preventDefault();
          stop();
        }
      }}
    >
      {busy ? <span className="spinner" /> : <Icon name="mic" size={20} />}
    </button>
  );
}

export function ConversationPage({
  selectedId,
  context,
}: {
  selectedId?: string;
  context: Context;
}) {
  const [revision, setRevision] = useState(0);
  const resource = useResource<{ conversations: Conversation[] }>(
    "/api/conversations",
    revision,
  );
  const [localConversation, setLocalConversation] =
    useState<Conversation | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<{ id: string; text: string; key: string } | null>(
    null,
  );
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const conversation =
    localConversation?.id === selectedId
      ? localConversation
      : (resource.data?.conversations.find((item) => item.id === selectedId) ??
        null);
  useEffect(() => {
    setError("");
  }, [selectedId]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conversation?.messages.length, busy]);
  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = message.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    try {
      let active = conversation;
      if (!active) {
        const created = await post<{ conversation: Conversation }>(
          "/api/conversations",
        );
        active = created.conversation;
        setLocalConversation(active);
        navigate(`conversation/${active.id}`);
      }
      const key =
        pending.current?.id === active.id && pending.current.text === text
          ? pending.current.key
          : requestKey();
      pending.current = { id: active.id, text, key };
      const result = await post<{ conversation: Conversation }>(
        `/api/conversations/${active.id}/messages`,
        { message: text, idempotencyKey: key },
      );
      setLocalConversation(result.conversation);
      setMessage("");
      pending.current = null;
      setRevision((value) => value + 1);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  }
  const offline = ["demo", "offline", "templates", "deterministic"].includes(
    context.planner.kind,
  );
  return (
    <>
      <div className="page-heading compact">
        <div>
          <span className="eyebrow">TWÓJ ASYSTENT OPERACYJNY</span>
          <h1>Rozmowa z JARVIS</h1>
          <p>
            {offline
              ? "Scenariusze lokalne · bez modelu AI"
              : "Od intencji do sprawdzonego działania."}
          </p>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => {
            navigate("conversation");
            setLocalConversation(null);
            setMessage("");
            pending.current = null;
          }}
        >
          <Icon name="plus" size={17} />
          Nowa rozmowa
        </button>
      </div>
      <div className="conversation-layout">
        <aside className="conversation-list">
          <div className="section-label">OSTATNIE ROZMOWY</div>
          {resource.loading && !resource.data ? (
            <Loading />
          ) : (
            (resource.data?.conversations ?? []).map((item) => (
              <button
                key={item.id}
                className={`conversation-link ${selectedId === item.id ? "selected" : ""}`}
                disabled={busy}
                onClick={() => navigate(`conversation/${item.id}`)}
              >
                <Icon name="chat" size={17} />
                <span>
                  <strong>{item.title || "Nowa rozmowa"}</strong>
                  <small>{dateLabel(item.updatedAt)}</small>
                </span>
              </button>
            ))
          )}
          {resource.data?.conversations.length === 0 && (
            <p className="small muted">Twoje rozmowy pojawią się tutaj.</p>
          )}
          <div className="assistant-mode">
            <Icon name={offline ? "documents" : "spark"} size={18} />
            <span>
              {offline
                ? "Tryb lokalnych scenariuszy"
                : `Planer: ${context.planner.kind}`}
              <small>
                {offline
                  ? "Bez modelu AI. Dostępne operacje wynikają z lokalnego katalogu."
                  : "Propozycje są sprawdzane przez reguły i katalog operacji."}
              </small>
            </span>
          </div>
        </aside>
        <section className="chat-panel">
          <div className="chat-messages">
            {!conversation?.messages.length ? (
              <div className="chat-welcome">
                <span className="assistant-mark">J</span>
                <span className="eyebrow">
                  MNIEJ PRZEŁĄCZANIA. WIĘCEJ ZAŁATWIONYCH SPRAW.
                </span>
                <h2>Co chcesz dzisiaj załatwić?</h2>
                <p>
                  Opisz cel własnymi słowami. JARVIS pomoże uzupełnić dane,
                  przygotuje operację i pokaże, co wymaga Twojej decyzji.
                </p>
                <div className="prompt-suggestions">
                  {[
                    "Sprawdź laboratorium",
                    "Zarezerwuj sprzęt dla osoby",
                    "Utwórz zamówienie zakupowe",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setMessage(prompt);
                        input.current?.focus();
                      }}
                    >
                      <span>{prompt}</span>
                      <Icon name="arrow" size={16} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              conversation.messages.map((item) => (
                <article className={`message ${item.role}`} key={item.id}>
                  {item.role === "assistant" && (
                    <span className="message-avatar">J</span>
                  )}
                  <div className="message-content">
                    <div className="message-meta">
                      <strong>
                        {item.role === "assistant" ? "JARVIS" : "Ty"}
                      </strong>
                      <time>{dateLabel(item.createdAt, true)}</time>
                    </div>
                    {item.kind === "needs_input" && (
                      <span className="message-kind">
                        Potrzebne doprecyzowanie
                      </span>
                    )}
                    {item.kind === "unsupported" && (
                      <span className="message-kind muted">
                        Poza dostępnym zakresem
                      </span>
                    )}
                    <div className="message-text">{item.content}</div>
                    {item.runId && (
                      <button
                        className="chat-run-link"
                        onClick={() => navigate(`runs/${item.runId}`)}
                      >
                        <span className="chat-run-icon">
                          <Icon name="cases" size={21} />
                        </span>
                        <span>
                          <strong>Plan operacji jest gotowy</strong>
                          <small>Sprawdź zakres i przejdź do wykonania</small>
                        </span>
                        <Icon name="arrow" size={20} />
                      </button>
                    )}
                  </div>
                </article>
              ))
            )}
            {busy && (
              <div className="assistant-thinking">
                <span className="message-avatar">J</span>
                <span className="typing-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="small muted">Przygotowuję odpowiedź…</span>
              </div>
            )}
            <div ref={bottom} />
          </div>
          {(error || resource.error) && (
            <div className="chat-error">
              <Notice tone="error">{error || resource.error}</Notice>
            </div>
          )}
          <form
            className="composer-wrap"
            onSubmit={(event) => void send(event)}
          >
            <div className="composer">
              <textarea
                ref={input}
                aria-label="Wiadomość do JARVIS"
                placeholder="Opisz zadanie lub zapytaj o swoje sprawy…"
                value={message}
                maxLength={4000}
                rows={2}
                disabled={busy}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-actions">
                <span>Enter — wyślij · Shift + Enter — nowa linia</span>
                <div>
                  <VoiceButton
                    onTranscript={(text) => {
                      setMessage((value) =>
                        value ? `${value}\n${text}` : text,
                      );
                      input.current?.focus();
                    }}
                    onError={setError}
                  />
                  <button
                    type="submit"
                    className="send-button"
                    disabled={!message.trim() || busy}
                    aria-label="Wyślij wiadomość"
                  >
                    {busy ? (
                      <span className="spinner" />
                    ) : (
                      <Icon name="arrow" size={20} />
                    )}
                  </button>
                </div>
              </div>
            </div>
            <p className="composer-note">
              <Icon name="shield" size={13} />
              Zmiana danych wymaga sprawdzenia zakresu i zatwierdzenia operacji.
            </p>
          </form>
        </section>
      </div>
    </>
  );
}
