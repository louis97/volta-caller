"use client";

import type {
  AgentActivity,
  AgentConversation,
  AgentMessage,
  OperationReadModel,
  ProposedAction
} from "@volta/contracts";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";

import { fetchOperationalRead } from "./api-client";
import { ArrowIcon, EditIcon, LinkIcon, PlusIcon, TrashIcon } from "./icons";

const QUICK_PROMPTS = [
  "What needs my attention right now?",
  "Compare the carrier quotes for the active operation",
  "Summarize the latest calls and exceptions",
  "Which offer best fits the mandate?"
];

const AGENT_ERROR_MESSAGES: Record<string, string> = {
  agent_configuration_invalid:
    "Volta's operational tools are temporarily unavailable. No action was taken.",
  agent_conversation_missing:
    "This conversation is no longer available. Start a new chat and try again.",
  agent_model_unavailable:
    "Volta's language model is not configured. No action was taken.",
  agent_rate_limited:
    "Volta is receiving too many requests. No action was taken; try again shortly.",
  agent_request_failed:
    "Volta could not answer right now. No action was taken; try again shortly.",
  agent_request_rejected:
    "Volta rejected the request before it could run. No action was taken."
};

class AgentStreamError extends Error {
  constructor(readonly publicMessage: string) {
    super("agent_stream_failed");
  }
}

type VoltaChatProps = {
  onOperationChange?: (operation: OperationReadModel) => void;
};

export function VoltaChat({ onOperationChange }: VoltaChatProps) {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canRetryLoad, setCanRetryLoad] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const loadSequenceRef = useRef(0);

  const restoreLatest = useCallback(async () => {
    const sequence = ++loadSequenceRef.current;
    setIsRestoring(true);
    setLoadError(null);
    setCanRetryLoad(false);
    try {
      const listResponse = await fetchOperationalRead(
        "/api/agent/conversations"
      );
      if (!listResponse.ok) throw new Error("conversation_list_failed");
      const list = (await listResponse.json()) as AgentConversation[];
      if (sequence !== loadSequenceRef.current) return;
      setConversations(list);
      const latest = list[0];
      if (!latest) {
        setConversationId(null);
        setMessages([]);
        return;
      }
      const detailResponse = await fetchOperationalRead(
        `/api/agent/conversations/${latest.id}`
      );
      if (!detailResponse.ok) throw new Error("conversation_load_failed");
      const detail = (await detailResponse.json()) as AgentConversation;
      if (sequence !== loadSequenceRef.current) return;
      setConversationId(detail.id);
      setMessages(detail.messages);
    } catch {
      if (sequence === loadSequenceRef.current) {
        setLoadError(
          "Volta could not load conversation history. You can still start a new chat."
        );
        setCanRetryLoad(true);
      }
    } finally {
      if (sequence === loadSequenceRef.current) setIsRestoring(false);
    }
  }, []);

  useEffect(() => {
    void restoreLatest();
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [restoreLatest]);

  useEffect(() => {
    let cancelled = false;
    async function loadOperation() {
      try {
        const response = await fetchOperationalRead("/api/operation");
        if (!response.ok || cancelled) return;
        const operation: unknown = await response.json();
        if (!cancelled && isOperationReadModel(operation)) {
          onOperationChange?.(operation);
        }
      } catch {
        // Chat history remains usable even when the operation snapshot is stale.
      }
    }
    void loadOperation();
    return () => {
      cancelled = true;
    };
  }, [onOperationChange]);

  useEffect(() => {
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages, activity]);

  useEffect(() => {
    if (!isRestoring) inputRef.current?.focus();
  }, [conversationId, isRestoring]);

  async function openConversation(id: string) {
    if (id === conversationId || isSending) return;
    const sequence = ++loadSequenceRef.current;
    setIsRestoring(true);
    setLoadError(null);
    try {
      const response = await fetchOperationalRead(
        `/api/agent/conversations/${id}`
      );
      if (!response.ok) throw new Error("conversation_load_failed");
      const detail = (await response.json()) as AgentConversation;
      if (sequence !== loadSequenceRef.current) return;
      setConversationId(detail.id);
      setMessages(detail.messages);
    } catch {
      if (sequence === loadSequenceRef.current) {
        setLoadError("This conversation could not be loaded.");
        setCanRetryLoad(true);
      }
    } finally {
      if (sequence === loadSequenceRef.current) setIsRestoring(false);
    }
  }

  function startNewChat() {
    if (isSending) return;
    loadSequenceRef.current += 1;
    setConversationId(null);
    setMessages([]);
    setQuestion("");
    setActivity(null);
    setLoadError(null);
    setCanRetryLoad(false);
    setIsRestoring(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function renameConversation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!renamingId || !title) return;
    try {
      const response = await fetch(`/api/agent/conversations/${renamingId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title })
      });
      if (!response.ok) throw new Error("conversation_rename_failed");
      const renamed = (await response.json()) as AgentConversation;
      setConversations((current) =>
        current.map((item) =>
          item.id === renamed.id ? { ...item, ...renamed } : item
        )
      );
      setRenamingId(null);
      setRenameTitle("");
    } catch {
      setLoadError("The conversation title could not be saved.");
    }
  }

  async function deleteConversation(conversation: AgentConversation) {
    if (isSending || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        `/api/agent/conversations/${conversation.id}`,
        { method: "DELETE" }
      );
      if (!response.ok && response.status !== 404) {
        throw new Error("conversation_delete_failed");
      }
      setConversations((current) =>
        current.filter((item) => item.id !== conversation.id)
      );
      if (conversationId === conversation.id) startNewChat();
      setDeletingId(null);
    } catch {
      setDeleteError(
        "This conversation could not be deleted. It remains available."
      );
    } finally {
      setIsDeleting(false);
    }
  }

  async function askVolta(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSending || isRestoring) return;

    let activeConversationId = conversationId;
    let createdConversation: AgentConversation | undefined;
    const optimisticMessage = localMessage(
      "user-" + Date.now(),
      activeConversationId ?? "pending",
      "user",
      trimmedQuestion
    );
    setMessages((current) => [...current, optimisticMessage]);
    setQuestion("");
    setIsSending(true);
    setLoadError(null);
    setCanRetryLoad(false);
    setActivity({
      stage: "searching_records",
      label: "Connecting to operational records"
    });

    try {
      if (!activeConversationId) {
        const conversationResponse = await fetch("/api/agent/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: trimmedQuestion.slice(0, 120) })
        });
        if (!conversationResponse.ok) throw new Error("conversation_failed");
        createdConversation =
          (await conversationResponse.json()) as AgentConversation;
        activeConversationId = createdConversation.id;
        setConversationId(createdConversation.id);
        setConversations((current) => [createdConversation!, ...current]);
      }
      const response = await fetch(
        `/api/agent/conversations/${activeConversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: trimmedQuestion })
        }
      );
      const assistantMessage = await readAgentMessage(response, setActivity);
      setMessages((current) => [...current, assistantMessage]);
      setConversations((current) => {
        const updated = current.map((item) =>
          item.id === activeConversationId
            ? { ...item, updatedAt: assistantMessage.createdAt }
            : item
        );
        return updated.sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt)
        );
      });
    } catch (error) {
      setMessages((current) => [
        ...current,
        localMessage(
          "assistant-" + Date.now(),
          activeConversationId ?? "failed",
          "assistant",
          error instanceof AgentStreamError
            ? error.publicMessage
            : "I could not reach the operational brain. No action was taken; try again shortly."
        )
      ]);
      if (createdConversation) {
        setConversations((current) =>
          current.some((item) => item.id === createdConversation?.id)
            ? current
            : [createdConversation!, ...current]
        );
      }
    } finally {
      setActivity(null);
      setIsSending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  async function decideAction(
    action: ProposedAction,
    decision: "approve" | "decline"
  ) {
    try {
      const response = await fetch(`/api/agent/actions/${action.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision })
      });
      if (!response.ok) throw new Error("action_decision_failed");
      const payload = (await response.json()) as {
        action: ProposedAction;
        operation?: OperationReadModel;
      };
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          proposedActions: message.proposedActions.map((item) =>
            item.id === action.id ? payload.action : item
          )
        }))
      );
      if (payload.operation) onOperationChange?.(payload.operation);
    } catch {
      setMessages((current) => [
        ...current,
        localMessage(
          "action-error-" + Date.now(),
          conversationId ?? "failed",
          "assistant",
          "The action could not be decided safely. Refresh the operation before trying again."
        )
      ]);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const activeConversation = conversations.find(
    (item) => item.id === conversationId
  );

  return (
    <section className="brain" aria-label="Volta central brain">
      <nav className="brain__history" aria-label="Volta conversations">
        <header className="brain__history-head">
          <div>
            <p className="ml">Operational memory</p>
            <h2>Conversations</h2>
          </div>
          <button
            aria-label="New chat"
            className="brain__new"
            disabled={isSending}
            onClick={startNewChat}
            type="button"
          >
            <PlusIcon />
          </button>
        </header>
        <div className="brain__history-list">
          {conversations.map((conversation) => (
            <div
              className={
                conversation.id === conversationId
                  ? "brain__conversation is-active"
                  : "brain__conversation"
              }
              key={conversation.id}
            >
              {renamingId === conversation.id ? (
                <form onSubmit={renameConversation}>
                  <label
                    className="sr-only"
                    htmlFor={`rename-${conversation.id}`}
                  >
                    Conversation title
                  </label>
                  <input
                    autoFocus
                    id={`rename-${conversation.id}`}
                    maxLength={120}
                    onChange={(event) => setRenameTitle(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    value={renameTitle}
                  />
                </form>
              ) : deletingId === conversation.id ? (
                <div className="brain__delete-confirm" role="alert">
                  <p>Delete this chat and its pending proposals?</p>
                  <div>
                    <button
                      disabled={isDeleting}
                      onClick={() => {
                        setDeletingId(null);
                        setDeleteError(null);
                      }}
                      type="button"
                    >
                      Keep
                    </button>
                    <button
                      className="brain__delete-confirm-action"
                      disabled={isDeleting}
                      onClick={() => void deleteConversation(conversation)}
                      type="button"
                    >
                      {isDeleting ? "Deleting…" : "Delete chat"}
                    </button>
                  </div>
                  {deleteError && <small>{deleteError}</small>}
                </div>
              ) : (
                <>
                  <button
                    className="brain__conversation-open"
                    disabled={isSending}
                    onClick={() => void openConversation(conversation.id)}
                    type="button"
                  >
                    <b>{conversation.title}</b>
                    <time dateTime={conversation.updatedAt}>
                      {formatConversationTime(conversation.updatedAt)}
                    </time>
                  </button>
                  <button
                    aria-label={`Rename ${conversation.title}`}
                    className="brain__rename"
                    onClick={() => {
                      setDeletingId(null);
                      setRenamingId(conversation.id);
                      setRenameTitle(conversation.title);
                    }}
                    type="button"
                  >
                    <EditIcon />
                  </button>
                  <button
                    aria-label={`Delete ${conversation.title}`}
                    className="brain__delete"
                    disabled={isSending}
                    onClick={() => {
                      setRenamingId(null);
                      setDeletingId(conversation.id);
                      setDeleteError(null);
                    }}
                    type="button"
                  >
                    <TrashIcon />
                  </button>
                </>
              )}
            </div>
          ))}
          {!isRestoring && conversations.length === 0 && (
            <p className="brain__history-empty">No saved conversations yet.</p>
          )}
        </div>
      </nav>

      <section className="brain__chat" aria-labelledby="volta-title">
        <header className="brain__head">
          <div className="brain__identity">
            <span>V/</span>
            <div>
              <p className="ml">Central brain</p>
              <h1 id="volta-title">Volta</h1>
            </div>
          </div>
          <div className="brain__thread-title">
            <span className="pulse" />
            {activeConversation?.title ?? "New operational conversation"}
          </div>
        </header>

        <div className="brain__thread" aria-live="polite" ref={threadRef}>
          {loadError && (
            <div className="brain__notice" role="alert">
              <span>{loadError}</span>
              {canRetryLoad && (
                <button
                  disabled={isRestoring}
                  onClick={() => void restoreLatest()}
                  type="button"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {isRestoring ? (
            <div className="brain__loading">
              <i className="pulse" /> Loading operational memory
            </div>
          ) : messages.length === 0 ? (
            <section className="brain__welcome">
              <span className="brain__welcome-mark">V/</span>
              <p className="kicker">One operational record</p>
              <h2>What should we look at?</h2>
              <p>
                I can investigate every operation, call, quote, transcript and
                exception. I can prepare actions on the active operation, but
                nothing changes without your approval.
              </p>
              <div className="brain__prompts">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setQuestion(prompt);
                      inputRef.current?.focus();
                    }}
                    type="button"
                  >
                    <ArrowIcon />
                    {prompt}
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="brain__messages">
              <AnimatePresence initial={false}>
                {messages.map((message) => (
                  <m.article
                    animate={{ opacity: 1, y: 0 }}
                    className={`brain__message brain__message--${message.role}`}
                    exit={{ opacity: 0, y: -4 }}
                    initial={{ opacity: 0, y: 8 }}
                    key={message.id}
                  >
                    <div className="brain__message-author">
                      <span>{message.role === "assistant" ? "V/" : "YOU"}</span>
                      <time dateTime={message.createdAt}>
                        {formatMessageTime(message.createdAt)}
                      </time>
                    </div>
                    <p>{message.content}</p>
                    {message.citations.length > 0 && (
                      <ol className="brain__cites" aria-label="Evidence">
                        {message.citations.map((citation) => (
                          <li key={citation.id}>
                            <a href={citation.href} target="_blank">
                              <LinkIcon />
                              <span>{citation.title}</span>
                            </a>
                            <time dateTime={citation.occurredAt}>
                              {new Date(
                                citation.occurredAt
                              ).toLocaleDateString()}
                            </time>
                          </li>
                        ))}
                      </ol>
                    )}
                    {message.proposedActions.map((action) => (
                      <section className="brain__action" key={action.id}>
                        <p className="ml">Human approval required</p>
                        <h3>
                          {action.type === "resolve_carrier_selection"
                            ? "Carrier selection"
                            : action.type === "create_mandate"
                              ? "Create mandate"
                              : "Approved closing call"}
                        </h3>
                        <p>{action.summary}</p>
                        {action.status === "pending" ? (
                          <div>
                            <button
                              className="btn btn--primary btn--sm"
                              onClick={() =>
                                void decideAction(action, "approve")
                              }
                              type="button"
                            >
                              Approve action
                            </button>
                            <button
                              className="btn btn--secondary btn--sm"
                              onClick={() =>
                                void decideAction(action, "decline")
                              }
                              type="button"
                            >
                              Decline
                            </button>
                          </div>
                        ) : (
                          <strong>Action {action.status}</strong>
                        )}
                      </section>
                    ))}
                  </m.article>
                ))}
              </AnimatePresence>
              {activity && (
                <m.div
                  animate={{ opacity: 1, y: 0 }}
                  className="brain__activity"
                  initial={{ opacity: 0, y: 4 }}
                  key={activity.stage}
                >
                  <i className="pulse" />
                  <span>{activity.label}</span>
                </m.div>
              )}
            </div>
          )}
        </div>

        <form className="brain__composer" onSubmit={askVolta}>
          <label htmlFor="volta-question">Ask across operational history</label>
          <div>
            <textarea
              disabled={isRestoring}
              id="volta-question"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask what changed, what is blocked, or what Volta should prepare…"
              ref={inputRef}
              rows={2}
              value={question}
            />
            <m.button
              aria-label="Ask Volta"
              className="brain__send"
              disabled={!question.trim() || isSending || isRestoring}
              type="submit"
              whileTap={{ scale: 0.96 }}
            >
              <ArrowIcon />
            </m.button>
          </div>
          <small>Enter to send · Shift + Enter for a new line</small>
        </form>
      </section>
    </section>
  );
}

async function readAgentMessage(
  response: Response,
  onActivity: (activity: AgentActivity | null) => void
) {
  if (!response.ok) throw new Error("agent_request_rejected");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("agent_stream_unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let finalMessage: AgentMessage | undefined;

  function consume(event: string) {
    const eventName = event
      .split("\n")
      .find((line) => line.startsWith("event: "))
      ?.slice(7);
    const data = event
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (eventName === "error") {
      let code = "agent_request_failed";
      if (data) {
        try {
          const parsed: unknown = JSON.parse(data);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "error" in parsed &&
            typeof parsed.error === "string"
          ) {
            code = parsed.error;
          }
        } catch {
          code = "agent_request_failed";
        }
      }
      throw new AgentStreamError(
        AGENT_ERROR_MESSAGES[code] ?? AGENT_ERROR_MESSAGES.agent_request_failed
      );
    }
    if (eventName === "activity" && data) {
      onActivity(JSON.parse(data) as AgentActivity);
    }
    if (eventName === "final" && data) {
      finalMessage = JSON.parse(data) as AgentMessage;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    events.forEach(consume);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (!finalMessage) throw new Error("agent_answer_missing");
  return finalMessage;
}

function isOperationReadModel(value: unknown): value is OperationReadModel {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "callSessions" in value &&
    Array.isArray(value.callSessions) &&
    "approvals" in value &&
    Array.isArray(value.approvals)
  );
}

function localMessage(
  id: string,
  conversationId: string,
  role: AgentMessage["role"],
  content: string
): AgentMessage {
  return {
    id,
    conversationId,
    role,
    content,
    citations: [],
    proposedActions: [],
    createdAt: new Date().toISOString()
  };
}

function formatConversationTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric"
  }).format(date);
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}
