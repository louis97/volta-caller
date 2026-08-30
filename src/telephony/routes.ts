import type { Server } from "node:http";

import express, { type Express } from "express";
import twilio from "twilio";
import { WebSocketServer, type WebSocket } from "ws";

import { executeToolCall } from "../agent/interpreter";
import { buildCallInstructions } from "../agent/prompt";
import { env } from "../config/env";
import type { OperationStore } from "../core/state";
import { auctionFromOperation, type Auction } from "./auction";
import { closeBridge, getBridge, openBridge } from "./hub";
import { fanOutCalls } from "./orchestrator";
import { attachMediaStreamRelay } from "./mediaStream";
import {
  callClockMs,
  createCallRegistry,
  type CallRegistry,
  type CallRuntime
} from "./registry";
import {
  createRealtimeSocket,
  toRelaySocket,
  type ClosableRelaySocket
} from "./sockets";
import {
  createInboundTwiML,
  createTwilioGateway,
  mapTwilioStatus,
  type TwilioCallClient
} from "./twilio";

export const MEDIA_STREAM_PATH = "/media-stream";
export const SUPERVISOR_STREAM_PATH = "/supervisor-stream";

function escapeXmlText(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;"
    };
    return entities[character]!;
  });
}

export type TelephonyDependencies = {
  store: OperationStore;
  organizationId?: string;
  dialled?: Map<string, { id: string; name: string }>;
  onCallSessionChanged?: (
    session: import("@volta/contracts").CallSession
  ) => void;
  /**
   * Durable home for an utterance. The store keeps transcript in memory for
   * the live floor; without this it dies with the process and the
   * transcript_segments table stays empty.
   */
  onTranscriptAppended?: (
    segment: import("@volta/contracts").TranscriptSegment
  ) => void;
  /**
   * The editable carrier directory. When it holds active carriers they are
   * who a round dials, which is what the console's directory screen already
   * promises.
   */
  listActiveCarriers?: () => Promise<
    Array<{ id: string; name: string; phone: string }>
  >;
  /** Durable transcript, so any instance can serve a call it did not handle. */
  listTranscript?: (
    callId?: string
  ) => Promise<Array<import("@volta/contracts").TranscriptSegment>>;
};

/**
 * The auction and the call registry are the shared context of a negotiation
 * round: every leg must read and write the same one, or a quote taken on one
 * call is invisible to the agent negotiating on another and get_leverage
 * silently returns nothing.
 *
 * Keyed by store rather than passed around, because the routes and the
 * WebSocket handler are wired separately and nothing at those call sites can
 * enforce that they were handed the same instance.
 */
export type TelephonyContext = {
  registry: CallRegistry;
  dialled: Map<string, { id: string; name: string }>;
  auction: Auction;
  /** Starts a fresh round; quotes from the previous one stop counting. */
  resetAuction(): void;
};

const contextsByStore = new WeakMap<OperationStore, TelephonyContext>();

export function telephonyContext(store: OperationStore): TelephonyContext {
  const existing = contextsByStore.get(store);
  if (existing) return existing;

  const context: TelephonyContext = {
    registry: createCallRegistry(),
    dialled: new Map(),
    auction: auctionFromOperation(store.getOperation()),
    resetAuction() {
      context.auction = auctionFromOperation(store.getOperation());
      context.dialled.clear();
    }
  };

  // Subscribed once per store, so a quote is recorded exactly once however
  // many calls are in flight.
  store.subscribe((event) => {
    if (event.type === "quote.registered")
      context.auction.recordQuote(event.quote);
  });

  contextsByStore.set(store, context);
  return context;
}

function getTwilioClient(): TwilioCallClient {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error("twilio_credentials_missing");
  }
  return twilio(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN
  ) as unknown as TwilioCallClient;
}

export function createLiveTelephonyGateway() {
  return createTwilioGateway({ client: getTwilioClient() });
}

/**
 * Every live call needs a CallSession, whatever opened it: the floor renders
 * from sessions, and a transcript whose call has no session is invisible.
 *
 * A round dialled through fanOutCalls already created one and stamped it with
 * the Twilio sid; this adopts it. Anything else — a single test call, an
 * inbound call — gets one created here, keyed by the sid so the transcript
 * lines up with it.
 */
function bindCallSession(
  store: OperationStore,
  input: {
    callSid: string;
    carrier?: { id: string; name: string };
    direction: "inbound" | "outbound";
  }
): string {
  const existing = store
    .getOperation()
    .callSessions.find((session) => session.callSid === input.callSid);

  if (existing) {
    store.updateCallSession(existing.id, { status: "in_progress" });
    return existing.id;
  }

  store.openCallSession({
    id: input.callSid,
    callSid: input.callSid,
    operationId: store.getOperation().id,
    carrierId: input.carrier?.id,
    driverName: input.carrier?.name,
    direction: input.direction,
    status: "in_progress",
    startedAt: new Date().toISOString()
  });
  return input.callSid;
}

function mediaStreamUrl(): string {
  if (!env.PUBLIC_WS_URL) throw new Error("public_ws_url_missing");
  return `${env.PUBLIC_WS_URL.replace(/\/$/, "")}${MEDIA_STREAM_PATH}`;
}

export function mountTelephonyRoutes(
  app: Express,
  dependencies: TelephonyDependencies
): void {
  const { store } = dependencies;
  const context = telephonyContext(store);
  const dialled = dependencies.dialled ?? context.dialled;
  store.subscribe((event) => {
    if (event.type === "call.started" || event.type === "call.updated")
      dependencies.onCallSessionChanged?.(event.callSession);
  });
  const twiml = express.urlencoded({ extended: false });

  // Twilio fetches these when a call connects; both directions share one relay.
  app.post(
    ["/twiml/outbound", "/twiml/inbound"],
    twiml,
    (request, response) => {
      // Twilio reports its answering-machine verdict here when machineDetection
      // is on. Opening a media stream to a recording spends telephony and model
      // minutes on a conversation nobody is having.
      const answeredBy = String(
        (request.body as { AnsweredBy?: unknown } | undefined)?.AnsweredBy ?? ""
      );
      if (answeredBy.startsWith("machine") || answeredBy === "fax") {
        console.log(
          `[call] ${answeredBy} answered; hanging up without an agent`
        );
        response
          .type("text/xml")
          .send(
            '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
          );
        return;
      }

      response.type("text/xml").send(createInboundTwiML(mediaStreamUrl()));
    }
  );

  /**
   * What the supervisor hears when they pick up. Polly reads the brief while
   * they are still connecting, so they arrive knowing the case without any
   * extra text-to-speech in the path.
   */
  app.post("/twiml/supervisor", twiml, (request, response) => {
    const callSid = String(request.query.callSid ?? "");
    const brief = String(request.query.brief ?? "Entrando a la llamada.");
    const wsUrl = `${(env.PUBLIC_WS_URL ?? "").replace(/\/$/, "")}${SUPERVISOR_STREAM_PATH}?callSid=${encodeURIComponent(callSid)}`;

    response
      .type("text/xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><Response>` +
          `<Say voice="Polly.Mia" language="es-MX">${escapeXmlText(brief)}</Say>` +
          `<Connect><Stream url="${escapeXmlText(wsUrl)}" /></Connect>` +
          `</Response>`
      );
  });

  // Diagnostic only: a TwiML with no media stream. If a call reaches this and
  // speaks, the account and the public URL are fine and the stream itself is
  // what the account refuses.
  app.post("/twiml/say", twiml, (_request, response) => {
    response
      .type("text/xml")
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Mia" language="es-MX">Prueba de Volta. Si escuchas esto, el camino de voz funciona.</Say><Pause length="2"/></Response>'
      );
  });

  // Accepts the destination as a query param as well as a JSON body: quoting a
  // JSON payload through PowerShell mangles the escaped quotes, and losing a
  // gate test to shell quoting is not a debt worth carrying.
  const readTo = (request: express.Request): string | undefined => {
    const fromQuery = request.query.to;
    if (typeof fromQuery === "string" && fromQuery.length > 0) return fromQuery;

    const body: unknown = request.body;
    if (typeof body === "object" && body !== null && "to" in body) {
      const candidate = (body as { to?: unknown }).to;
      if (typeof candidate === "string" && candidate.length > 0)
        return candidate;
    }
    return undefined;
  };

  // A body mangled by shell quoting should fall through to the query param
  // rather than surfacing as an HTML 500 page mid-gate.
  const parseJson = express.json({ strict: false });
  const jsonBody: express.RequestHandler = (request, response, next) => {
    parseJson(request, response, () => next());
  };

  /**
   * Opens a negotiation round: dials every carrier candidate at once. Quotes
   * from calls already in progress become leverage for the ones still talking,
   * which is what makes this a market rather than three separate calls.
   */
  app.post("/api/calls/negotiate", jsonBody, async (_request, response) => {
    context.resetAuction();
    dialled.clear();

    // A directory with no active carriers falls back to the seeded pool, so a
    // round is never silently dialled to nobody.
    let carriers: Array<{ id: string; name: string; phone: string }> = [];
    try {
      carriers = (await dependencies.listActiveCarriers?.()) ?? [];
    } catch (error) {
      console.error("[carriers] directory unavailable:", error);
    }
    if (carriers.length > 0) {
      console.log(
        `[carriers] dialling ${carriers.length} from the directory: ${carriers
          .map((carrier) => carrier.name)
          .join(", ")}`
      );
    }

    await fanOutCalls({
      store,
      ...(carriers.length > 0 ? { carriers } : {}),
      mode: env.VOLTA_MODE,
      publicBaseUrl: env.PUBLIC_BASE_URL,
      from: env.TWILIO_FROM_NUMBER,
      gateway:
        env.VOLTA_MODE === "live" ? createLiveTelephonyGateway() : undefined,
      timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS,
      record: env.TWILIO_RECORD_CALLS,
      detectAnsweringMachine: true,
      onDialled: (callId, carrier) => {
        dialled.set(callId, carrier);
        context.auction.startCall(carrier.id, callId);
      }
    });
    response.status(202).json({
      status: context.auction.status(),
      operation: store.getOperation()
    });
  });

  /**
   * Hands a live call to a person. The agent leg is never dropped: this marks
   * intent and state, and the audio hub routes the caller to the supervisor.
   * Until the hub lands the state is recorded so the board can already show
   * and drive the handover.
   */
  app.post("/api/calls/:callId/takeover", jsonBody, (request, response) => {
    const reason =
      typeof (request.body as { reason?: unknown } | undefined)?.reason ===
      "string"
        ? (request.body as { reason: string }).reason
        : undefined;

    try {
      const callSession = store.setCallSupervision(
        String(request.params.callId),
        {
          state: "briefing_supervisor",
          reason,
          requestedAt: new Date().toISOString()
        }
      );
      response.status(202).json(callSession);
    } catch {
      response.status(404).json({ error: "call_session_not_found" });
    }
  });

  /**
   * Accepts a call the agent offered. Only works while the countdown is still
   * running: once it lapses the agent has already closed the conversation.
   */
  app.post("/api/calls/:callId/accept", (request, response) => {
    const callSid = String(request.params.callId);
    if (!acceptTakeover(callSid)) {
      response.status(409).json({ error: "takeover_window_closed" });
      return;
    }
    const session = store
      .getOperation()
      .callSessions.find((item) => item.callSid === callSid);
    response.status(200).json(session ?? { callSid });
  });

  /** The supervisor is on the line; the caller now hears them. */
  app.post("/api/calls/:callId/connect", (request, response) => {
    try {
      const runtime = context.registry.byCallSid(String(request.params.callId));
      if (runtime) runtime.routeTo = "HUMAN";
      const callSession = store.setCallSupervision(
        String(request.params.callId),
        {
          state: "human",
          takenOverAt: new Date().toISOString()
        }
      );
      response.status(200).json(callSession);
    } catch {
      response.status(404).json({ error: "call_session_not_found" });
    }
  });

  /** Gives the conversation back to Volta without ending the call. */
  app.post("/api/calls/:callId/handback", (request, response) => {
    try {
      const runtime = context.registry.byCallSid(String(request.params.callId));
      if (runtime) runtime.routeTo = "AGENT";
      const callSession = store.setCallSupervision(
        String(request.params.callId),
        {
          state: "returned_to_agent",
          returnedAt: new Date().toISOString()
        }
      );
      response.status(200).json(callSession);
    } catch {
      response.status(404).json({ error: "call_session_not_found" });
    }
  });

  app.get("/api/transcript", async (request, response) => {
    const callId =
      typeof request.query.callId === "string"
        ? request.query.callId
        : undefined;
    // The store holds this process's live tail; the repository holds every
    // call ever handled, including by another instance. Merged and deduped so
    // a segment written moments ago is not missing while its insert lands.
    const live = store.getTranscript(callId);
    let stored: Array<import("@volta/contracts").TranscriptSegment> = [];
    try {
      stored = (await dependencies.listTranscript?.(callId)) ?? [];
    } catch (error) {
      console.error("[transcript] read failed:", error);
    }

    const byId = new Map(stored.map((segment) => [segment.id, segment]));
    for (const segment of live) byId.set(segment.id, segment);

    response
      .status(200)
      .json(
        [...byId.values()].sort((left, right) => left.startMs - right.startMs)
      );
  });

  app.get("/api/auction", (_request, response) => {
    response.status(200).json({
      status: context.auction.status(),
      standings: context.auction.standings()
    });
  });

  app.post("/twiml/status", twiml, (request, response) => {
    const callSid =
      typeof request.body.CallSid === "string"
        ? request.body.CallSid
        : undefined;
    const callStatus =
      typeof request.body.CallStatus === "string"
        ? request.body.CallStatus
        : undefined;
    const session = store
      .getOperation()
      .callSessions.find((item) => item.callSid === callSid);
    if (session && callStatus)
      store.updateCallSession(
        session.id,
        mapTwilioStatus(callStatus as Parameters<typeof mapTwilioStatus>[0])
      );
    response.sendStatus(204);
  });

  app.post("/api/calls/test", jsonBody, async (request, response) => {
    const to = readTo(request);

    if (to === undefined) {
      response.status(400).json({
        error: "missing_to",
        hint: 'pass ?to=+57... or {"to":"+57..."}'
      });
      return;
    }

    // ?twiml=say places the call against the diagnostic TwiML instead.
    const twimlPath =
      request.query.twiml === "say" ? "/twiml/say" : "/twiml/outbound";

    try {
      const gateway = createTwilioGateway({ client: getTwilioClient() });
      const session = await gateway.createOutboundCall({
        operationId: store.getOperation().id,
        to,
        from: env.TWILIO_FROM_NUMBER ?? "",
        twimlUrl: `${(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}${twimlPath}`,
        ...(env.CALL_TIME_LIMIT_SECONDS > 0
          ? { timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS }
          : {}),
        record: env.TWILIO_RECORD_CALLS
      });
      // Open the session as soon as it rings, not when audio arrives: the
      // floor should show a line being dialled, not appear once it connects.
      const carrier = store
        .getOperation()
        .candidates.find((candidate) => candidate.phone === to);
      store.openCallSession({
        id: session.id,
        callSid: session.id,
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        driverName: carrier?.name ?? "Test call",
        direction: "outbound",
        status: "pending",
        startedAt: session.startedAt
      });
      if (carrier)
        dialled.set(session.id, { id: carrier.id, name: carrier.name });

      response.status(201).json(session);
    } catch (error) {
      // Surface Twilio's own code: its messages alone rarely name the culprit.
      const detail = error as {
        message?: string;
        code?: number;
        status?: number;
      };
      response.status(502).json({
        error: detail.message ?? "call_failed",
        twilioCode: detail.code,
        twilioStatus: detail.status
      });
    }
  });
}

export function attachTelephonyWebSockets(
  server: Server,
  dependencies: TelephonyDependencies
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== MEDIA_STREAM_PATH && pathname !== SUPERVISOR_STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === SUPERVISOR_STREAM_PATH) {
      attachSupervisorStream(client, url.searchParams.get("callSid") ?? "");
      return;
    }

    console.log("[twilio] media stream connected");
    openMediaStreamSession(
      toRelaySocket(client, { label: "twilio" }),
      dependencies
    );
  });

  return wss;
}

/**
 * A call the agent asked a person to take over.
 *
 * The offer expires: a carrier left holding while nobody watches a dashboard
 * is worse than a clean "te devuelvo la llamada", so on expiry the agent says
 * so itself and the leg ends. Keyed by call sid, which is what the console
 * sends back when someone accepts.
 */
type PendingTakeover = {
  callSid: string;
  timer: NodeJS.Timeout;
  /** Hands the conversation to the person who accepted. */
  accept(): void;
  /** Closes politely because nobody did. */
  expire(): void;
};

const pendingTakeovers = new Map<string, PendingTakeover>();

export function acceptTakeover(callSid: string): boolean {
  const pending = pendingTakeovers.get(callSid);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingTakeovers.delete(callSid);
  pending.accept();
  return true;
}

/**
 * Offers a live call to a person and counts down. Accepting routes the caller
 * to the human; letting it lapse has the agent close the conversation itself
 * and end the leg.
 */
/**
 * Rings the supervisor and connects them into the live call. Their audio
 * arrives on its own media stream and the hub plays it to the carrier.
 */
async function dialSupervisor(callSid: string): Promise<void> {
  if (!env.SUPERVISOR_PHONE || !env.TWILIO_FROM_NUMBER) {
    console.warn("[takeover] no SUPERVISOR_PHONE configured; nobody to ring");
    return;
  }
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  const brief =
    "Entras a una llamada en curso de Volta. Escuchas al transportista y ya puedes hablar.";

  await createLiveTelephonyGateway().createOutboundCall({
    operationId: callSid,
    to: env.SUPERVISOR_PHONE,
    from: env.TWILIO_FROM_NUMBER,
    twimlUrl: `${base}/twiml/supervisor?callSid=${encodeURIComponent(callSid)}&brief=${encodeURIComponent(brief)}`
  });
  console.log(`[takeover] ringing the supervisor for call=${callSid}`);
}

function openTakeoverWindow(input: {
  store: OperationStore;
  runtime: CallRuntime;
  realtime: ClosableRelaySocket;
  hangUp: () => void;
}): void {
  const { store, runtime, realtime, hangUp } = input;
  if (pendingTakeovers.has(runtime.callSid)) return;

  const windowMs = env.TAKEOVER_WINDOW_SECONDS * 1000;
  const now = new Date();

  const setSupervision = (
    supervision: import("@volta/contracts").CallSupervision
  ) => {
    const session = store
      .getOperation()
      .callSessions.find((item) => item.callSid === runtime.callSid);
    if (session) store.setCallSupervision(session.id, supervision);
  };

  setSupervision({
    state: "awaiting_human",
    requestedAt: now.toISOString(),
    deadlineAt: new Date(now.getTime() + windowMs).toISOString()
  });
  console.log(
    `[takeover] offered call=${runtime.callSid} for ${env.TAKEOVER_WINDOW_SECONDS}s`
  );

  const timer = setTimeout(() => {
    pendingTakeovers.delete(runtime.callSid);
    console.log(`[takeover] nobody accepted call=${runtime.callSid}; closing`);
    setSupervision({ state: "postponed", requestedAt: now.toISOString() });

    // Volta closes in its own voice rather than the line simply dying.
    realtime.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Cierra la llamada ahora, en una sola frase breve y cordial: dile que necesitas confirmarlo internamente y que le devuelves la llamada. No negocies más, no hagas preguntas."
        }
      })
    );
    // Long enough for that sentence to play out before the leg ends.
    setTimeout(hangUp, 6000);
  }, windowMs);

  pendingTakeovers.set(runtime.callSid, {
    callSid: runtime.callSid,
    timer,
    accept: () => {
      runtime.routeTo = "HUMAN";
      // The carrier must not hear the agent's half-finished sentence once the
      // person takes over; Twilio has audio buffered.
      getBridge(runtime.callSid)?.clearCarrier();
      void dialSupervisor(runtime.callSid).catch((error: unknown) =>
        console.error("[takeover] could not reach the supervisor:", error)
      );
      setSupervision({
        state: "human",
        requestedAt: now.toISOString(),
        takenOverAt: new Date().toISOString()
      });
      console.log(`[takeover] accepted call=${runtime.callSid}`);
    },
    expire: () => undefined
  });
}

/**
 * A supervisor's leg. Their audio reaches the carrier only while the hub says
 * they hold the call, so joining is never enough on its own to talk over the
 * agent.
 */
function attachSupervisorStream(client: WebSocket, callSid: string): void {
  const bridge = getBridge(callSid);
  if (!bridge) {
    console.warn(`[takeover] supervisor joined but call=${callSid} is gone`);
    client.close();
    return;
  }

  let streamSid: string | undefined;
  console.log(`[takeover] supervisor is on the line for call=${callSid}`);

  client.on("message", (data: unknown) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return;
    }

    if (event.event === "start") {
      streamSid =
        (event.streamSid as string | undefined) ??
        (event.start as { streamSid?: string } | undefined)?.streamSid ??
        undefined;
      bridge.attachSupervisor((payload) => {
        if (client.readyState === 1 && streamSid) {
          client.send(
            JSON.stringify({ event: "media", streamSid, media: { payload } })
          );
        }
      });
      return;
    }

    if (event.event !== "media") return;
    const payload = (event.media as { payload?: string } | undefined)?.payload;
    // Only audible once a person has actually been handed the call.
    if (payload) bridge.sendToCarrier(payload, "human");
  });

  client.on("close", () => {
    console.log(`[takeover] supervisor left call=${callSid}`);
    bridge.detachSupervisor();
  });
}

function openMediaStreamSession(
  twilioSocket: ClosableRelaySocket,
  dependencies: TelephonyDependencies
): void {
  const { store } = dependencies;
  const context = telephonyContext(store);
  const registry = context.registry;
  const dialled =
    dependencies.dialled ??
    new Map(
      store
        .getOperation()
        .callSessions.filter(
          (
            session
          ): session is typeof session & {
            callSid: string;
            carrierId: string;
            driverName: string;
          } =>
            Boolean(session.callSid && session.carrierId && session.driverName)
        )
        .map((session) => [
          session.callSid,
          { id: session.carrierId, name: session.driverName }
        ])
    );
  if (!env.OPENAI_API_KEY) {
    console.error("[session] OPENAI_API_KEY missing; dropping the call");
    twilioSocket.close();
    return;
  }

  // Bound when Twilio announces the stream; every tool call on this socket is
  // attributed to it, so quotes from concurrent calls cannot be confused.
  let runtime: CallRuntime | undefined;

  const realtime = createRealtimeSocket({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_REALTIME_MODEL
  });

  // Realtime reports rejected session config as an `error` event rather than by
  // closing, so a silent agent looks identical to a healthy one without this.
  realtime.on("message", (raw) => {
    try {
      const event: unknown = JSON.parse(raw);
      if (
        typeof event === "object" &&
        event !== null &&
        (event as { type?: unknown }).type === "error"
      ) {
        console.error("[realtime] error event:", raw.slice(0, 500));
      }
    } catch {
      // Non-JSON frames are not ours to interpret.
    }
  });

  attachMediaStreamRelay({
    twilio: twilioSocket,
    realtime,
    onStart: ({ streamSid, callSid }) => {
      const carrier = callSid ? dialled.get(callSid) : undefined;

      // The switchboard for this call. Holding the carrier's socket here is
      // what lets a supervisor be routed in later without touching the leg.
      openBridge({
        callSid: callSid ?? streamSid,
        sendToCarrier: (payload) =>
          twilioSocket.send(
            JSON.stringify({ event: "media", streamSid, media: { payload } })
          ),
        clearCarrier: () =>
          twilioSocket.send(JSON.stringify({ event: "clear", streamSid })),
        floor: () => runtime?.routeTo ?? "AGENT"
      });

      runtime = registry.open({
        callSid: callSid ?? streamSid,
        streamSid,
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        carrierName: carrier?.name,
        direction: "outbound",
        startedAt: new Date().toISOString()
      });
      const session = store
        .getOperation()
        .callSessions.find((item) => item.callSid === (callSid ?? streamSid));
      if (session)
        store.updateCallSession(session.id, {
          status: "in_progress",
          startedAt: runtime.startedAt
        });
      bindCallSession(store, {
        callSid: callSid ?? streamSid,
        carrier,
        direction: "outbound"
      });

      console.log(
        `[call] started stream=${streamSid} call=${callSid ?? "?"} carrier=${carrier?.name ?? "unknown"}`
      );
      return runtime;
    },
    // Volta only reaches the carrier while it still has the floor.
    agentHasTheFloor: () => (runtime?.routeTo ?? "AGENT") === "AGENT",
    // A supervisor who joined hears the carrier throughout.
    onCallerAudio: (payload) => {
      if (runtime) getBridge(runtime.callSid)?.toSupervisor(payload);
    },
    onTranscript: ({ speaker, text, atMs }) => {
      const call = runtime;
      if (!call) return;
      const segment = {
        id: `seg-${call.callSid}-${atMs}`,
        organizationId: dependencies.organizationId ?? "textiles-pacifico",
        operationId: call.operationId,
        callId: call.callSid,
        speaker,
        text,
        startMs: atMs,
        endMs: atMs,
        createdAt: new Date().toISOString()
      };

      store.appendTranscript(segment);
      // Persisted separately, and never in the call's way: a database that is
      // down must not take the conversation with it.
      try {
        dependencies.onTranscriptAppended?.(segment);
      } catch (error) {
        console.error("[transcript] persist failed:", error);
      }
    },
    instructionsFor: (call) =>
      buildCallInstructions(store.getOperation(), call.carrierName),
    executeToolCall: async (request) => {
      const current = runtime;

      // The agent asking for a person opens a countdown rather than parking
      // the call: someone accepts from the console, or Volta says it will call
      // back and hangs up. A carrier holding for a dashboard nobody is
      // watching is the worst of the three outcomes.
      if (request.name === "trigger_escalation" && current) {
        openTakeoverWindow({
          store,
          runtime: current,
          realtime,
          hangUp: () => twilioSocket.close()
        });
      }

      console.log(
        `[tool] ${request.name} call=${current?.callSid ?? "?"} t=${current ? callClockMs(current) : 0}ms`
      );

      return executeToolCall(request, {
        store,
        // Only quotes other carriers actually gave. Nothing here lets the
        // agent cite a price that was never offered.
        leverage: () =>
          current?.carrierId
            ? context.auction.leverageFor(current.carrierId)
            : [],
        callContext: current
          ? {
              callId: current.callSid,
              carrierId: current.carrierId,
              carrierName: current.carrierName,
              callClockMs: () => callClockMs(current)
            }
          : undefined,
        // Built per call so the recap and the audio anchor belong to this leg.
        mode: "negotiation" as const,
        finalizeConfirmation: async () => {}
      });
    }
  });

  // Neither side owns the other: closing one must tear down the other, or the
  // Realtime session keeps billing after the caller hangs up.
  twilioSocket.on("close", () => {
    if (runtime) {
      closeBridge(runtime.callSid);
      registry.close(runtime.streamSid);
      const session = store
        .getOperation()
        .callSessions.find((item) => item.callSid === runtime?.callSid);
      if (session && session.status === "in_progress")
        store.updateCallSession(session.id, {
          status: "completed",
          endedAt: new Date().toISOString()
        });
    }
    realtime.close();
  });
  realtime.on("close", () => twilioSocket.close());
}
