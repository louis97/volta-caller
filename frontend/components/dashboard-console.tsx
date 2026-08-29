"use client";

import { useState } from "react";
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

function Waveform({ blue = false }: { blue?: boolean }) {
  return (
    <span
      className={`waveform ${blue ? "waveform--blue" : ""}`}
      aria-label="Live audio"
    >
      {bars.map((height, index) => (
        <i key={index} style={{ height, animationDelay: `${index * 45}ms` }} />
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
    <span className={`status status--${tone}`}>
      {live && <i className="live-dot" />}
      {children}
    </span>
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
          <button
            className="button button--primary"
            onClick={() => navigate("new-mandate")}
          >
            <PlusIcon /> New mandate
          </button>
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
            <button
              className="button button--primary full"
              onClick={() => navigate("approvals")}
            >
              Review approval <ArrowIcon />
            </button>
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
  const [saved, setSaved] = useState(false);
  return (
    <>
      <Topbar
        title="New mandate"
        eyebrow="Create operation"
        description="Define the boundaries Volta must obey before it speaks to a carrier."
      />
      <form
        className="mandate-layout"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(true);
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
          {saved ? (
            <div className="saved-message">
              <i /> Mandate VLT-2042 created
            </div>
          ) : (
            <button className="button button--primary full" type="submit">
              Launch mandate <ArrowIcon />
            </button>
          )}
          {saved && (
            <button
              className="button button--secondary full"
              type="button"
              onClick={onCreated}
            >
              Open operation
            </button>
          )}
        </aside>
      </form>
    </>
  );
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

function ApprovalsView() {
  const [decision, setDecision] = useState<"approved" | "declined" | null>(
    null
  );
  return (
    <>
      <Topbar
        title="Approvals"
        eyebrow="Human decisions"
        description="Review the exceptions Volta cannot resolve inside its binding mandate."
      />
      {decision ? (
        <section className="panel decision-complete">
          <span
            className={
              decision === "approved" ? "success-ring" : "decline-ring"
            }
          >
            {decision === "approved" ? "✓" : "×"}
          </span>
          <p className="section-label">Decision recorded</p>
          <h2>
            {decision === "approved"
              ? "Pickup exception approved"
              : "Pickup exception declined"}
          </h2>
          <p>
            The call log now states that a human made this decision at 2:36 PM.
          </p>
          <button
            className="button button--secondary"
            onClick={() => setDecision(null)}
          >
            Review again
          </button>
        </section>
      ) : (
        <section className="approval-layout">
          <article className="panel approval-main">
            <div className="approval-alert">
              <span>!</span>
              <div>
                <p className="section-label">Human decision required</p>
                <h2>Carrier requests a later pickup</h2>
              </div>
              <Status tone="amber">Waiting 03:42</Status>
            </div>
            <p className="approval-lead">
              Transportes Costa Pacífico meets the price limit, but can only
              arrive at 12:30 PM — 2 hours 30 minutes after the authorized
              window.
            </p>
            <div className="comparison-grid">
              <div>
                <span>Clause triggered</span>
                <b>Pickup window</b>
                <p>Authorized: Thu · 10:00 AM</p>
              </div>
              <div className="recommended">
                <span>Agent recommends</span>
                <b>Approve the exception</b>
                <p>Rate is MXN 250 below the ceiling.</p>
              </div>
            </div>
            <section className="quote-block">
              <div>
                <span>Carrier</span>
                <b>Transportes Costa Pacífico</b>
              </div>
              <div>
                <span>Quote</span>
                <b className="mono">MXN 8,750</b>
              </div>
              <div>
                <span>Requested pickup</span>
                <b className="mono">Thu · 12:30 PM</b>
              </div>
            </section>
            <div className="whisper">
              <span>VOLTA</span>
              <p>
                They can hold MXN 8,750 if we confirm the revised pickup time
                now. Should I accept?
              </p>
            </div>
            <div className="approval-actions">
              <button
                className="button button--primary"
                onClick={() => setDecision("approved")}
              >
                Approve exception
              </button>
              <button
                className="button button--destructive"
                onClick={() => setDecision("declined")}
              >
                Keep original mandate
              </button>
            </div>
          </article>
          <aside className="panel mandate-card">
            <p className="section-label">Binding mandate</p>
            <h2>VLT-2041</h2>
            <dl>
              <div>
                <dt>Budget cap</dt>
                <dd>MXN 9,000</dd>
              </div>
              <div>
                <dt>Pickup</dt>
                <dd>Thu · 10:00 AM</dd>
              </div>
              <div>
                <dt>Route</dt>
                <dd>Manzanillo → Guadalajara</dd>
              </div>
              <div>
                <dt>Container</dt>
                <dd>MSCU-TP-001</dd>
              </div>
            </dl>
            <p className="audit-note">
              Your decision will be attached to the call transcript and
              operation audit.
            </p>
          </aside>
        </section>
      )}
    </>
  );
}

export function DashboardConsole() {
  const [view, setView] = useState<View>("operations");
  return (
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
              <button
                key={item.id}
                className={view === item.id ? "active" : ""}
                aria-current={view === item.id ? "page" : undefined}
                onClick={() => setView(item.id)}
              >
                <Icon />
                <span>{item.label}</span>
                {item.count && (
                  <b className={`nav-count ${item.tone}`}>{item.count}</b>
                )}
              </button>
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
        {view === "operations" && <OperationsView navigate={setView} />}
        {view === "new-mandate" && (
          <NewMandateView onCreated={() => setView("operations")} />
        )}
        {view === "call-floor" && <CallFloorView />}
        {view === "approvals" && <ApprovalsView />}
      </main>
    </div>
  );
}
