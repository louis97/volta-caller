import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { toRelaySocket } from "../../src/telephony/sockets";

const CONNECTING = 0;
const OPEN = 1;

class FakeWebSocket {
  readonly sent: string[] = [];
  readonly closed: boolean[] = [];
  readyState: number = CONNECTING;

  private readonly listeners = new Map<
    string,
    Array<(payload: unknown) => void>
  >();

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed.push(true);
  }

  on(event: string, listener: (payload: unknown) => void): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function asWebSocket(socket: FakeWebSocket): WebSocket {
  return socket as unknown as WebSocket;
}

describe("toRelaySocket", () => {
  it("queues messages sent before the socket opens and flushes them in order", () => {
    const socket = new FakeWebSocket();
    const relay = toRelaySocket(asWebSocket(socket), { label: "test" });

    relay.send("session.update");
    relay.send("response.create");

    expect(socket.sent).toEqual([]);

    socket.readyState = OPEN;
    socket.emit("open");

    expect(socket.sent).toEqual(["session.update", "response.create"]);
  });

  it("sends straight through once the socket is open", () => {
    const socket = new FakeWebSocket();
    socket.readyState = OPEN;
    const relay = toRelaySocket(asWebSocket(socket), { label: "test" });

    relay.send("input_audio_buffer.append");

    expect(socket.sent).toEqual(["input_audio_buffer.append"]);
  });

  it("normalises binary frames to strings for the relay", () => {
    const socket = new FakeWebSocket();
    const relay = toRelaySocket(asWebSocket(socket), { label: "test" });
    const received: string[] = [];
    relay.on("message", (message) => received.push(message));

    socket.emit("message", Buffer.from(JSON.stringify({ type: "ping" })));

    expect(received).toEqual([JSON.stringify({ type: "ping" })]);
  });

  it("closes the underlying socket", () => {
    const socket = new FakeWebSocket();
    const relay = toRelaySocket(asWebSocket(socket), { label: "test" });

    relay.close();

    expect(socket.closed).toEqual([true]);
  });

  it("drops stale audio instead of queueing it, but keeps control messages", () => {
    const socket = new FakeWebSocket();
    const relay = toRelaySocket(asWebSocket(socket), {
      label: "test",
      shouldQueue: (message) => !message.includes('"input_audio_buffer.append"')
    });

    relay.send(JSON.stringify({ type: "session.update" }));
    relay.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: "x" })
    );
    relay.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: "y" })
    );
    relay.send(JSON.stringify({ type: "response.create" }));

    socket.readyState = OPEN;
    socket.emit("open");

    // Audio from before the session existed would flush as a burst of speech
    // and interrupt the agent's own greeting.
    expect(socket.sent.map((message) => JSON.parse(message).type)).toEqual([
      "session.update",
      "response.create"
    ]);
  });
});
