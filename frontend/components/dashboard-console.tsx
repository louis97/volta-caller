"use client";

import type {
  AgentConversation,
  AgentMessage,
  ApprovalRequest,
  CallSession,
  CallSupervisionState,
  CreateMandateRequest,
  Operation,
  OperationReadModel,
  ProposedAction,
  Quote,
  TranscriptSegment
} from "@volta/contracts";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domMax
} from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState } from "react";
import {
  ApprovalIcon,
  ArrowIcon,
  ChevronIcon,
  ClockIcon,
  OperationsIcon,
  PhoneIcon,
  PlusIcon,
  RouteIcon
} from "./icons";

type View =
  "new-mandate" | "call-floor" | "pipeline" | "carriers" | "approvals";

type MandateSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; operationId: string }
  | { status: "error"; message: string };

type CopilotMessage = AgentMessage;

const MANDATE_TIMEZONE_OFFSET = "-06:00";

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof ApprovalIcon;
}> = [
  { id: "new-mandate", label: "New mandate", icon: PlusIcon },
  { id: "call-floor", label: "Call floor", icon: PhoneIcon },
  { id: "pipeline", label: "Pipeline", icon: OperationsIcon },
  { id: "carriers", label: "Carriers", icon: RouteIcon },
  { id: "approvals", label: "Approvals", icon: ApprovalIcon }
];

function Status({
  children,
  tone
}: {
  children: React.ReactNode;
  tone: "blue" | "green" | "amber" | "red" | "neutral";
}) {
  return <m.span className={`status status--${tone}`}>{children}</m.span>;
}

function Topbar({
  title,
  description,
  eyebrow,
  action
}: {
  title: string;
  description: string;
  eyebrow?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="topbar">
      <div>
        <p className="eyebrow">{eyebrow ?? "Dispatch overview"}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}

function NewMandateView({ onCreated }: { onCreated: () => void }) {
  const [saveState, setSaveState] = useState<MandateSaveState>({
    status: "idle"
  });

  async function submitMandate(form: HTMLFormElement) {
    const data = new FormData(form);
    const mandate: CreateMandateRequest = {
      budget_cap: Number(data.get("budget_cap")),
      destination_datetime: toOffsetDatetime(data.get("destination_datetime")),
      destination_place: String(data.get("destination_place")),
      type_of_content: String(data.get("type_of_content")),
      weight: Number(data.get("weight")),
      measures: String(data.get("measures")),
      pickup_address: String(data.get("pickup_address")),
      pickup_datetime: toOffsetDatetime(data.get("pickup_datetime"))
    };
    const response = await fetch("/api/mandates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mandate)
    });

    if (!response.ok) {
      throw new Error(
        "Volta could not save this mandate. Check the details and try again."
      );
    }

    const operation = (await response.json()) as { id: string };
    setSaveState({ status: "saved", operationId: operation.id });
  }

  return (
    <>
      <Topbar
        title="New mandate"
        eyebrow="Create operation"
        description="Define the boundaries Volta must obey before it speaks to a carrier."
      />
      <form
        className="mandate-layout"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaveState({ status: "saving" });
          try {
            await submitMandate(event.currentTarget);
          } catch (error) {
            setSaveState({
              status: "error",
              message:
                error instanceof Error
                  ? error.message
                  : "Volta could not save this mandate."
            });
          }
        }}
      >
        <section className="panel form-panel">
          <div className="step-heading">
            <span>01</span>
            <div>
              <h2>Cargo manifest</h2>
              <p>The physical load the carrier must be able to move.</p>
            </div>
          </div>
          <div className="form-grid">
            <label>
              Type of content
              <select name="type_of_content" defaultValue="" required>
                <option value="" disabled>
                  Select content type
                </option>
                <option value="textiles">Textiles</option>
                <option value="general-cargo">General cargo</option>
                <option value="food-grade">Food-grade cargo</option>
                <option value="hazardous-material">Hazardous material</option>
              </select>
            </label>
            <label>
              Weight
              <div className="unit-input">
                <input
                  name="weight"
                  type="number"
                  min="0"
                  step="0.01"
                  required
                />
                <span>KG</span>
              </div>
            </label>
            <label className="span-2">
              Measures
              <input className="mono" name="measures" required />
            </label>
          </div>
        </section>
        <section className="panel form-panel">
          <div className="step-heading">
            <span>02</span>
            <div>
              <h2>Route &amp; binding limit</h2>
              <p>Where, when, and how far Volta is authorized to go.</p>
            </div>
          </div>
          <div className="form-grid">
            <label className="span-2">
              Pickup address
              <input name="pickup_address" required />
            </label>
            <label>
              Pickup date &amp; time
              <input
                className="mono"
                name="pickup_datetime"
                type="datetime-local"
                required
              />
            </label>
            <label>
              Destination date &amp; time
              <input
                className="mono"
                name="destination_datetime"
                type="datetime-local"
                required
              />
            </label>
            <label className="span-2">
              Destination place
              <input name="destination_place" required />
            </label>
            <label className="span-2">
              Budget cap
              <div className="money-input">
                <span>MXN</span>
                <input
                  name="budget_cap"
                  type="number"
                  min="0"
                  step="1"
                  required
                />
              </div>
            </label>
          </div>
          <div className="constraint-note">
            <ApprovalIcon />
            <div>
              <b>This mandate is binding</b>
              <p>
                The agent cannot exceed the authorized budget or change either
                datetime without human approval.
              </p>
            </div>
          </div>
        </section>
        <aside className="panel mandate-summary">
          <p className="section-label">Mandate preview</p>
          <h2>Review before launch</h2>
          <p className="summary-copy">
            Complete the mandate details. Volta may negotiate only within the
            budget and schedule you authorize.
          </p>
          {saveState.status === "saved" ? (
            <div className="saved-message">
              <i /> Mandate {saveState.operationId} created
            </div>
          ) : (
            <m.button
              className="button button--primary full"
              type="submit"
              disabled={saveState.status === "saving"}
              whileFocus={{ outlineOffset: 3 }}
              whileTap={{ scale: 0.98 }}
            >
              {saveState.status === "saving"
                ? "Saving mandate…"
                : "Launch mandate"}
              <ArrowIcon />
            </m.button>
          )}
          {saveState.status === "error" && (
            <p className="form-error" role="alert">
              {saveState.message}
            </p>
          )}
          {saveState.status === "saved" && (
            <m.button
              className="button button--secondary full"
              type="button"
              onClick={onCreated}
              whileFocus={{ outlineOffset: 3 }}
              whileTap={{ scale: 0.98 }}
            >
              Open operation
            </m.button>
          )}
        </aside>
      </form>
    </>
  );
}

function toOffsetDatetime(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A mandate datetime is required.");
  }

  return `${value}:00${MANDATE_TIMEZONE_OFFSET}`;
}

type ApprovalLoadState = "loading" | "ready" | "error";

function formatMxn(value: number) {
  return new Intl.NumberFormat("en-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0
  }).format(value);
}

function formatPickup(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Mexico_City"
  }).format(new Date(value));
}

function selectedQuotes(
  operation: Operation,
  approval: ApprovalRequest
): Quote[] {
  return operation.quotes.filter((quote) =>
    approval.quoteIds.includes(quote.id)
  );
}

function ApprovalsView() {
  const [operation, setOperation] = useState<Operation | null>(null);
  const [loadState, setLoadState] = useState<ApprovalLoadState>("loading");
  const [selectedQuoteId, setSelectedQuoteId] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function refresh() {
    try {
      const response = await fetch("/api/operation");
      if (!response.ok) throw new Error("operation_unavailable");
      setOperation((await response.json()) as Operation);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    void refresh();

    if (typeof EventSource === "undefined") return;
    const events = new EventSource("/api/events");
    const sync = () => void refresh();
    events.addEventListener("approval.requested", sync);
    events.addEventListener("approval.resolved", sync);
    events.addEventListener("approval.reopened", sync);
    events.addEventListener("commitment.finalized", sync);
    return () => events.close();
  }, []);

  const approval = operation?.approvals.find(
    (item) => item.status === "pending"
  );
  const quotes =
    operation && approval ? selectedQuotes(operation, approval) : [];
  const isSelectionApproval = approval?.type === "carrier_selection";
  const closingApproval = operation?.closingAuthorization
    ? operation.approvals.find(
        (item) => item.id === operation.closingAuthorization?.approvalId
      )
    : undefined;

  async function submitDecision(action: "approve" | "decline") {
    if (!approval || !operation) return;
    if (action === "approve" && isSelectionApproval && !selectedQuoteId) {
      setDecisionError(
        "Select one carrier before authorizing the closing call."
      );
      return;
    }

    setDecisionError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/approvals/${approval.id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          selectedQuoteId: isSelectionApproval
            ? (selectedQuoteId ?? undefined)
            : undefined
        })
      });
      if (!response.ok) throw new Error("decision_rejected");
      const payload = (await response.json()) as { operation: Operation };
      setOperation(payload.operation);
    } catch {
      setDecisionError("Volta could not record this decision. Try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function undoDecision() {
    if (!closingApproval) return;
    setDecisionError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(
        `/api/approvals/${closingApproval.id}/undo`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({})
        }
      );
      if (!response.ok) throw new Error("undo_rejected");
      const payload = (await response.json()) as { operation: Operation };
      setSelectedQuoteId(null);
      setOperation(payload.operation);
    } catch {
      setDecisionError(
        "Volta could not undo this decision. A confirmed booking cannot be reversed here."
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Topbar
        title="Approvals"
        eyebrow="Human decisions"
        description="Choose who Volta may call back to close the deal. Quotes never become bookings without you."
      />
      {loadState === "loading" && (
        <section className="panel decision-complete">
          <p className="section-label">Loading live queue</p>
          <h2>Checking Volta’s active rounds…</h2>
        </section>
      )}
      {loadState === "error" && (
        <section className="panel decision-complete">
          <span className="decline-ring">!</span>
          <p className="section-label">Connection unavailable</p>
          <h2>Approvals are served by the dispatch API.</h2>
          <button
            className="button button--secondary"
            onClick={() => void refresh()}
          >
            Retry connection
          </button>
        </section>
      )}
      {loadState === "ready" && !approval && operation?.commitment && (
        <section className="panel decision-complete">
          <span className="success-ring">✓</span>
          <p className="section-label">Closing call completed</p>
          <h2>
            {operation.commitment.finalPriceMxn && "Carrier booking confirmed"}
          </h2>
          <p>
            {formatMxn(operation.commitment.finalPriceMxn)} was recapped by SMS
            and linked to its recorded agreement.
          </p>
          <a
            className="button button--secondary"
            href={operation.commitment.audioTimestampUrl}
          >
            Open audio evidence
          </a>
        </section>
      )}
      {loadState === "ready" && !approval && closingApproval && operation && (
        <section className="panel decision-complete">
          <span className="success-ring">✓</span>
          <p className="section-label">Closing call authorized</p>
          <h2>
            Volta may now call{" "}
            {operation.candidates.find(
              (carrier) =>
                carrier.id === operation.closingAuthorization?.carrierId
            )?.name ?? "the selected carrier"}
            .
          </h2>
          <p>
            The carrier can only be booked at{" "}
            {formatMxn(operation.closingAuthorization!.finalPriceMxn)} for{" "}
            {formatPickup(operation.closingAuthorization!.pickupTime)}. You can
            undo this authorization until the booking is confirmed.
          </p>
          {decisionError && (
            <p className="form-error approval-error" role="alert">
              {decisionError}
            </p>
          )}
          <div className="approval-actions decision-complete-actions">
            <m.button
              className="button button--secondary"
              disabled={isSubmitting}
              onClick={() => void undoDecision()}
              whileFocus={{ outlineOffset: 3 }}
              whileTap={{ scale: 0.98 }}
            >
              Undo decision
            </m.button>
          </div>
        </section>
      )}
      {loadState === "ready" &&
        !approval &&
        !operation?.commitment &&
        !closingApproval && (
          <section className="panel decision-complete">
            <span className="success-ring">✓</span>
            <p className="section-label">No decisions waiting</p>
            <h2>Volta will alert you after the quote round closes.</h2>
            <p>
              Keep this panel open to receive the next request in real time.
            </p>
          </section>
        )}
      {loadState === "ready" && operation && approval && (
        <section className="approval-layout">
          <article className="panel approval-main">
            <div className="approval-alert">
              <span>!</span>
              <div>
                <p className="section-label">Human decision required</p>
                <h2>
                  {isSelectionApproval
                    ? `${quotes.length} carrier quotes are ready to compare`
                    : "Carrier changed the approved terms"}
                </h2>
              </div>
              <Status tone="amber">Waiting</Status>
            </div>
            <p className="approval-lead">
              {isSelectionApproval
                ? "Volta has completed the first calls. Choose the one carrier it may call back to confirm the quoted terms; this is not a booking yet."
                : "The carrier did not repeat the terms you authorized. Volta is waiting for a new instruction before it can continue."}
            </p>
            <div className="comparison-grid">
              <div>
                <span>Binding pickup</span>
                <b>{formatPickup(operation.mandate.pickupDatetime)}</b>
                <p>Must be confirmed on the closing call.</p>
              </div>
              <div className="recommended">
                <span>Volta recommends</span>
                <b>
                  {quotes.find(
                    (quote) => quote.id === approval.recommendedQuoteId
                  )?.carrierName ?? "Review revised terms"}
                </b>
                <p>
                  The recommendation is advisory; your selection is required.
                </p>
              </div>
            </div>
            {isSelectionApproval ? (
              <fieldset className="quote-selection" aria-label="Carrier quotes">
                <legend>Choose a carrier for the closing call</legend>
                {quotes.map((quote) => (
                  <label
                    className={
                      selectedQuoteId === quote.id
                        ? "quote-option selected"
                        : "quote-option"
                    }
                    key={quote.id}
                  >
                    <input
                      checked={selectedQuoteId === quote.id}
                      name="carrier-quote"
                      onChange={() => setSelectedQuoteId(quote.id)}
                      type="radio"
                      value={quote.id}
                    />
                    <span className="quote-carrier">
                      <b>{quote.carrierName}</b>
                      {quote.id === approval.recommendedQuoteId && (
                        <small>VOLTA PICK</small>
                      )}
                    </span>
                    <strong>{formatMxn(quote.priceMxn)}</strong>
                    <span>{formatPickup(quote.pickupTime)}</span>
                    <span>{quote.etaMinutes} min ETA</span>
                  </label>
                ))}
              </fieldset>
            ) : (
              <section className="quote-block">
                <div>
                  <span>Carrier</span>
                  <b>{quotes[0]?.carrierName}</b>
                </div>
                <div>
                  <span>Previous quote</span>
                  <b>{quotes[0] && formatMxn(quotes[0].priceMxn)}</b>
                </div>
                <div>
                  <span>New terms</span>
                  <b>
                    {approval.proposedTerms &&
                      formatMxn(approval.proposedTerms.finalPriceMxn)}
                  </b>
                </div>
              </section>
            )}
            <div className="whisper">
              <span>VOLTA</span>
              <p>
                {isSelectionApproval
                  ? "I have the market. Tell me who may receive the closing call, and I will only confirm the exact terms you authorize."
                  : "The terms changed on the call. I will not continue without your new approval."}
              </p>
            </div>
            {decisionError && (
              <p className="form-error approval-error" role="alert">
                {decisionError}
              </p>
            )}
            <div className="approval-actions">
              <m.button
                className="button button--primary"
                disabled={isSubmitting}
                onClick={() => void submitDecision("approve")}
                whileFocus={{ outlineOffset: 3 }}
                whileTap={{ scale: 0.98 }}
              >
                {isSubmitting
                  ? "Calling carrier…"
                  : isSelectionApproval
                    ? "Authorize closing call"
                    : "Authorize revised terms"}
              </m.button>
              <m.button
                className="button button--destructive"
                disabled={isSubmitting}
                onClick={() => void submitDecision("decline")}
                whileFocus={{ outlineOffset: 3 }}
                whileTap={{ scale: 0.98 }}
              >
                Decline
              </m.button>
            </div>
          </article>
          <aside className="panel mandate-card">
            <p className="section-label">Binding mandate</p>
            <h2>{operation.id}</h2>
            <dl>
              <div>
                <dt>Budget cap</dt>
                <dd>{formatMxn(operation.mandate.budgetCapMxn)}</dd>
              </div>
              <div>
                <dt>Pickup</dt>
                <dd>{formatPickup(operation.mandate.pickupDatetime)}</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>
                  {operation.origin} → {operation.destination}
                </dd>
              </div>
              <div>
                <dt>Container</dt>
                <dd>{operation.containerId}</dd>
              </div>
            </dl>
            <p className="audit-note">
              Your authorization is attached to the operation audit. Volta must
              repeat the same terms on the closing call before it can commit.
            </p>
          </aside>
        </section>
      )}
    </>
  );
}

function useLiveOperation() {
  const [operation, setOperation] = useState<OperationReadModel | null>(null);
  useEffect(() => {
    const refresh = async () => {
      const response = await fetch("/api/operation");
      if (response.ok) {
        setOperation((await response.json()) as OperationReadModel);
      }
    };
    void refresh();
    if (typeof EventSource === "undefined") return;
    const events = new EventSource("/api/events");
    const sync = () => void refresh();
    [
      "mandate.created",
      "call.started",
      "call.updated",
      "quote.registered",
      "approval.requested",
      "approval.resolved",
      "commitment.finalized",
      "call.supervision.changed"
    ].forEach((name) => events.addEventListener(name, sync));
    return () => events.close();
  }, []);
  return operation;
}

/**
 * Transcript arrives one utterance at a time over SSE, appended rather than
 * refetched: a call floor that reloads the whole transcript on every line
 * scrolls out from under whoever is reading it.
 */
function useLiveTranscript() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  useEffect(() => {
    void (async () => {
      const response = await fetch("/api/transcript");
      if (response.ok) {
        setSegments((await response.json()) as TranscriptSegment[]);
      }
    })();

    if (typeof EventSource === "undefined") return;
    const events = new EventSource("/api/events");
    events.addEventListener("transcript.appended", (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        segment: TranscriptSegment;
      };
      setSegments((current) =>
        current.some((item) => item.id === payload.segment.id)
          ? current
          : [...current, payload.segment]
      );
    });
    return () => events.close();
  }, []);

  return segments;
}

function supervisionTone(
  state: CallSupervisionState | undefined
): "blue" | "green" | "amber" | "red" | "neutral" {
  if (state === "human") return "amber";
  if (state === "briefing_supervisor") return "blue";
  return "neutral";
}

const supervisionLabel: Record<CallSupervisionState, string> = {
  agent: "Volta speaking",
  briefing_supervisor: "Briefing supervisor",
  human: "Human on the line",
  returned_to_agent: "Handed back to Volta"
};

async function callControl(callSid: string, action: string) {
  await fetch(`/api/calls/${encodeURIComponent(callSid)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "operator_requested" })
  });
}

function CallTranscript({ segments }: { segments: TranscriptSegment[] }) {
  if (segments.length === 0) {
    return <p className="transcript-empty">Listening…</p>;
  }
  return (
    <ol className="transcript">
      {segments.map((segment) => (
        <li key={segment.id} data-speaker={segment.speaker}>
          <span className="transcript-who">
            {segment.speaker === "agent" ? "Volta" : "Carrier"}
          </span>
          <span className="transcript-text">{segment.text}</span>
          <time>{Math.floor(segment.startMs / 1000)}s</time>
        </li>
      ))}
    </ol>
  );
}

function callDuration(session: CallSession): string {
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt ?? new Date().toISOString());
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function callTone(
  status: CallSession["status"]
): "blue" | "green" | "amber" | "red" | "neutral" {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "pending") return "amber";
  return "blue";
}

function CallFloorView() {
  const operation = useLiveOperation();
  const transcript = useLiveTranscript();
  return (
    <>
      <Topbar
        title="Call floor"
        eyebrow="Live negotiation"
        description="Every carrier leg is visible from dial through quote and outcome."
        action={
          <span className="floor-live">
            <i /> LIVE
          </span>
        }
      />
      <section className="call-grid">
        {(operation?.callSessions ?? []).map((session) => {
          const quote = operation?.quotes.find(
            (item) => item.id === session.quoteId || item.callId === session.id
          );
          // Handover only means anything while the line is still open.
          const live =
            session.status === "in_progress" || session.status === "pending";
          const supervision: CallSupervisionState =
            session.supervision?.state ?? "agent";
          return (
            <article className="panel call-card" key={session.id}>
              <div className="call-card-head">
                <Status tone={callTone(session.status)}>
                  {session.status.replace("_", " ")}
                </Status>
                <time>
                  <ClockIcon /> {callDuration(session)}
                </time>
              </div>
              <p className="machine-ref">{session.callSid ?? session.id}</p>
              <h2>
                {session.driverName ??
                  operation?.candidates.find(
                    (item) => item.id === session.carrierId
                  )?.name ??
                  "Carrier"}
              </h2>
              <p>
                <RouteIcon /> {operation?.origin} → {operation?.destination}
              </p>
              <div className="waveform waveform--blue">
                {Array.from({ length: 16 }, (_, index) => (
                  <i key={index} />
                ))}
              </div>

              <CallTranscript
                segments={transcript.filter(
                  (segment) =>
                    segment.callId === session.callSid ||
                    segment.callId === session.id
                )}
              />

              <div className="call-actions">
                {quote ? (
                  <strong>
                    {formatMxn(quote.priceMxn)} · {quote.etaMinutes} min
                  </strong>
                ) : (
                  <span>
                    {session.endedReason
                      ? `✕ ${session.endedReason}`
                      : "Awaiting quote"}
                  </span>
                )}
              </div>

              {live && (
                <div className="call-supervision">
                  <Status tone={supervisionTone(supervision)}>
                    {supervisionLabel[supervision]}
                  </Status>
                  {supervision === "human" ? (
                    <button
                      className="button button--secondary"
                      onClick={() =>
                        void callControl(
                          session.callSid ?? session.id,
                          "handback"
                        )
                      }
                    >
                      Hand back to Volta
                    </button>
                  ) : supervision === "briefing_supervisor" ? (
                    <button
                      className="button button--primary"
                      onClick={() =>
                        void callControl(
                          session.callSid ?? session.id,
                          "connect"
                        )
                      }
                    >
                      Join the call
                    </button>
                  ) : (
                    <button
                      className="button button--destructive"
                      onClick={() =>
                        void callControl(
                          session.callSid ?? session.id,
                          "takeover"
                        )
                      }
                    >
                      Take over
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </section>
      {!operation?.callSessions.length && (
        <section className="panel decision-complete">
          <PhoneIcon />
          <p className="section-label">No active calls</p>
          <h2>Launch a mandate to open the carrier floor.</h2>
        </section>
      )}
    </>
  );
}

function PipelineView() {
  const operation = useLiveOperation();
  const [expanded, setExpanded] = useState(false);
  const completed =
    operation?.callSessions.filter((item) => item.status === "completed")
      .length ?? 0;
  const best = operation?.quotes
    .slice()
    .sort((left, right) => left.priceMxn - right.priceMxn)[0];
  return (
    <>
      <Topbar
        title="Pipeline"
        eyebrow="Operation progress"
        description="Persisted stages and live call outcomes for the active operation."
      />
      {operation && (
        <section className="panel activity-card">
          <button
            className="operation-row"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <div>
              <span className="machine-ref">{operation.id}</span>
              <b>
                {operation.origin} → {operation.destination}
              </b>
            </div>
            <div>
              <span>Stage</span>
              <Status tone="blue">
                {operation.pipelineStage.replace("_", " ")}
              </Status>
            </div>
            <span>
              {completed}/{operation.callSessions.length} calls
            </span>
            <strong>{best ? formatMxn(best.priceMxn) : "—"}</strong>
            <ChevronIcon />
          </button>
          {expanded && (
            <ul className="timeline">
              {operation.callSessions.map((session) => (
                <li key={session.id}>
                  <i
                    className={`timeline-mark ${session.status === "completed" ? "green" : "blue"}`}
                  />
                  <div>
                    <b>
                      {session.driverName ?? session.carrierId ?? "Carrier"}
                    </b>
                    <time>{callDuration(session)}</time>
                    <p>
                      {session.status}
                      {session.endedReason ? ` · ${session.endedReason}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function CarriersView() {
  const [carriers, setCarriers] = useState<
    Array<{
      id: string;
      name: string;
      phone: string;
      lanes: string[];
      active: boolean;
    }>
  >([]);
  const refresh = async () => {
    const response = await fetch("/api/carriers");
    if (response.ok) setCarriers(await response.json());
  };
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <Topbar
        title="Carriers"
        eyebrow="Network directory"
        description="Maintain the active carrier pool used for the next mandate fan-out."
      />
      <form
        className="panel form-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const response = await fetch("/api/carriers", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: data.get("name"),
              phone: data.get("phone"),
              lanes: String(data.get("lanes") ?? "")
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean)
            })
          });
          if (response.ok) {
            event.currentTarget.reset();
            await refresh();
          }
        }}
      >
        <div className="step-heading">
          <span>+</span>
          <div>
            <h2>Add carrier</h2>
            <p>Only active carriers receive new call rounds.</p>
          </div>
        </div>
        <div className="form-grid">
          <label>
            Name
            <input name="name" required />
          </label>
          <label>
            Phone
            <input name="phone" type="tel" required />
          </label>
          <label className="span-2">
            Lanes
            <input name="lanes" placeholder="Manzanillo → Guadalajara" />
          </label>
        </div>
        <button className="button button--primary" type="submit">
          Add carrier <PlusIcon />
        </button>
      </form>
      <section className="panel activity-card">
        {carriers.map((carrier) => (
          <div className="operation-row" key={carrier.id}>
            <div>
              <span className="machine-ref">{carrier.phone}</span>
              <b>{carrier.name}</b>
            </div>
            <div>
              <span>Lanes</span>
              <b>{carrier.lanes.join(", ") || "All lanes"}</b>
            </div>
            <span />
            <Status tone={carrier.active ? "green" : "neutral"}>
              {carrier.active ? "active" : "inactive"}
            </Status>
            <RouteIcon />
          </div>
        ))}
      </section>
    </>
  );
}

function localMessage(
  id: string,
  role: CopilotMessage["role"],
  content: string
): CopilotMessage {
  return {
    id,
    conversationId: "local",
    role,
    content,
    citations: [],
    proposedActions: [],
    createdAt: new Date().toISOString()
  };
}

async function readAgentMessage(response: Response): Promise<AgentMessage> {
  if (!response.ok) throw new Error("agent_request_rejected");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("agent_stream_unavailable");
  const decoder = new TextDecoder();
  let buffer = "";
  let finalMessage: AgentMessage | undefined;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const eventName = event
        .split("\n")
        .find((line) => line.startsWith("event: "))
        ?.slice(7);
      const data = event
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (eventName === "error") throw new Error("agent_stream_failed");
      if (eventName === "final" && data) {
        finalMessage = JSON.parse(data) as AgentMessage;
      }
    }
    if (done) break;
  }
  if (!finalMessage) throw new Error("agent_answer_missing");
  return finalMessage;
}

function DispatchCopilot() {
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CopilotMessage[]>([
    localMessage(
      "copilot-welcome",
      "assistant",
      "I can explain every shipment, negotiation, call, transcript, exception, and the next safe action."
    )
  ]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const historyRestoredRef = useRef(false);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || conversationId || historyRestoredRef.current) return;
    historyRestoredRef.current = true;
    let cancelled = false;
    async function restoreHistory() {
      setIsRestoring(true);
      try {
        const listResponse = await fetch("/api/agent/conversations");
        if (!listResponse.ok) return;
        const conversations =
          (await listResponse.json()) as AgentConversation[];
        const latest = conversations[0];
        if (!latest || cancelled) return;
        const detailResponse = await fetch(
          `/api/agent/conversations/${latest.id}`
        );
        if (!detailResponse.ok) return;
        const detail = (await detailResponse.json()) as AgentConversation;
        if (cancelled) return;
        setConversationId(detail.id);
        setMessages((current) => [current[0], ...detail.messages]);
      } catch {
        // A new conversation will be created on the first question.
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    }
    void restoreHistory();
    return () => {
      cancelled = true;
    };
  }, [conversationId, isOpen]);

  async function askCopilot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSending || isRestoring) return;

    const userMessage = localMessage(
      "user-" + Date.now(),
      "user",
      trimmedQuestion
    );
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setIsSending(true);

    try {
      let activeConversationId = conversationId;
      if (!activeConversationId) {
        const conversationResponse = await fetch("/api/agent/conversations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: trimmedQuestion.slice(0, 120) })
        });
        if (!conversationResponse.ok) throw new Error("conversation_failed");
        const conversation =
          (await conversationResponse.json()) as AgentConversation;
        activeConversationId = conversation.id;
        setConversationId(conversation.id);
      }
      const response = await fetch(
        `/api/agent/conversations/${activeConversationId}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: trimmedQuestion })
        }
      );
      const assistantMessage = await readAgentMessage(response);
      setMessages((current) => [...current, assistantMessage]);
    } catch {
      setMessages((current) => [
        ...current,
        localMessage(
          "assistant-" + Date.now(),
          "assistant",
          "I could not reach the operational agent. No action was taken; try again shortly."
        )
      ]);
    } finally {
      setIsSending(false);
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
      const payload = (await response.json()) as { action: ProposedAction };
      setMessages((current) =>
        current.map((message) => ({
          ...message,
          proposedActions: message.proposedActions.map((item) =>
            item.id === action.id ? payload.action : item
          )
        }))
      );
    } catch {
      setMessages((current) => [
        ...current,
        localMessage(
          "action-error-" + Date.now(),
          "assistant",
          "The action could not be decided safely. Refresh the operation before trying again."
        )
      ]);
    }
  }

  return (
    <>
      <m.button
        aria-controls="dispatch-copilot"
        aria-expanded={isOpen}
        aria-label="Ask Volta"
        className="copilot-launcher"
        onClick={() => setIsOpen(true)}
        whileTap={{ scale: 0.98 }}
      >
        <span className="copilot-launcher-mark">V/</span>
        Ask Volta
      </m.button>
      <AnimatePresence>
        {isOpen && (
          <>
            <m.button
              aria-label="Close Volta Copilot"
              className="copilot-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
            />
            <m.aside
              aria-label="Volta Copilot"
              className="copilot-panel"
              exit={{ opacity: 0, x: 24 }}
              id="dispatch-copilot"
              initial={{ opacity: 0, x: 32 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <header className="copilot-header">
                <div>
                  <p className="section-label">Process copilot</p>
                  <h2>Ask Volta</h2>
                </div>
                <button
                  aria-label="Close Volta Copilot"
                  className="copilot-close"
                  onClick={() => setIsOpen(false)}
                  type="button"
                >
                  ×
                </button>
              </header>
              <p className="copilot-context">
                Backend agent grounded in operational records. Every factual
                answer links to its evidence; actions wait for your approval.
              </p>
              <section className="copilot-thread" aria-live="polite">
                <AnimatePresence initial={false}>
                  {messages.map((message) => (
                    <m.article
                      animate={{ opacity: 1, y: 0 }}
                      className={
                        "copilot-message copilot-message--" + message.role
                      }
                      exit={{ opacity: 0, y: -4 }}
                      initial={{ opacity: 0, y: 8 }}
                      key={message.id}
                    >
                      <b>{message.role === "assistant" ? "VOLTA" : "YOU"}</b>
                      <p>{message.content}</p>
                      {message.citations.length > 0 && (
                        <ol className="copilot-citations" aria-label="Evidence">
                          {message.citations.map((citation) => (
                            <li key={citation.id}>
                              <a href={citation.href} target="_blank">
                                {citation.title}
                              </a>
                              <time dateTime={citation.occurredAt}>
                                {new Date(citation.occurredAt).toLocaleString()}
                              </time>
                            </li>
                          ))}
                        </ol>
                      )}
                      {message.proposedActions.map((action) => (
                        <section className="copilot-action" key={action.id}>
                          <span>Human approval required</span>
                          <p>{action.summary}</p>
                          {action.status === "pending" ? (
                            <div>
                              <button
                                className="button button--primary"
                                onClick={() =>
                                  void decideAction(action, "approve")
                                }
                                type="button"
                              >
                                Approve action
                              </button>
                              <button
                                className="button button--secondary"
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
                {isSending && (
                  <div className="copilot-thinking">
                    <i />
                    Volta is reviewing the operation
                  </div>
                )}
              </section>
              <form className="copilot-composer" onSubmit={askCopilot}>
                <label htmlFor="copilot-question">
                  Ask across operational history
                </label>
                <textarea
                  id="copilot-question"
                  onChange={(event) => setQuestion(event.target.value)}
                  ref={inputRef}
                  rows={3}
                  value={question}
                />
                <m.button
                  className="button button--primary"
                  disabled={!question.trim() || isSending || isRestoring}
                  type="submit"
                  whileTap={{ scale: 0.98 }}
                >
                  {isSending
                    ? "Reviewing…"
                    : isRestoring
                      ? "Loading history…"
                      : "Ask Volta"}
                  <ArrowIcon />
                </m.button>
              </form>
            </m.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export function DashboardConsole() {
  const [view, setView] = useState<View>("new-mandate");
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <div className="app-shell">
          <aside className="nav-rail">
            <div className="brand">
              <span>V</span>
              <div>
                <b>Volta</b>
                <small>DISPATCH BLUE V1.0</small>
              </div>
            </div>
            <nav aria-label="Primary navigation">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <m.button
                    key={item.id}
                    className={view === item.id ? "active" : ""}
                    aria-current={view === item.id ? "page" : undefined}
                    onClick={() => setView(item.id)}
                    whileFocus={{ outlineOffset: 3 }}
                    whileTap={{ scale: 0.98 }}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </m.button>
                );
              })}
            </nav>
            <div className="rail-footer">
              <span className="operator-avatar">O</span>
              <div>
                <b>Operator</b>
                <small>Dispatcher</small>
              </div>
              <button aria-label="Open operator menu">•••</button>
            </div>
          </aside>
          <main>
            <AnimatePresence initial={false} mode="wait">
              <m.div
                animate={{ opacity: 1, y: 0 }}
                className="view-stage"
                exit={{ opacity: 0, y: -4 }}
                initial={{ opacity: 0, y: 8 }}
                key={view}
              >
                {view === "new-mandate" && (
                  <NewMandateView onCreated={() => setView("call-floor")} />
                )}
                {view === "call-floor" && <CallFloorView />}
                {view === "pipeline" && <PipelineView />}
                {view === "carriers" && <CarriersView />}
                {view === "approvals" && <ApprovalsView />}
              </m.div>
            </AnimatePresence>
          </main>
          <DispatchCopilot />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
