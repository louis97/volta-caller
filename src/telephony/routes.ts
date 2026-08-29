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
import { attachMediaStreamRelay } from "./mediaStream";
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

/**
 * Phase 0 wiring: one live operation shared by every call. The per-call
 * registry that Phase 1 introduces replaces this singleton.
 */
const store: OperationStore = createOperationStore(seedOperation());

const finalizeBooking = createCommitmentFinalizer({
  store,
  sms: new MockSmsGateway(),
  callId: "live-call",
  recipient: store.getOperation().mandate.escalationPhone
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

  app.post("/api/calls/test", jsonBody, async (request, response) => {
    const to = readTo(request);

    if (to === undefined) {
      response
        .status(400)
        .json({
          error: "missing_to",
          hint: 'pass ?to=+57... or {"to":"+57..."}'
        });
      return;
    }

    try {
      const gateway = createTwilioGateway({ client: getTwilioClient() });
      const session = await gateway.createOutboundCall({
        operationId: store.getOperation().id,
        to,
        from: env.TWILIO_FROM_NUMBER ?? "",
        twimlUrl: `${(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}/twiml/outbound`,
        timeLimitSeconds: env.CALL_TIME_LIMIT_SECONDS,
        record: true
      });
      response.status(201).json(session);
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? error.message : "call_failed"
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
    openMediaStreamSession(toRelaySocket(client));
  });

  return wss;
}

function openMediaStreamSession(twilioSocket: ClosableRelaySocket): void {
  if (!env.OPENAI_API_KEY) {
    twilioSocket.close();
    return;
  }

  const realtime = createRealtimeSocket({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_REALTIME_MODEL
  });

  attachMediaStreamRelay({
    twilio: twilioSocket,
    realtime,
    executeToolCall: (request) =>
      executeToolCall(request, { store, finalizeBooking })
  });

  // Neither side owns the other: closing one must tear down the other, or the
  // Realtime session keeps billing after the caller hangs up.
  twilioSocket.on("close", () => realtime.close());
  realtime.on("close", () => twilioSocket.close());
}
