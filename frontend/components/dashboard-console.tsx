"use client";

import type {
  ApprovalRequest,
  CreateMandateRequest,
  Operation,
  Quote
} from "@volta/contracts";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  animate,
  domMax,
  useMotionValue,
  useReducedMotion,
  useSpring
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

type View = "operations" | "new-mandate" | "call-floor" | "approvals";

type MandateSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; operationId: string }
  | { status: "error"; message: string };

type CopilotMessage = {
  id: string;
  content: string;
  role: "assistant" | "user";
};

const MANDATE_TIMEZONE_OFFSET = "-06:00";

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof OperationsIcon;
  count?: number;
  tone?: "live" | "waiting";
}> = [
  { id: "operations", label: "Operations", icon: OperationsIcon },
  { id: "new-mandate", label: "New mandate", icon: PlusIcon },
  {
    id: "call-floor",
    label: "Call floor",
    icon: PhoneIcon,
    count: 4,
    tone: "live"
  },
  {
    id: "approvals",
    label: "Approvals",
    icon: ApprovalIcon,
    count: 1,
    tone: "waiting"
  }
];

const bars = [
  8, 14, 10, 20, 26, 16, 12, 30, 22, 25, 14, 19, 11, 27, 32, 13, 18, 29, 21, 25,
  12, 17
];

function WaveformBar({ height, index }: { height: number; index: number }) {
  const shouldReduceMotion = useReducedMotion();
  const amplitude = useMotionValue(0.42);
  const scaleY = useSpring(amplitude, {
    damping: 18,
    stiffness: 320
  });

  useEffect(() => {
    if (shouldReduceMotion) {
      amplitude.set(1);
      return;
    }

    const controls = animate(amplitude, [0.34, 1, 0.52, 0.84], {
      delay: index * 0.028,
      duration: 0.72 + (index % 4) * 0.08,
      ease: "easeInOut",
      repeat: Infinity,
      repeatType: "mirror"
    });

    return () => controls.stop();
  }, [amplitude, index, shouldReduceMotion]);

  return <m.i aria-hidden="true" style={{ height, scaleY }} />;
}

function Waveform({ blue = false }: { blue?: boolean }) {
  return (
    <span
      className={`waveform ${blue ? "waveform--blue" : ""}`}
      aria-label="Live audio"
    >
      {bars.map((height, index) => (
        <WaveformBar height={height} index={index} key={index} />
      ))}
    </span>
  );
}

function Status({
  children,
  tone,
  live
}: {
  children: React.ReactNode;
  tone: "blue" | "green" | "amber" | "red" | "neutral";
  live?: boolean;
}) {
  return (
    <m.span layout="position" className={`status status--${tone}`}>
      {live && <i className="live-dot" />}
      {children}
    </m.span>
  );
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

function Metric({
  label,
  value,
  detail,
  tone
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <article className="metric panel">
      <p className="section-label">{label}</p>
      <strong className={tone}>{value}</strong>
      <span>{detail}</span>
    </article>
  );
}

function OperationsView({ navigate }: { navigate: (view: View) => void }) {
  return (
    <>
      <Topbar
        title="Operations"
        description="Monitor every mandate, call, and commitment from one dispatch desk."
        action={
          <m.button
            className="button button--primary"
            onClick={() => navigate("new-mandate")}
            whileFocus={{ outlineOffset: 3 }}
            whileTap={{ scale: 0.98 }}
          >
            <PlusIcon /> New mandate
          </m.button>
        }
      />

      <section className="metric-grid" aria-label="Today's dispatch metrics">
        <Metric label="Active mandates" value="12" detail="3 negotiating now" />
        <Metric
          label="Calls today"
          value="34"
          detail="4 live on the floor"
          tone="metric-blue"
        />
        <Metric
          label="Needs you"
          value="1"
          detail="Budget exception"
          tone="metric-amber"
        />
        <Metric
          label="Award rate"
          value="68%"
          detail="+7% from last week"
          tone="metric-green"
        />
      </section>

      <div className="workspace-grid">
        <section className="panel operations-panel">
          <div className="panel-heading">
            <div>
              <p className="section-label">Live operations</p>
              <h2>Freight in motion</h2>
            </div>
            <button className="text-action">
              View all <ArrowIcon />
            </button>
          </div>

          <article className="operation-feature">
            <div className="operation-title">
              <Status tone="green" live>
                Negotiating
              </Status>
              <span className="machine-ref">VLT-2041</span>
            </div>
            <h3>Textiles Pacífico</h3>
            <div className="route-line">
              <span>Manzanillo</span>
              <i />
              <RouteIcon />
              <i />
              <span>Guadalajara</span>
            </div>
            <div className="operation-facts">
              <div>
                <span>Container</span>
                <strong>MSCU-TP-001</strong>
              </div>
              <div>
                <span>Budget cap</span>
                <strong>MXN 9,000</strong>
              </div>
              <div>
                <span>Pickup</span>
                <strong>Thu · 10:00 AM</strong>
              </div>
              <div>
                <span>Best quote</span>
                <strong className="positive">MXN 8,640</strong>
              </div>
            </div>
            <div className="agent-line">
              <span className="agent-avatar">V</span>
              <div>
                <b>Volta is speaking with Ruta Occidente</b>
                <span>Countered at MXN 8,640 using the lane average.</span>
              </div>
              <Waveform />
            </div>
          </article>

          <div className="operation-row">
            <div>
              <span className="machine-ref">VLT-2038</span>
              <b>Aceros del Bajío</b>
            </div>
            <span>Veracruz → León</span>
            <Status tone="blue">Calling 2 of 5</Status>
            <strong>MXN 12,400</strong>
            <ChevronIcon />
          </div>
          <div className="operation-row">
            <div>
              <span className="machine-ref">VLT-2036</span>
              <b>Agroexport del Sur</b>
            </div>
            <span>Lázaro Cárdenas → Morelia</span>
            <Status tone="green">Awarded</Status>
            <strong>MXN 7,950</strong>
            <ChevronIcon />
          </div>
          <div className="operation-row">
            <div>
              <span className="machine-ref">VLT-2032</span>
              <b>Casa Norte</b>
            </div>
            <span>Altamira → Monterrey</span>
            <Status tone="neutral">Wrap-up</Status>
            <strong>MXN 10,180</strong>
            <ChevronIcon />
          </div>
        </section>

        <aside className="right-column">
          <section className="panel attention-card">
            <div className="attention-head">
              <span className="attention-icon">!</span>
              <Status tone="amber">Needs you</Status>
            </div>
            <p className="section-label amber-text">Human decision required</p>
            <h2>Pickup window exception</h2>
            <p>
              Transportes Costa Pacífico can meet the budget, but requested
              pickup at 12:30 PM.
            </p>
            <dl>
              <div>
                <dt>Quoted</dt>
                <dd>MXN 8,750</dd>
              </div>
              <div>
                <dt>Mandate</dt>
                <dd>Thu · 10:00 AM</dd>
              </div>
            </dl>
            <m.button
              className="button button--primary full"
              onClick={() => navigate("approvals")}
              whileFocus={{ outlineOffset: 3 }}
              whileTap={{ scale: 0.98 }}
            >
              Review approval <ArrowIcon />
            </m.button>
          </section>

          <section className="panel activity-card">
            <div className="panel-heading">
              <div>
                <p className="section-label">Agent activity</p>
                <h2>Latest work</h2>
              </div>
              <span className="live-label">
                <i />
                Live
              </span>
            </div>
            <ol className="timeline">
              <li>
                <i className="timeline-mark blue" />
                <div>
                  <b>Quote registered</b>
                  <p>Ruta Occidente · MXN 8,640</p>
                  <time>14:32</time>
                </div>
              </li>
              <li>
                <i className="timeline-mark green" />
                <div>
                  <b>Carrier reached</b>
                  <p>Volta connected after 2 attempts</p>
                  <time>14:29</time>
                </div>
              </li>
              <li>
                <i className="timeline-mark" />
                <div>
                  <b>Mandate checked</b>
                  <p>Budget and pickup constraints loaded</p>
                  <time>14:28</time>
                </div>
              </li>
            </ol>
          </section>
        </aside>
      </div>
    </>
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
              <select name="type_of_content" defaultValue="textiles" required>
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
                  defaultValue="18400"
                  required
                />
                <span>KG</span>
              </div>
            </label>
            <label className="span-2">
              Measures
              <input
                className="mono"
                name="measures"
                defaultValue="120 × 100 × 110 cm"
                placeholder="Length × width × height"
                required
              />
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
              <input
                name="pickup_address"
                defaultValue="Terminal de Contenedores, Manzanillo, Colima"
                required
              />
            </label>
            <label>
              Pickup date &amp; time
              <input
                className="mono"
                name="pickup_datetime"
                type="datetime-local"
                defaultValue="2026-09-03T10:00"
                required
              />
            </label>
            <label>
              Destination date &amp; time
              <input
                className="mono"
                name="destination_datetime"
                type="datetime-local"
                defaultValue="2026-09-03T18:00"
                required
              />
            </label>
            <label className="span-2">
              Destination place
              <input
                name="destination_place"
                defaultValue="Textiles Pacífico, Guadalajara, Jalisco"
                required
              />
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
                  defaultValue="9000"
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
                The agent cannot exceed MXN 9,000 or change either datetime
                without human approval.
              </p>
            </div>
          </div>
        </section>
        <aside className="panel mandate-summary">
          <p className="section-label">Mandate preview</p>
          <h2>Manzanillo → Guadalajara</h2>
          <div className="summary-route">
            <RouteIcon />
            <div>
              <span>Pickup</span>
              <b>Terminal de Contenedores</b>
              <small>Thu, Sep 03 · 10:00 AM</small>
            </div>
          </div>
          <div className="summary-route">
            <ClockIcon />
            <div>
              <span>Destination deadline</span>
              <b>Thu, Sep 03 · 6:00 PM</b>
            </div>
          </div>
          <div className="summary-route">
            <span className="currency-icon">$</span>
            <div>
              <span>Hard ceiling</span>
              <b>MXN 9,000</b>
            </div>
          </div>
          <hr />
          <p className="summary-copy">
            Textiles · 18,400 kg · 120 × 100 × 110 cm. Volta may negotiate any
            rate at or below the ceiling; either datetime remains binding.
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

const liveCalls = [
  {
    carrier: "Ruta Occidente",
    operation: "VLT-2041",
    detail: "Countering at MXN 8,640",
    time: "02:08",
    tone: "green" as const
  },
  {
    carrier: "Transportes del Centro",
    operation: "VLT-2038",
    detail: "Confirming equipment availability",
    time: "01:14",
    tone: "blue" as const
  },
  {
    carrier: "Carga Express MX",
    operation: "VLT-2029",
    detail: "Waiting for dispatcher",
    time: "00:46",
    tone: "amber" as const
  },
  {
    carrier: "Logística Manzanillo",
    operation: "VLT-2041",
    detail: "Ringing · attempt 2",
    time: "00:18",
    tone: "blue" as const
  }
];

function CallFloorView() {
  return (
    <>
      <Topbar
        title="Call floor"
        eyebrow="Live voice operations"
        description="Hear where the work is happening and follow every agent decision in real time."
        action={
          <div className="floor-live">
            <i />4 calls live
          </div>
        }
      />
      <section className="call-grid">
        {liveCalls.map((call, index) => (
          <article
            className={`panel call-card ${index === 0 ? "call-card--featured" : ""}`}
            key={call.carrier}
          >
            <div className="call-card-head">
              <Status tone={call.tone} live>
                {index === 3 ? "Ringing" : "Talking"}
              </Status>
              <time>{call.time}</time>
            </div>
            <span className="machine-ref">{call.operation}</span>
            <h2>{call.carrier}</h2>
            <p>{call.detail}</p>
            <Waveform blue={call.tone === "blue"} />
            <div className="call-actions">
              <button className="button button--secondary">
                Open transcript
              </button>
              <button
                className="icon-button"
                aria-label={`Open ${call.carrier}`}
              >
                <ArrowIcon />
              </button>
            </div>
          </article>
        ))}
      </section>
      <section className="panel transcript-panel">
        <div className="panel-heading">
          <div>
            <p className="section-label">Selected call</p>
            <h2>Live transcript · Ruta Occidente</h2>
          </div>
          <span className="machine-ref">VLT-2041 / 02:08</span>
        </div>
        <div className="transcript-line agent">
          <b>
            VOLTA <time>02:01</time>
          </b>
          <p>
            We can confirm today at MXN 8,640. Does that work with a Thursday
            10:00 AM pickup?
          </p>
        </div>
        <div className="transcript-line carrier">
          <b>
            CARRIER <time>02:08</time>
          </b>
          <p>Let me verify the truck. Hold for a moment.</p>
        </div>
        <div className="transcript-thinking">
          <i />
          <span>Volta is listening</span>
          <Waveform />
        </div>
      </section>
    </>
  );
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
            : undefined,
          decidedBy: "Bryan Riano"
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
          body: JSON.stringify({ undoneBy: "Bryan Riano" })
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

  async function runMockClosingCall() {
    setDecisionError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/demo/close-approved-deal", {
        method: "POST"
      });
      if (!response.ok) throw new Error("mock_close_failed");
      setOperation((await response.json()) as Operation);
    } catch {
      setDecisionError("Volta could not start the demo closing call.");
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
            <m.button
              className="button button--primary"
              disabled={isSubmitting}
              onClick={() => void runMockClosingCall()}
              whileFocus={{ outlineOffset: 3 }}
              whileTap={{ scale: 0.98 }}
            >
              {isSubmitting ? "Starting call…" : "Run demo closing call"}
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

function DispatchCopilot() {
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<CopilotMessage[]>([
    {
      id: "copilot-welcome",
      role: "assistant",
      content:
        "I can explain the mandate, call progress, quotes, exceptions, and the next safe action."
    }
  ]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  async function askCopilot(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion || isSending) return;

    const history = messages;
    const userMessage: CopilotMessage = {
      id: "user-" + Date.now(),
      role: "user",
      content: trimmedQuestion
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setIsSending(true);

    try {
      const response = await fetch("/api/copilot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: trimmedQuestion,
          history: history.slice(-8).map(({ role, content }) => ({
            role,
            content
          }))
        })
      });
      const payload = (await response.json()) as {
        answer?: unknown;
        message?: unknown;
      };
      const answer =
        typeof payload.answer === "string"
          ? payload.answer
          : typeof payload.message === "string"
            ? payload.message
            : "Volta Copilot could not answer right now. Try again shortly.";

      setMessages((current) => [
        ...current,
        {
          id: "assistant-" + Date.now(),
          role: "assistant",
          content: answer
        }
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: "assistant-" + Date.now(),
          role: "assistant",
          content:
            "I could not reach the dispatch API. Keep the mandate unchanged and try again."
        }
      ]);
    } finally {
      setIsSending(false);
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
                Grounded in the API-owned operation, never authorized to change
                a mandate or make a booking.
              </p>
              <div className="copilot-prompts" aria-label="Suggested questions">
                {[
                  "What is the current risk?",
                  "What can Volta negotiate?",
                  "What needs my approval?"
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => setQuestion(prompt)}
                    type="button"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
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
                  Ask about this dispatch
                </label>
                <textarea
                  id="copilot-question"
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What changed in this operation?"
                  ref={inputRef}
                  rows={3}
                  value={question}
                />
                <m.button
                  className="button button--primary"
                  disabled={!question.trim() || isSending}
                  type="submit"
                  whileTap={{ scale: 0.98 }}
                >
                  {isSending ? "Reviewing…" : "Ask Volta"}
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
  const [view, setView] = useState<View>("operations");
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
                    {item.count && (
                      <b className={`nav-count ${item.tone}`}>{item.count}</b>
                    )}
                  </m.button>
                );
              })}
            </nav>
            <div className="rail-footer">
              <span className="operator-avatar">BR</span>
              <div>
                <b>Bryan Riano</b>
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
                {view === "operations" && <OperationsView navigate={setView} />}
                {view === "new-mandate" && (
                  <NewMandateView onCreated={() => setView("operations")} />
                )}
                {view === "call-floor" && <CallFloorView />}
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
