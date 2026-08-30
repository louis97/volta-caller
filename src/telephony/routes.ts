import type { Server } from "node:http";

import express, { type Express } from "express";
import twilio from "twilio";
import { WebSocketServer } from "ws";

import { executeToolCall } from "../agent/interpreter";
import { createCommitmentFinalizer } from "../audit/commitment";
import { env } from "../config/env";
import { seedOperation } from "../core/seed";
import { createOperationStore, type OperationStore } from "../core/state";
import { MockSmsGateway } from "../mocks/sms";
import { auctionFromOperation, type Auction } from "./auction";
import { attachMediaStreamRelay } from "./mediaStream";
import { callClockMs, createCallRegistry, type CallRuntime } from "./registry";
import {
  createRealtimeSocket,
  toRelaySocket,
  type ClosableRelaySocket
} from "./sockets";
import {
  createInboundTwiML,
  createTwilioGateway,
  type TwilioCallClient
} from "./twilio";

export const MEDIA_STREAM_PATH = "/media-stream";

/** One operation, many concurrent calls negotiating against it. */
const store: OperationStore = createOperationStore(seedOperation());

/** Live calls, keyed by stream. Owns identity and the audio clock. */
export const registry = createCallRegistry();

/** The market across the concurrent calls of the current negotiation round. */
let auction: Auction = auctionFromOperation(store.getOperation());

/**
 * callSid -> carrier, recorded when we dial. Twilio only tells us the call sid
 * when the stream starts, and the agent must never be the one to say which
 * carrier it is talking to.
 */
const dialled = new Map<string, { id: string; name: string }>();

// Quotes reach the auction through the store's event stream, so the auction
// stays a read model and there is one write path for a quote.
store.subscribe((event) => {
  if (event.type === "quote.registered") auction.recordQuote(event.quote);
});

function getTwilioClient(): TwilioCallClient {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error("twilio_credentials_missing");
  }
  return twilio(
    env.TWILIO_ACCOUNT_SID,
    env.TWILIO_AUTH_TOKEN
  ) as unknown as TwilioCallClient;
}

function mediaStreamUrl(): string {
  if (!env.PUBLIC_WS_URL) throw new Error("public_ws_url_missing");
  return `${env.PUBLIC_WS_URL.replace(/\/$/, "")}${MEDIA_STREAM_PATH}`;
}

export function mountTelephonyRoutes(app: Express): void {
  const twiml = express.urlencoded({ extended: false });

  // Twilio fetches these when a call connects; both directions share one relay.
  app.post(
    ["/twiml/outbound", "/twiml/inbound"],
    twiml,
    (_request, response) => {
      response.type("text/xml").send(createInboundTwiML(mediaStreamUrl()));
    }
  );

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
    const operation = store.getOperation();
    auction = auctionFromOperation(operation);
    dialled.clear();

    const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
    const gateway = createTwilioGateway({ client: getTwilioClient() });

    const results = await Promise.all(
      operation.candidates.map(async (candidate) => {
        try {
          const session = await gateway.createOutboundCall({
            operationId: operation.id,
            carrierId: candidate.id,
            to: candidate.phone,
            from: env.TWILIO_FROM_NUMBER ?? "",
            twimlUrl: `${base}/twiml/outbound`,
            ...(env.CALL_TIME_LIMIT_SECONDS > 0
              ? { timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS }
              : {}),
            record: env.TWILIO_RECORD_CALLS
          });
          dialled.set(session.id, { id: candidate.id, name: candidate.name });
          auction.startCall(candidate.id, session.id);
          return { carrierId: candidate.id, callId: session.id };
        } catch (error) {
          // One carrier not picking up is a market outcome, not a failure of
          // the round: the auction records it and the others keep negotiating.
          const reason = error instanceof Error ? error.message : "dial_failed";
          auction.markUnavailable(candidate.id, reason);
          return { carrierId: candidate.id, error: reason };
        }
      })
    );

    response.status(202).json({ round: results, status: auction.status() });
  });

  app.get("/api/auction", (_request, response) => {
    response
      .status(200)
      .json({ status: auction.status(), standings: auction.standings() });
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

export function attachTelephonyWebSockets(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname !== MEDIA_STREAM_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });

  wss.on("connection", (client) => {
    console.log("[twilio] media stream connected");
    openMediaStreamSession(toRelaySocket(client, { label: "twilio" }));
  });

  return wss;
}

function openMediaStreamSession(twilioSocket: ClosableRelaySocket): void {
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
      runtime = registry.open({
        callSid: callSid ?? streamSid,
        streamSid,
        operationId: store.getOperation().id,
        carrierId: carrier?.id,
        carrierName: carrier?.name,
        direction: "outbound",
        startedAt: new Date().toISOString()
      });
      console.log(
        `[call] started stream=${streamSid} call=${callSid ?? "?"} carrier=${carrier?.name ?? "unknown"}`
      );
      return runtime;
    },
    executeToolCall: (request) => {
      const current = runtime;
      console.log(
        `[tool] ${request.name} call=${current?.callSid ?? "?"} t=${current ? callClockMs(current) : 0}ms`
      );

      return executeToolCall(request, {
        store,
        // Only quotes other carriers actually gave. Nothing here lets the
        // agent cite a price that was never offered.
        leverage: () =>
          current?.carrierId ? auction.leverageFor(current.carrierId) : [],
        callContext: current
          ? {
              callId: current.callSid,
              carrierId: current.carrierId,
              carrierName: current.carrierName,
              callClockMs: () => callClockMs(current)
            }
          : undefined,
        // Built per call so the recap and the audio anchor belong to this leg.
        finalizeBooking: createCommitmentFinalizer({
          store,
          sms: new MockSmsGateway(),
          callId: current?.callSid ?? "unknown-call",
          recipient: store.getOperation().mandate.escalationPhone
        })
      });
    }
  });

  // Neither side owns the other: closing one must tear down the other, or the
  // Realtime session keeps billing after the caller hangs up.
  twilioSocket.on("close", () => {
    if (runtime) registry.close(runtime.streamSid);
    realtime.close();
  });
  realtime.on("close", () => twilioSocket.close());
}
