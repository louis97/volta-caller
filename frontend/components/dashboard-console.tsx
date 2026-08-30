"use client";

import type {
  CallSession,
  CallSupervisionState,
  CreateMandateRequest,
  Operation,
  OperationReadModel,
  PipelineStage,
  Quote,
  QuoteExtraction,
  ShipmentEvent,
  TranscriptSegment
} from "@volta/contracts";
import {
  AnimatePresence,
  LazyMotion,
  MotionConfig,
  domMax
} from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchOperationalRead } from "./api-client";
import {
  AlertIcon,
  ApprovalIcon,
  ArrowIcon,
  BrainIcon,
  BoxIcon,
  ChevronIcon,
  ClockIcon,
  MoonIcon,
  OperationsIcon,
  PhoneIcon,
  PlusIcon,
  RouteIcon,
  SunIcon
} from "./icons";
import { VoltaChat } from "./volta-chat";

type View =
  | "volta"
  | "new-mandate"
  | "call-floor"
  | "pipeline"
  | "carriers"
  | "notifications";

type Tone = "signal" | "brass" | "commit" | "halt" | "idle";

type MandateSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; operationId: string }
  | { status: "error"; message: string };

const MANDATE_TIMEZONE_OFFSET = "-06:00";

const navItems: Array<{
  id: View;
  label: string;
  icon: typeof ApprovalIcon;
}> = [
  { id: "volta", label: "Volta", icon: BrainIcon },
  { id: "new-mandate", label: "New mandate", icon: PlusIcon },
  { id: "call-floor", label: "Call floor", icon: PhoneIcon },
  { id: "pipeline", label: "Pipeline", icon: OperationsIcon },
  { id: "carriers", label: "Carriers", icon: RouteIcon },
  { id: "notifications", label: "Notifications", icon: AlertIcon }
];

/* -------------------------------------------------------------- store ---- */

/**
 * The rail and the console strip have to answer "is Volta waiting on me?"
 * from every screen. Rather than issue a second poll from the shell, whichever
 * view has just loaded the operation publishes this digest of it. Only the
 * pipeline read model carries a stage, so the field stays optional.
 */
type ConsoleSnapshot = {
  id: string;
  origin: string;
  destination: string;
  stage?: PipelineStage;
  liveLines: number;
  waiting: number;
};

let operationSnapshot: ConsoleSnapshot | null = null;
const snapshotListeners = new Set<() => void>();

function publishOperation(operation: Operation | OperationReadModel) {
  operationSnapshot = {
    id: operation.id,
    origin: operation.origin,
    destination: operation.destination,
    stage: "pipelineStage" in operation ? operation.pipelineStage : undefined,
    liveLines: operation.callSessions.filter(isLiveCall).length,
    waiting:
      operation.status === "awaiting_client_selection"
        ? operation.reviewedDeals.filter(
            (deal) => deal.mandateDecision === "APPROVED"
          ).length
        : 0
  };
  snapshotListeners.forEach((listener) => listener());
}

function subscribeOperation(listener: () => void) {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

function useOperationSnapshot() {
  return useSyncExternalStore(
    subscribeOperation,
    () => operationSnapshot,
    () => null
  );
}

type OperationDirectory = {
  operations: OperationReadModel[];
  selectedOperationId: string | null;
  selectOperation: (operationId: string) => void;
  refreshOperations: () => Promise<void>;
};

function useOperationDirectory(): OperationDirectory {
  const [operations, setOperations] = useState<OperationReadModel[]>([]);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null
  );
  const selectedRef = useRef<string | null>(null);

  const selectOperation = (operationId: string) => {
    selectedRef.current = operationId;
    setSelectedOperationId(operationId);
    const selected = operations.find((item) => item.id === operationId);
    if (selected) publishOperation(selected);
  };

  const refreshOperations = async () => {
    try {
      const response = await fetchOperationalRead("/api/operations");
      if (!response.ok) return;
      const payload = await response.json();
      if (!Array.isArray(payload)) return;
      const next = payload as OperationReadModel[];
      setOperations(next);
      const selected =
        next.find((item) => item.id === selectedRef.current) ?? next[0];
      if (selected) {
        selectedRef.current = selected.id;
        setSelectedOperationId(selected.id);
        publishOperation(selected);
      }
    } catch {
      // Individual views still retain their last read if the index is stale.
    }
  };

  useEffect(() => {
    void refreshOperations();
    if (typeof EventSource === "undefined") return;
    const events = new EventSource("/api/events");
    const sync = () => void refreshOperations();
    [
      "mandate.created",
      "call.started",
      "call.updated",
      "quote.registered",
      "deal.reviewed",
      "selection.created",
      "confirmation.failed",
      "commitment.finalized"
    ].forEach((name) => events.addEventListener(name, sync));
    return () => events.close();
  }, []);

  return {
    operations,
    selectedOperationId,
    selectOperation,
    refreshOperations
  };
}

function useLiveOperation(operationId?: string | null) {
  const [operation, setOperation] = useState<OperationReadModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOperation(null);
    const refresh = async () => {
      try {
        const endpoint = operationId
          ? `/api/operations/${encodeURIComponent(operationId)}`
          : "/api/operation";
        const response = await fetchOperationalRead(endpoint);
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as OperationReadModel;
        if (cancelled) return;
        setOperation(next);
        publishOperation(next);
      } catch {
        // The console keeps the last known state; the strip shows it is stale.
      }
    };

    void refresh();
    if (typeof EventSource === "undefined")
      return () => {
        cancelled = true;
      };

    const events = new EventSource("/api/events");
    const sync = () => void refresh();
    [
      "mandate.created",
      "call.started",
      "call.updated",
      "quote.registered",
      "deal.reviewed",
      "selection.created",
      "confirmation.failed",
      "commitment.finalized",
      "call.supervision.changed"
    ].forEach((name) => events.addEventListener(name, sync));
    return () => {
      cancelled = true;
      events.close();
    };
  }, [operationId]);

  return operation;
}

function NotificationsView({
  directory,
  onOpenMandate
}: {
  directory: OperationDirectory;
  onOpenMandate: (operationId: string, view: View) => void;
}) {
  const [events, setEvents] = useState<ShipmentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/shipment-events");
        if (!response.ok) throw new Error("notifications_unavailable");
        const next = (await response.json()) as ShipmentEvent[];
        if (!cancelled) {
          setEvents(next);
          setError(null);
        }
      } catch {
        if (!cancelled)
          setError("Notifications are unavailable. Retry in a moment.");
      }
    };
    void refresh();
    if (typeof EventSource === "undefined")
      return () => {
        cancelled = true;
      };
    const source = new EventSource("/api/events");
    source.addEventListener("shipment.event.created", () => void refresh());
    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  return (
    <>
      <PageHead
        title="Notifications"
        eyebrow="Operational feed"
        description="Live Volta updates across every shipment in your organization."
        action={<Tag tone="signal">{events.length} events</Tag>}
      />
      <MandateDeck
        label="Mandates with activity"
        onSelect={(operationId) => onOpenMandate(operationId, "notifications")}
        operations={directory.operations.filter((operation) =>
          events.some((event) => event.operationId === operation.id)
        )}
        selectedOperationId={directory.selectedOperationId}
      />
      <section className="card">
        <div className="card__head">
          <h2>Latest activity</h2>
        </div>
        {error ? (
          <div className="card__body">
            <p className="form-error" role="alert">
              {error}
            </p>
          </div>
        ) : null}
        {!error && events.length === 0 ? (
          <div className="card__body">
            <p className="stat__note">No operational notifications yet.</p>
          </div>
        ) : null}
        {events.length > 0 ? (
          <div className="ledger">
            {events.map((event) => {
              const operation = directory.operations.find(
                (item) => item.id === event.operationId
              );
              return (
                <details className="ledger__row" key={event.id}>
                  <summary>
                    <span className="ledger__cell">
                      <span className="section-head__mark">
                        <AlertIcon />
                      </span>
                      <b>{event.label}</b>
                    </span>
                    <span className="ledger__cell">
                      <span className="ml">
                        Mandate {mandateReference(event.operationId)}
                      </span>
                      <span className="ledger__value">
                        {operation
                          ? operationLabel(operation)
                          : event.operationId}
                      </span>
                    </span>
                    <span className="ledger__figure">
                      {formatDraftStamp(event.occurredAt)}
                    </span>
                    <ChevronIcon className="ledger__chev" />
                  </summary>
                  <div className="card__body notification__details">
                    {event.metadata &&
                    Object.keys(event.metadata).length > 0 ? (
                      <div>
                        {Object.entries(event.metadata).map(([key, value]) => (
                          <p key={key}>
                            <span className="ml">{titleCase(key)}</span>{" "}
                            {Array.isArray(value)
                              ? value.join(", ")
                              : String(value)}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <p className="stat__note">
                        No additional event metadata.
                      </p>
                    )}
                    <button
                      className="btn btn--secondary"
                      onClick={() =>
                        onOpenMandate(event.operationId, "pipeline")
                      }
                      type="button"
                    >
                      Open mandate <ArrowIcon />
                    </button>
                  </div>
                </details>
              );
            })}
          </div>
        ) : null}
      </section>
    </>
  );
}

/** Re-render once a second, but only while something is actually running. */
function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}

/* ------------------------------------------------------------ helpers ---- */

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

function formatDraftStamp(value?: string) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(parsed);
}

function titleCase(value?: string) {
  if (!value) return "—";
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function callDuration(session: CallSession): string {
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt ?? new Date().toISOString());
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function callTone(status: CallSession["status"]): Tone {
  if (status === "completed") return "commit";
  if (status === "failed") return "halt";
  if (status === "pending") return "brass";
  return "signal";
}

function isLiveCall(session: CallSession) {
  return session.status === "in_progress";
}

function bestQuote(quotes: Quote[]): Quote | undefined {
  return quotes
    .slice()
    .sort((left, right) => left.priceMxn - right.priceMxn)[0];
}

function mandateReference(operationId: string) {
  const reference = operationId.replace(/^operation-(?:mandate-)?/, "");
  return reference.length > 16
    ? `${reference.slice(0, 8)}…${reference.slice(-4)}`
    : reference;
}

function operationLabel(operation: Operation) {
  return `${operation.origin} → ${operation.destination}`;
}

/* --------------------------------------------------------- primitives ---- */

function Tag({ children, tone }: { children: React.ReactNode; tone: Tone }) {
  return <span className={`tag tag--${tone}`}>{children}</span>;
}

function Waveform({ live }: { live: boolean }) {
  return (
    <div className="wave" data-live={live} aria-hidden>
      {Array.from({ length: 22 }, (_, index) => (
        <i key={index} style={{ "--i": index } as React.CSSProperties} />
      ))}
    </div>
  );
}

function PageHead({
  title,
  description,
  eyebrow,
  action
}: {
  title: string;
  description: string;
  eyebrow: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <p className="kicker">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-head__lede">{description}</p>
      </div>
      {action}
    </header>
  );
}

function Stat({
  label,
  value,
  note,
  tone
}: {
  label: string;
  value: string;
  note: string;
  tone?: Tone;
}) {
  return (
    <div className={tone ? `stat stat--${tone}` : "stat"}>
      <p className="ml">{label}</p>
      <span className="stat__value">{value}</span>
      <p className="stat__note">{note}</p>
    </div>
  );
}

function EmptyState({
  mark,
  eyebrow,
  title,
  body,
  tone,
  action
}: {
  mark: React.ReactNode;
  eyebrow: string;
  title: string;
  body?: string;
  tone?: "commit" | "brass" | "halt";
  action?: React.ReactNode;
}) {
  return (
    <section className={tone ? `card empty empty--${tone}` : "card empty"}>
      <span className="empty__mark">{mark}</span>
      <p className="ml">{eyebrow}</p>
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {action}
    </section>
  );
}

function MandateDeck({
  operations,
  selectedOperationId,
  onSelect,
  label = "Mandate executions"
}: {
  operations: OperationReadModel[];
  selectedOperationId: string | null;
  onSelect: (operationId: string) => void;
  label?: string;
}) {
  if (operations.length === 0) return null;
  return (
    <section className="mandate-deck" aria-label={label}>
      <div className="mandate-deck__head">
        <span className="ml">{label}</span>
        <span className="mandate-deck__count">
          {operations.length} {operations.length === 1 ? "mandate" : "mandates"}
        </span>
      </div>
      <div className="mandate-deck__rail">
        {operations.map((operation) => {
          const live = operation.callSessions.filter(isLiveCall).length;
          const waiting =
            operation.status === "awaiting_client_selection"
              ? operation.reviewedDeals.filter(
                  (deal) => deal.mandateDecision === "APPROVED"
                ).length
              : 0;
          return (
            <button
              aria-pressed={selectedOperationId === operation.id}
              className="mandate-ticket"
              data-selected={selectedOperationId === operation.id}
              key={operation.id}
              onClick={() => onSelect(operation.id)}
              type="button"
            >
              <span className="mandate-ticket__top">
                <span className="mandate-ticket__ref">
                  MANDATE {mandateReference(operation.id)}
                </span>
                <Tag
                  tone={
                    operation.pipelineStage === "failed"
                      ? "halt"
                      : waiting > 0
                        ? "brass"
                        : live > 0
                          ? "signal"
                          : operation.pipelineStage === "committed"
                            ? "commit"
                            : "idle"
                  }
                >
                  {operation.pipelineStage.replace(/_/g, " ")}
                </Tag>
              </span>
              <b>{operationLabel(operation)}</b>
              <span className="mandate-ticket__meta">
                {formatMxn(operation.mandate.budgetCapMxn)} cap
                <i />
                {operation.callSessions.length} calls
                {waiting > 0 ? ` · ${waiting} waiting` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- shell ---- */

function ThemeToggle() {
  // Dark is the console's ground, matching the public surface. This mirrors
  // the CSS exactly: light wins only on an explicit choice or an explicit
  // system preference for light. "No preference" stays dark.
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem("volta-theme");
    } catch {
      stored = null;
    }
    if (stored === "dark" || stored === "light") {
      setTheme(stored);
      return;
    }
    const prefersLight =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: light)").matches;
    setTheme(prefersLight ? "light" : "dark");
  }, []);

  function apply(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem("volta-theme", next);
    } catch {
      // A blocked store only costs the preference on the next visit.
    }
  }

  return (
    <button
      aria-label={theme === "dark" ? "Use light theme" : "Use dark theme"}
      className="rail__theme"
      onClick={() => apply(theme === "dark" ? "light" : "dark")}
      type="button"
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function ConsoleStrip({ directory }: { directory: OperationDirectory }) {
  const operation = useOperationSnapshot();
  const liveLines = operation?.liveLines ?? 0;
  const waiting = operation?.waiting ?? 0;

  return (
    <div className="console" aria-label="Operation status">
      <span
        className={
          liveLines > 0 ? "console__item console__item--live" : "console__item"
        }
      >
        {liveLines > 0 && <i className="pulse" />}
        <b>{liveLines}</b> {liveLines === 1 ? "line open" : "lines open"}
      </span>
      <span
        className={
          waiting > 0 ? "console__item console__item--wait" : "console__item"
        }
      >
        <b>{waiting}</b> waiting on you
      </span>
      {operation ? (
        <>
          <label className="console__item console__switcher">
            <span>MANDATE</span>
            <select
              aria-label="Active mandate"
              onChange={(event) =>
                directory.selectOperation(event.target.value)
              }
              value={directory.selectedOperationId ?? operation.id}
            >
              {directory.operations.length === 0 ? (
                <option value={operation.id}>
                  {mandateReference(operation.id)}
                </option>
              ) : (
                directory.operations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {mandateReference(item.id)} · {item.origin} →{" "}
                    {item.destination}
                  </option>
                ))
              )}
            </select>
            <span className="console__operation-id">{operation.id}</span>
          </label>
          <span className="console__item">
            {operation.origin} → {operation.destination}
          </span>
          {operation.stage && (
            <span className="console__item">
              stage <b>{operation.stage.replace(/_/g, " ")}</b>
            </span>
          )}
        </>
      ) : (
        <span className="console__item">no operation loaded</span>
      )}
    </div>
  );
}

/* ------------------------------------------------------- new mandate ----- */

function NewMandateView({
  onCreated
}: {
  onCreated: (operationId: string) => void;
}) {
  const [saveState, setSaveState] = useState<MandateSaveState>({
    status: "idle"
  });
  const [draft, setDraft] = useState<Record<string, string>>({});

  function captureDraft(form: HTMLFormElement) {
    const data = new FormData(form);
    const next: Record<string, string> = {};
    data.forEach((value, key) => {
      next[key] = typeof value === "string" ? value : "";
    });
    setDraft(next);
  }

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
    if (
      Date.parse(mandate.pickup_datetime) >=
      Date.parse(mandate.destination_datetime)
    ) {
      throw new Error(
        "Pickup date & time must be before the destination date & time."
      );
    }

    const response = await fetch("/api/mandates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mandate)
    });

    if (!response.ok) {
      // The backend already says exactly what was wrong; a generic message
      // here just hides it and turns every failure into a guessing game.
      throw new Error(await mandateErrorMessage(response));
    }

    const operation = (await response.json()) as { id: string };
    setSaveState({ status: "saved", operationId: operation.id });
  }

  const budget = Number(draft.budget_cap);
  const weight = Number(draft.weight);
  const datesOutOfOrder =
    Boolean(draft.pickup_datetime) &&
    Boolean(draft.destination_datetime) &&
    draft.pickup_datetime >= draft.destination_datetime;

  return (
    <>
      <PageHead
        title="New mandate"
        eyebrow="Create operation"
        description="Define the boundaries Volta must obey before it speaks to a carrier."
      />
      <form
        className="mandate"
        onChange={(event) => captureDraft(event.currentTarget)}
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
        <div className="mandate__col">
          <section className="card">
            <div className="card__body">
              <div className="section-head">
                <span className="section-head__mark">
                  <BoxIcon />
                </span>
                <div>
                  <h2>Cargo manifest</h2>
                  <p>The physical load the carrier must be able to move.</p>
                </div>
              </div>
              <div className="fields">
                <label>
                  Type of content
                  <select name="type_of_content" defaultValue="" required>
                    <option value="" disabled>
                      Select content type
                    </option>
                    <option value="textiles">Textiles</option>
                    <option value="general-cargo">General cargo</option>
                    <option value="food-grade">Food-grade cargo</option>
                    <option value="hazardous-material">
                      Hazardous material
                    </option>
                  </select>
                </label>
                <label>
                  Weight
                  <div className="affix affix--trail">
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
                  <input
                    className="mono"
                    name="measures"
                    placeholder="120 × 100 × 110 cm"
                    required
                  />
                </label>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__body">
              <div className="section-head">
                <span className="section-head__mark">
                  <RouteIcon />
                </span>
                <div>
                  <h2>Route &amp; binding limit</h2>
                  <p>Where, when, and how far Volta is authorized to go.</p>
                </div>
              </div>
              <div className="fields">
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
                {datesOutOfOrder && (
                  <p className="form-error span-2" role="alert">
                    Pickup must be before destination.
                  </p>
                )}
                <label className="span-2">
                  Destination place
                  <input name="destination_place" required />
                </label>
                <label className="span-2">
                  Budget cap
                  <div className="affix affix--lead">
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
              <div className="note note--brass" style={{ marginTop: 20 }}>
                <ApprovalIcon />
                <div>
                  <b>This mandate is binding</b>
                  <p>
                    The agent cannot exceed the authorized budget or change
                    either datetime without human approval.
                  </p>
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside className="card mandate__aside">
          <div className="card__body">
            <p className="ml">Mandate preview</p>
            <h2 style={{ margin: "8px 0 20px", fontSize: 19 }}>
              Review before launch
            </h2>

            <div className="preview__budget">
              <p className="ml">Authorized ceiling</p>
              <span
                className="figure"
                data-empty={!(Number.isFinite(budget) && budget > 0)}
              >
                {Number.isFinite(budget) && budget > 0
                  ? formatMxn(budget)
                  : "—"}
              </span>
              <p className="stat__note">
                Volta may not agree to a peso above this.
              </p>
            </div>

            <div className="preview__route">
              <div className="preview__stop">
                <i aria-hidden />
                <b>{draft.pickup_address || "Pickup address"}</b>
                <span>{formatDraftStamp(draft.pickup_datetime)}</span>
              </div>
              <div className="preview__stop preview__stop--end">
                <i aria-hidden />
                <b>{draft.destination_place || "Destination place"}</b>
                <span>{formatDraftStamp(draft.destination_datetime)}</span>
              </div>
            </div>

            <dl className="spec">
              <div>
                <dt>Content</dt>
                <dd>{titleCase(draft.type_of_content)}</dd>
              </div>
              <div>
                <dt>Weight</dt>
                <dd>
                  {Number.isFinite(weight) && weight > 0
                    ? `${weight.toLocaleString("en-MX")} kg`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>Measures</dt>
                <dd>{draft.measures || "—"}</dd>
              </div>
            </dl>

            {saveState.status === "saved" ? (
              <div className="saved">
                <i /> Mandate {saveState.operationId} created
              </div>
            ) : (
              <m.button
                className="btn btn--primary btn--block"
                type="submit"
                disabled={saveState.status === "saving"}
                whileTap={{ scale: 0.985 }}
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
                className="btn btn--secondary btn--block"
                type="button"
                onClick={() => onCreated(saveState.operationId)}
                whileTap={{ scale: 0.985 }}
              >
                Open operation
              </m.button>
            )}
          </div>

          <TestingCarriers />
        </aside>
      </form>
    </>
  );
}

/**
 * Which numbers a mandate will actually ring, editable right where the
 * mandate is launched. Rehearsals change the pool constantly, and walking to
 * another screen to check who is about to be phoned is how a round surprises
 * the room.
 */
/**
 * Room tuning for the calls placed next. A phone on speaker hears the agent's
 * own voice and the room, so it interrupts itself constantly; a handset at
 * someone's ear needs the opposite. Sitting next to the launch button because
 * that is when you know which one you are about to use.
 */
function TurnTuning() {
  const [applied, setApplied] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = async (preset: "speakerphone" | "handset") => {
    setBusy(true);
    try {
      const response = await fetch("/api/telephony/tuning", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset })
      });
      if (response.ok) setApplied(preset);
    } catch {
      setApplied(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tuning">
      <span className="tuning__label">Interruption sensitivity</span>
      <div className="tuning__options">
        <button
          className={
            applied === "speakerphone"
              ? "btn btn--primary"
              : "btn btn--secondary"
          }
          type="button"
          disabled={busy}
          onClick={() => void apply("speakerphone")}
        >
          Speakerphone
        </button>
        <button
          className={
            applied === "handset" ? "btn btn--primary" : "btn btn--secondary"
          }
          type="button"
          disabled={busy}
          onClick={() => void apply("handset")}
        >
          Handset
        </button>
      </div>
      <p className="tuning__hint">
        Speakerphone makes Volta much harder to interrupt — use it when the
        phone is on a table. Applies to the next call, not one already running.
      </p>
    </div>
  );
}

function TestingCarriers() {
  const [carriers, setCarriers] = useState<CarrierRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const response = await fetchOperationalRead("/api/carriers");
      if (response.ok) setCarriers((await response.json()) as CarrierRow[]);
    } catch {
      setError("The carrier directory is unavailable.");
    }
  };

  // Loaded when the panel is opened, not on mount: the mandate screen should
  // not fetch a directory nobody asked to see.
  const [loaded, setLoaded] = useState(false);

  const toggle = async (carrier: CarrierRow) => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/carriers/${encodeURIComponent(carrier.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !carrier.active })
      });
      await refresh();
    } catch {
      setError("Could not update that carrier.");
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const phone = phoneRef.current?.value.trim() ?? "";
    if (!phone) return;

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/carriers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: `carrier-${phone.replace(/\D/g, "")}`,
          name: nameRef.current?.value.trim() || phone,
          phone,
          lanes: [],
          active: true
        })
      });
      if (!response.ok) throw new Error("create_failed");
      if (phoneRef.current) phoneRef.current.value = "";
      if (nameRef.current) nameRef.current.value = "";
      await refresh();
    } catch {
      setError("Could not add that number.");
    } finally {
      setBusy(false);
    }
  };

  const active = carriers.filter((carrier) => carrier.active);

  return (
    <details
      className="testing"
      onToggle={(event) => {
        if (event.currentTarget.open && !loaded) {
          setLoaded(true);
          void refresh();
        }
      }}
    >
      <summary>
        <span>Testing · numbers this mandate will call</span>
        <Tag tone={active.length > 0 ? "commit" : "halt"}>
          {active.length} active
        </Tag>
      </summary>

      <div className="testing__body">
        <p className="testing__hint">
          Launching a mandate dials every active number below, at once and for
          real. Uncheck a carrier to leave it out of the round.
        </p>

        <ul className="testing__list">
          {carriers.map((carrier) => (
            <li key={carrier.id}>
              <label>
                <input
                  type="checkbox"
                  checked={carrier.active}
                  disabled={busy}
                  onChange={() => void toggle(carrier)}
                />
                <span className="testing__phone">{carrier.phone}</span>
                <span className="testing__name">{carrier.name}</span>
              </label>
            </li>
          ))}
          {carriers.length === 0 && (
            <li className="testing__empty">
              No carriers registered yet. Add a number below.
            </li>
          )}
        </ul>

        <TurnTuning />

        {/* Not a form: this panel lives inside the mandate form, and a nested
            form is invalid and would submit the mandate on Enter. */}
        <div className="testing__add">
          <input ref={phoneRef} placeholder="+573001112233" type="tel" />
          <input ref={nameRef} placeholder="Carrier name (optional)" />
          <button
            className="btn btn--secondary"
            type="button"
            onClick={() => void add()}
            disabled={busy}
          >
            Add
          </button>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  );
}

const MANDATE_ERROR_MESSAGE: Record<string, string> = {
  invalid_mandate:
    "Check every field: pickup date & time must be before the destination date & time, and none can be empty.",
  mandate_persistence_failed:
    "Volta could not save this mandate right now — try again in a moment.",
  authentication_required:
    "Your session is not authenticated with the dispatch API."
};

async function mandateErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) {
      return (
        MANDATE_ERROR_MESSAGE[body.error] ??
        `Volta could not save this mandate (${body.error}).`
      );
    }
  } catch {
    // Body was not JSON; fall through to the status-based message.
  }
  return `Volta could not save this mandate (HTTP ${response.status}).`;
}

function toOffsetDatetime(value: FormDataEntryValue | null): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A mandate datetime is required.");
  }

  return `${value}:00${MANDATE_TIMEZONE_OFFSET}`;
}

/* ---------------------------------------------------------- call floor ---- */

/**
 * Transcript arrives one utterance at a time over SSE and is appended, not
 * refetched: a floor that reloads the whole transcript on every line scrolls
 * out from under whoever is reading it.
 */
function useLiveTranscript() {
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/transcript");
        if (!response.ok || cancelled) return;
        setSegments((await response.json()) as TranscriptSegment[]);
      } catch {
        // The floor still renders; the line simply stays empty.
      }
    })();

    if (typeof EventSource === "undefined")
      return () => {
        cancelled = true;
      };

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
    return () => {
      cancelled = true;
      events.close();
    };
  }, []);

  return segments;
}

const SUPERVISION_LABEL: Record<CallSupervisionState, string> = {
  agent: "Volta speaking",
  awaiting_human: "Volta needs you",
  postponed: "Nobody joined · call closed",
  briefing_supervisor: "Ringing your phone…",
  human: "You are on the line",
  returned_to_agent: "Handed back"
};

function supervisionTone(state: CallSupervisionState): Tone {
  if (state === "awaiting_human") return "halt";
  if (state === "postponed") return "idle";
  if (state === "human") return "brass";
  if (state === "briefing_supervisor") return "signal";
  return "idle";
}

const CALL_CONTROL_ERROR: Record<string, string> = {
  call_session_not_found: "Volta no longer has this call on the floor.",
  takeover_window_closed: "That offer already expired.",
  supervisor_unreachable:
    "Volta could not ring your phone. Check SUPERVISOR_PHONE and the Twilio logs."
};

/**
 * Every one of these can fail, and the failure has to be visible: fired and
 * forgotten, a rejected takeover looked exactly like a working one and the
 * button read as dead.
 */
async function callControl(callSid: string, action: string): Promise<void> {
  const response = await fetch(
    `/api/calls/${encodeURIComponent(callSid)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator_requested" })
    }
  );
  if (response.ok) return;

  let code: string | undefined;
  try {
    code = ((await response.json()) as { error?: string }).error;
  } catch {
    // Body was not JSON; the status is all we have to go on.
  }
  throw new Error(
    (code ? CALL_CONTROL_ERROR[code] : undefined) ??
      `Volta could not do that (${code ?? response.status}).`
  );
}

function CallTranscript({ segments }: { segments: TranscriptSegment[] }) {
  const tail = useRef<HTMLOListElement>(null);
  useEffect(() => {
    tail.current?.scrollTo({ top: tail.current.scrollHeight });
  }, [segments.length]);

  if (segments.length === 0) {
    return <p className="call__transcript-empty">Listening…</p>;
  }

  return (
    <ol className="call__transcript" ref={tail}>
      {segments.map((segment) => (
        <li key={segment.id} data-speaker={segment.speaker}>
          <span className="call__speaker">
            {segment.speaker === "agent" ? "Volta" : "Carrier"}
          </span>
          <span>{segment.text}</span>
          <time>{Math.floor(segment.startMs / 1000)}s</time>
        </li>
      ))}
    </ol>
  );
}

/**
 * Handing a live call to a person never drops the agent leg: taking over rings
 * your phone and the server routes the audio when you pick up, so Volta keeps
 * talking instead of leaving the carrier in silence while it rings.
 */
function CallHandover({ session }: { session: CallSession }) {
  const state: CallSupervisionState = session.supervision?.state ?? "agent";
  const callSid = session.callSid ?? session.id;
  const deadline = session.supervision?.deadlineAt;
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: string) => {
    setBusy(true);
    setError(null);
    try {
      await callControl(callSid, action);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "Volta could not do that. Try again."
      );
    } finally {
      setBusy(false);
    }
  };

  // The offer expires, so the console has to show time running out rather than
  // a button that silently stops working.
  useEffect(() => {
    if (state !== "awaiting_human" || !deadline) {
      setRemaining(null);
      return;
    }
    const tick = () =>
      setRemaining(
        Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 1000))
      );
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [state, deadline]);

  if (state === "awaiting_human") {
    return (
      <div className="call__handover call__handover--urgent">
        <Tag tone="halt">
          <i className="pulse" />
          Volta needs you{remaining !== null ? ` · ${remaining}s` : ""}
        </Tag>
        <button
          className="btn btn--primary"
          disabled={busy}
          onClick={() => void run("accept")}
          type="button"
        >
          Join the call
        </button>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="call__handover">
      <Tag tone={supervisionTone(state)}>{SUPERVISION_LABEL[state]}</Tag>
      {state === "human" ? (
        <button
          className="btn btn--secondary"
          disabled={busy}
          onClick={() => void run("handback")}
          type="button"
        >
          Hand back to Volta
        </button>
      ) : state === "briefing_supervisor" ? (
        // Answering the phone moves the floor on its own. This is the override
        // for a supervisor leg that rang but never joined the audio.
        <button
          className="btn btn--secondary"
          disabled={busy}
          onClick={() => void run("connect")}
          type="button"
        >
          Take the floor now
        </button>
      ) : (
        <button
          className="btn btn--secondary"
          disabled={busy}
          onClick={() => void run("takeover")}
          type="button"
        >
          {busy ? "Ringing you…" : "Take over"}
        </button>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function CallFloorView({
  onNavigate,
  directory
}: {
  onNavigate: (view: View) => void;
  directory: OperationDirectory;
}) {
  const operation = useLiveOperation(directory.selectedOperationId);
  const transcript = useLiveTranscript();
  const sessions = operation?.callSessions ?? [];
  const liveLines = sessions.filter(isLiveCall);
  useTicker(liveLines.length > 0);

  const quotes = operation?.quotes ?? [];
  const best = bestQuote(quotes);
  const cap = operation?.mandate.budgetCapMxn;
  const headroom = cap && best ? cap - best.priceMxn : undefined;

  return (
    <>
      <PageHead
        title="Call floor"
        eyebrow="Live negotiation"
        description="Every carrier leg is visible from dial through quote and outcome."
        action={
          liveLines.length > 0 ? (
            <Tag tone="signal">
              <i className="pulse" />
              {liveLines.length} on the line
            </Tag>
          ) : undefined
        }
      />

      <MandateDeck
        label="Call groups by mandate"
        onSelect={directory.selectOperation}
        operations={directory.operations.filter(
          (item) => item.callSessions.length > 0
        )}
        selectedOperationId={directory.selectedOperationId}
      />

      {sessions.length > 0 && (
        <div className="stats">
          <Stat
            label="Lines open"
            value={String(liveLines.length)}
            note={`${sessions.length} carriers dialed`}
            tone={liveLines.length > 0 ? "signal" : undefined}
          />
          <Stat
            label="Quotes in"
            value={String(quotes.length)}
            note="Market intelligence, not bookings"
          />
          <Stat
            label="Best rate"
            value={best ? formatMxn(best.priceMxn) : "—"}
            note={
              best
                ? `${best.carrierName} · ${best.etaMinutes} min ETA`
                : "Awaiting the first quote"
            }
            tone={best ? "commit" : undefined}
          />
          <Stat
            label="Budget headroom"
            value={headroom === undefined ? "—" : formatMxn(headroom)}
            note={cap ? `Cap ${formatMxn(cap)}` : "No mandate cap loaded"}
          />
        </div>
      )}

      <section className="calls">
        {sessions.map((session) => {
          const quote = quotes.find(
            (item) => item.id === session.quoteId || item.callId === session.id
          );
          const live = isLiveCall(session);
          const carrier =
            session.driverName ??
            operation?.candidates.find((item) => item.id === session.carrierId)
              ?.name ??
            "Carrier";

          return (
            <article
              className={live ? "card call call--live" : "card call"}
              key={session.id}
            >
              <div className="call__head">
                <Tag tone={callTone(session.status)}>
                  {live && <i className="pulse" />}
                  {session.status.replace(/_/g, " ")}
                </Tag>
                <span className="call__timer">
                  <ClockIcon /> {callDuration(session)}
                </span>
              </div>
              <div>
                <p className="call__ref">{session.callSid ?? session.id}</p>
                <h2>{carrier}</h2>
              </div>
              <p className="call__route">
                <RouteIcon /> Mandate {mandateReference(session.operationId)} ·{" "}
                {operation?.origin} → {operation?.destination}
              </p>
              <Waveform live={live} />

              <CallTranscript
                segments={transcript.filter(
                  (segment) =>
                    segment.callId === session.callSid ||
                    segment.callId === session.id
                )}
              />

              <div className="call__foot">
                {quote ? (
                  <>
                    <span className="call__price">
                      {formatMxn(quote.priceMxn)}
                    </span>
                    <span className="call__eta">
                      {quote.etaMinutes} MIN ETA
                    </span>
                  </>
                ) : (
                  <span className="call__pending">
                    {session.endedReason ?? "Awaiting quote"}
                  </span>
                )}
              </div>

              {/* Handover only means anything while the line is still open. */}
              {live && <CallHandover session={session} />}
            </article>
          );
        })}
      </section>

      {sessions.length === 0 && (
        <EmptyState
          mark={<PhoneIcon />}
          eyebrow="No active calls"
          title="Launch a mandate to open the carrier floor."
          body="Volta dials the active carrier pool as soon as an operation has a binding budget and schedule."
          action={
            <button
              className="btn btn--primary"
              onClick={() => onNavigate("new-mandate")}
              type="button"
            >
              Create a mandate <ArrowIcon />
            </button>
          }
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------ pipeline ---- */

const PIPELINE_STEPS: Array<{ id: PipelineStage; label: string }> = [
  { id: "open", label: "Mandate open" },
  { id: "calling", label: "Calling carriers" },
  { id: "quoting", label: "Quotes in" },
  { id: "awaiting_approval", label: "Waiting on you" },
  { id: "closing", label: "Closing call" },
  { id: "committed", label: "Booked" }
];

function PipelineView({
  onNavigate,
  directory
}: {
  onNavigate: (view: View) => void;
  directory: OperationDirectory;
}) {
  const operation = useLiveOperation(directory.selectedOperationId);
  const [extractions, setExtractions] = useState<QuoteExtraction[]>([]);
  useEffect(() => {
    void fetch("/api/quote-extractions")
      .then((response) => (response.ok ? response.json() : []))
      .then((items: QuoteExtraction[]) => setExtractions(items))
      .catch(() => setExtractions([]));
  }, []);
  const sessions = operation?.callSessions ?? [];
  useTicker(sessions.some(isLiveCall));

  if (!operation) {
    return (
      <>
        <PageHead
          title="Pipeline"
          eyebrow="Operation progress"
          description="Persisted stages and live call outcomes for the active operation."
        />
        <EmptyState
          mark={<OperationsIcon />}
          eyebrow="No operation loaded"
          title="Nothing is moving through the pipeline yet."
          body="Create a mandate and Volta will record every stage from dial to booking."
          action={
            <button
              className="btn btn--primary"
              onClick={() => onNavigate("new-mandate")}
              type="button"
            >
              Create a mandate <ArrowIcon />
            </button>
          }
        />
      </>
    );
  }

  const stage = operation.pipelineStage;
  const halted = stage === "escalated" || stage === "failed";
  const steps = halted
    ? [
        ...PIPELINE_STEPS.slice(0, 4),
        {
          id: stage,
          label: stage === "escalated" ? "Escalated to human" : "Failed"
        }
      ]
    : PIPELINE_STEPS;
  const currentIndex = halted
    ? steps.length - 1
    : Math.max(
        0,
        steps.findIndex((step) => step.id === stage)
      );

  const completed = sessions.filter(
    (item) => item.status === "completed"
  ).length;
  const best = bestQuote(operation.quotes);

  return (
    <>
      <PageHead
        title="Pipeline"
        eyebrow="Operation progress"
        description="Persisted stages and live call outcomes for the active operation."
        action={
          <Tag tone={halted ? "halt" : "signal"}>
            {stage.replace(/_/g, " ")}
          </Tag>
        }
      />

      <MandateDeck
        label="Pipeline by mandate"
        onSelect={directory.selectOperation}
        operations={directory.operations}
        selectedOperationId={directory.selectedOperationId}
      />

      <div className="stats">
        <Stat
          label="Calls completed"
          value={`${completed}/${sessions.length}`}
          note="Legs that reached an outcome"
        />
        <Stat
          label="Quotes on record"
          value={String(operation.quotes.length)}
          note="Each one linked to its call"
        />
        <Stat
          label="Best rate"
          value={best ? formatMxn(best.priceMxn) : "—"}
          note={best ? best.carrierName : "No quote yet"}
          tone={best ? "commit" : undefined}
        />
        <Stat
          label="Budget cap"
          value={formatMxn(operation.mandate.budgetCapMxn)}
          note="Authorized by the dispatcher"
        />
      </div>

      <section className="card">
        <div className="card__head">
          <div>
            <p className="ml">Stage</p>
            <h2>
              {operation.origin} → {operation.destination}
            </h2>
          </div>
          <span className="ledger__ref">
            MANDATE {mandateReference(operation.id)} · {operation.id}
          </span>
        </div>
        <div className="track">
          {steps.map((step, index) => (
            <div
              className="track__step"
              data-state={
                halted && index === steps.length - 1
                  ? "halted"
                  : index < currentIndex
                    ? "done"
                    : index === currentIndex
                      ? "current"
                      : "ahead"
              }
              key={step.id}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <b>{step.label}</b>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card__head">
          <h2>Call log</h2>
          <span className="ml">{sessions.length} legs</span>
        </div>
        {sessions.length > 0 ? (
          <div className="ledger">
            {sessions.map((session) => {
              const quote = operation.quotes.find(
                (item) =>
                  item.id === session.quoteId || item.callId === session.id
              );
              const extraction = extractions.find(
                (item) =>
                  item.callId === session.id || item.callId === session.callSid
              );
              return (
                <div className="ledger__row" key={session.id}>
                  <span className="ledger__cell">
                    <span className="ledger__ref">
                      {session.callSid ?? session.id}
                    </span>
                    <b>
                      {session.driverName ??
                        operation.candidates.find(
                          (item) => item.id === session.carrierId
                        )?.name ??
                        "Carrier"}
                    </b>
                  </span>
                  <span className="ledger__cell">
                    <span className="ml">Duration</span>
                    <span className="ledger__value mono">
                      {callDuration(session)}
                      {session.endedReason ? ` · ${session.endedReason}` : ""}
                    </span>
                  </span>
                  <Tag tone={callTone(session.status)}>
                    {isLiveCall(session) && <i className="pulse" />}
                    {session.status.replace(/_/g, " ")}
                  </Tag>
                  <span className="ledger__figure">
                    {extraction?.finalPriceMxn !== null &&
                    extraction?.finalPriceMxn !== undefined
                      ? `${formatMxn(extraction.finalPriceMxn)} · ${formatDraftStamp(extraction.agreedAt ?? undefined)}`
                      : quote
                        ? formatMxn(quote.priceMxn)
                        : "—"}
                  </span>
                  {extraction?.summary ? (
                    <span className="ml">{extraction.summary}</span>
                  ) : null}
                  <ChevronIcon className="ledger__chev" />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card__body">
            <p className="stat__note">
              No carrier has been dialed for this operation yet.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

/* ------------------------------------------------------------ carriers ---- */

type CarrierRow = {
  id: string;
  name: string;
  phone: string;
  lanes: string[];
  active: boolean;
};

function CarriersView({
  directory,
  onOpenMandate
}: {
  directory: OperationDirectory;
  onOpenMandate: (operationId: string, view: View) => void;
}) {
  const [carriers, setCarriers] = useState<CarrierRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const refresh = async () => {
    setIsRefreshing(true);
    try {
      const response = await fetchOperationalRead("/api/carriers");
      if (!response.ok) throw new Error("carrier_directory_unavailable");
      setCarriers((await response.json()) as CarrierRow[]);
      setError(null);
    } catch {
      setError("The carrier directory is unavailable. Retry in a moment.");
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const active = carriers.filter((carrier) => carrier.active).length;

  return (
    <>
      <PageHead
        title="Carriers"
        eyebrow="Network directory"
        description="Maintain the active carrier pool used for the next mandate fan-out."
        action={
          carriers.length > 0 ? (
            <Tag tone={active > 0 ? "commit" : "idle"}>
              {active} of {carriers.length} active
            </Tag>
          ) : undefined
        }
      />

      <MandateDeck
        label="Mandates using the carrier network"
        onSelect={(operationId) => onOpenMandate(operationId, "carriers")}
        operations={directory.operations.filter(
          (operation) => operation.candidates.length > 0
        )}
        selectedOperationId={directory.selectedOperationId}
      />

      <form
        className="card"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setError(null);
          try {
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
            if (!response.ok) throw new Error("carrier_rejected");
            form.reset();
            await refresh();
          } catch {
            setError(
              "Volta could not add this carrier. Check the phone number and try again."
            );
          }
        }}
      >
        <div className="card__body">
          <div className="section-head">
            <span className="section-head__mark">
              <PlusIcon />
            </span>
            <div>
              <h2>Add carrier</h2>
              <p>Only active carriers receive new call rounds.</p>
            </div>
          </div>
          <div className="fields">
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
          {error && (
            <div className="form-error form-error--recoverable" role="alert">
              <span>{error}</span>
              <button
                disabled={isRefreshing}
                onClick={() => void refresh()}
                type="button"
              >
                {isRefreshing ? "Retrying…" : "Retry"}
              </button>
            </div>
          )}
        </div>
        <div className="card__foot">
          <button className="btn btn--primary" type="submit">
            Add carrier <PlusIcon />
          </button>
        </div>
      </form>

      <section className="card">
        <div className="card__head">
          <h2>Carrier pool</h2>
          <span className="ml">{carriers.length} listed</span>
        </div>
        {carriers.length > 0 ? (
          <div className="ledger">
            {carriers.map((carrier) => {
              const mandates = directory.operations.filter(
                (operation) =>
                  operation.candidates.some((item) => item.id === carrier.id) ||
                  operation.callSessions.some(
                    (session) => session.carrierId === carrier.id
                  )
              );
              const calls = mandates.reduce(
                (total, operation) =>
                  total +
                  operation.callSessions.filter(
                    (session) => session.carrierId === carrier.id
                  ).length,
                0
              );
              return (
                <div className="ledger__row carrier-row" key={carrier.id}>
                  <span className="ledger__cell">
                    <span className="ledger__ref">{carrier.phone}</span>
                    <b>{carrier.name}</b>
                  </span>
                  <span className="ledger__cell">
                    <span className="ml">
                      {carrier.lanes.join(", ") || "All lanes"}
                    </span>
                    <span className="ledger__value">
                      {mandates.length > 0 ? (
                        <span className="carrier-mandates">
                          {mandates.map((operation) => (
                            <button
                              key={operation.id}
                              onClick={() =>
                                onOpenMandate(operation.id, "call-floor")
                              }
                              title={operationLabel(operation)}
                              type="button"
                            >
                              M {mandateReference(operation.id)}
                            </button>
                          ))}
                        </span>
                      ) : (
                        "No mandate calls yet"
                      )}
                    </span>
                  </span>
                  <Tag tone={carrier.active ? "commit" : "idle"}>
                    {carrier.active ? "active" : "inactive"}
                  </Tag>
                  <span className="ledger__figure">
                    {String(calls).padStart(2, "0")} calls
                  </span>
                  <RouteIcon className="ledger__chev" />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card__body">
            <p className="stat__note">
              No carriers yet. The first one you add becomes the first call of
              the next mandate.
            </p>
          </div>
        )}
      </section>
    </>
  );
}

/* --------------------------------------------------------------- entry ---- */

export function DashboardConsole() {
  const [view, setView] = useState<View>("new-mandate");
  const directory = useOperationDirectory();

  const liveLines = directory.operations.reduce(
    (total, operation) =>
      total + operation.callSessions.filter(isLiveCall).length,
    0
  );
  function openMandate(operationId: string, nextView: View) {
    directory.selectOperation(operationId);
    setView(nextView);
  }

  function badgeFor(id: View) {
    if (id === "call-floor" && liveLines > 0) {
      return (
        <span className="rail__count rail__count--signal">{liveLines}</span>
      );
    }
    return null;
  }

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig
        reducedMotion="user"
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <div className="shell">
          <aside className="rail">
            <div className="rail__brand">
              <span className="rail__mark">V/</span>
              <div>
                <b>Volta</b>
                <small>DISPATCH CONSOLE</small>
              </div>
            </div>
            <nav aria-label="Primary navigation">
              {navItems.map((item) => {
                const Icon = item.icon;
                return (
                  <m.button
                    key={item.id}
                    className={view === item.id ? "is-active" : ""}
                    aria-current={view === item.id ? "page" : undefined}
                    onClick={() => setView(item.id)}
                    whileTap={{ scale: 0.98 }}
                  >
                    <Icon />
                    <span>{item.label}</span>
                    {badgeFor(item.id)}
                  </m.button>
                );
              })}
            </nav>
            <div className="rail__foot">
              <span className="rail__avatar">OP</span>
              <div>
                <b>Operator</b>
                <small>Dispatcher</small>
              </div>
              <ThemeToggle />
            </div>
          </aside>
          <main className="stage">
            <ConsoleStrip directory={directory} />
            <div
              className={
                view === "volta"
                  ? "stage__body stage__body--brain"
                  : "stage__body"
              }
            >
              <AnimatePresence initial={false} mode="wait">
                <m.div
                  animate={{ opacity: 1, y: 0 }}
                  className="view"
                  exit={{ opacity: 0, y: -4 }}
                  initial={{ opacity: 0, y: 8 }}
                  key={view}
                >
                  {view === "volta" && (
                    <VoltaChat onOperationChange={publishOperation} />
                  )}
                  {view === "new-mandate" && (
                    <NewMandateView
                      onCreated={(operationId) => {
                        directory.selectOperation(operationId);
                        void directory.refreshOperations();
                        setView("call-floor");
                      }}
                    />
                  )}
                  {view === "call-floor" && (
                    <CallFloorView directory={directory} onNavigate={setView} />
                  )}
                  {view === "pipeline" && (
                    <PipelineView directory={directory} onNavigate={setView} />
                  )}
                  {view === "carriers" && (
                    <CarriersView
                      directory={directory}
                      onOpenMandate={openMandate}
                    />
                  )}
                  {view === "notifications" && (
                    <NotificationsView
                      directory={directory}
                      onOpenMandate={openMandate}
                    />
                  )}
                </m.div>
              </AnimatePresence>
            </div>
          </main>
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
