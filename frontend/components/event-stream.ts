/**
 * One EventSource for the whole console.
 *
 * Two things forced this to be shared rather than one stream per hook.
 *
 * A browser allows six connections per origin over HTTP/1.1, and the console
 * opened four streams — directory, live operation, notifications, transcript —
 * which left almost nothing for the fetches those same screens depend on. That
 * is a large part of why every screen felt slower the longer a session ran.
 *
 * And an EventSource only reconnects on its own when the connection drops
 * cleanly. A response that is not a well-formed `text/event-stream` — the proxy
 * answering an API restart with a 500 HTML page — is a fatal error to the
 * browser, and the console's live updates stayed dead until someone pressed
 * reload. That is what made a finished call sit at "in progress" forever.
 */

const ENDPOINT = "/api/events";
/** Backoff for a stream the browser will not retry for us. */
const RECONNECT_MIN_MS = 1_000;
/**
 * Capped low on purpose. This runs during live calls: half a minute without
 * the stream is a floor that visibly lags the conversation, and the retry
 * costs one request against an API that is either up or not.
 */
const RECONNECT_MAX_MS = 8_000;
/**
 * While the stream is down the console still has to move. Slower than SSE by
 * design: this is a safety net, not the transport.
 */
const FALLBACK_POLL_MS = 10_000;
/**
 * How long a connection has to survive before it counts as healthy.
 *
 * The proxy answers an unreachable API with a valid stream that ends at once,
 * which is what keeps EventSource retrying instead of giving up. Treating that
 * open as a success reset the backoff every time and turned reconnection into
 * a request-per-second loop, so a connection has to actually stay up — or
 * deliver something — before we believe it.
 */
const SETTLE_MS = 2_000;
/**
 * How often the supervisor checks that a stream is actually up.
 *
 * `onerror` is not a promise that we will be told: whether a browser reports a
 * server-closed stream as an error, retries it silently, or simply stops, is
 * not something this code can rely on — and one missed callback leaves the
 * console dark with no way back but a reload, which is the whole failure this
 * module exists to prevent. So the callbacks are treated as an optimisation
 * and this poll as the guarantee.
 */
const SUPERVISOR_MS = 5_000;

export type StreamListener = {
  /** Server event names this subscriber cares about. */
  names: readonly string[];
  /** One named event arrived. */
  onEvent: (type: string, data: unknown) => void;
  /**
   * Refetch from scratch. Called when the stream reconnects after a gap, and
   * on the fallback poll while it is down: events that happened during the gap
   * are gone, so the only honest answer is to read the current state again.
   */
  onResync?: () => void;
};

const listeners = new Set<StreamListener>();

let source: EventSource | undefined;
/** Names already wired on the current EventSource. */
let attached = new Set<string>();
let reconnectDelayMs = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
let supervisorTimer: ReturnType<typeof setInterval> | undefined;
/** True once a connection has failed, so a later open is a *re*connection. */
let recovering = false;

function resyncAll() {
  for (const listener of [...listeners]) listener.onResync?.();
}

/** This connection is real. Anything missed while it was down is refetched. */
function settle() {
  if (settleTimer !== undefined) {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  reconnectDelayMs = RECONNECT_MIN_MS;
  stopPolling();
  if (!recovering) return;
  recovering = false;
  resyncAll();
}

function dispatch(type: string, raw: string | undefined) {
  // An event arriving is the strongest possible proof the stream is healthy.
  if (settleTimer !== undefined) settle();

  let data: unknown;
  if (raw !== undefined) {
    try {
      data = JSON.parse(raw);
    } catch {
      // A frame we cannot read is still a signal that something changed.
      data = undefined;
    }
  }
  for (const listener of [...listeners]) {
    if (listener.names.includes(type)) listener.onEvent(type, data);
  }
}

function attach(stream: EventSource, name: string) {
  if (attached.has(name)) return;
  attached.add(name);
  stream.addEventListener(name, (event) =>
    dispatch(name, (event as MessageEvent<string>).data)
  );
}

function attachAll(stream: EventSource) {
  for (const listener of listeners) {
    for (const name of listener.names) attach(stream, name);
  }
}

function stopPolling() {
  if (pollTimer === undefined) return;
  clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling() {
  if (pollTimer !== undefined) return;
  pollTimer = setInterval(resyncAll, FALLBACK_POLL_MS);
}

/** EventSource.CLOSED; the constant is not available in every environment. */
const CLOSED = 2;

function superviseConnection() {
  if (listeners.size === 0) return;
  // A socket the browser has given up on looks exactly like no socket at all
  // as far as this module is concerned.
  if (source !== undefined && source.readyState === CLOSED) {
    recovering = true;
    teardown();
    startPolling();
  }
  if (source === undefined && reconnectTimer === undefined) connect();
}

function startSupervisor() {
  if (supervisorTimer !== undefined) return;
  supervisorTimer = setInterval(superviseConnection, SUPERVISOR_MS);
}

function stopSupervisor() {
  if (supervisorTimer === undefined) return;
  clearInterval(supervisorTimer);
  supervisorTimer = undefined;
}

function scheduleReconnect() {
  if (reconnectTimer !== undefined || listeners.size === 0) return;
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
}

function teardown() {
  if (settleTimer !== undefined) {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
  source?.close();
  source = undefined;
  attached = new Set();
}

function connect() {
  if (source !== undefined || listeners.size === 0) return;
  if (typeof EventSource === "undefined") return;

  const stream = new EventSource(ENDPOINT);
  source = stream;
  attachAll(stream);

  stream.onopen = () => {
    // Not trusted yet: see SETTLE_MS.
    settleTimer = setTimeout(settle, SETTLE_MS);
  };

  stream.onerror = () => {
    // The browser retries a dropped stream on its own, but never one that
    // failed on a bad response. Telling them apart is not possible from here,
    // so we always take over: closing and reopening ourselves is correct in
    // both cases and is the only behaviour that survives a 500.
    recovering = true;
    teardown();
    startPolling();
    scheduleReconnect();
  };
}

/**
 * Subscribes to server events. Returns an unsubscribe function; the underlying
 * stream opens with the first subscriber and closes with the last.
 */
export function subscribeToEvents(listener: StreamListener): () => void {
  listeners.add(listener);
  startSupervisor();
  if (source) {
    for (const name of listener.names) attach(source, name);
  } else {
    connect();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopSupervisor();
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    stopPolling();
    recovering = false;
    reconnectDelayMs = RECONNECT_MIN_MS;
    teardown();
  };
}

/** Test seam: drops the shared stream and every subscriber. */
export function resetEventStream(): void {
  listeners.clear();
  stopSupervisor();
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  stopPolling();
  recovering = false;
  reconnectDelayMs = RECONNECT_MIN_MS;
  teardown();
}
