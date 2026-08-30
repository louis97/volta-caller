import { describe, expect, it } from "vitest";

import {
  callClockMs,
  createCallRegistry,
  FRAME_DURATION_MS
} from "../../src/telephony/registry";

function open(registry = createCallRegistry(), streamSid = "MZ1") {
  return {
    registry,
    runtime: registry.open({
      callSid: `CA-${streamSid}`,
      streamSid,
      operationId: "operation-1",
      carrierId: "carrier-1",
      carrierName: "Transportes Costa Pacífico",
      direction: "outbound",
      startedAt: "2026-08-29T23:00:00.000Z"
    })
  };
}

describe("call registry", () => {
  it("starts a call routed to the agent with a zeroed clock", () => {
    const { runtime } = open();

    expect(runtime.routeTo).toBe("AGENT");
    expect(callClockMs(runtime)).toBe(0);
  });

  it("derives the audio offset from counted media frames", () => {
    const { runtime } = open();

    runtime.frameCount = 4710;

    // 4710 frames x 20 ms = 94.2 s, the moment a commitment would anchor to.
    expect(callClockMs(runtime)).toBe(94_200);
    expect(FRAME_DURATION_MS).toBe(20);
  });

  it("keeps concurrent calls isolated", () => {
    const registry = createCallRegistry();
    const first = open(registry, "MZ1").runtime;
    const second = open(registry, "MZ2").runtime;

    first.frameCount = 100;

    expect(callClockMs(second)).toBe(0);
    expect(registry.active()).toHaveLength(2);
    expect(registry.get("MZ2")).toBe(second);
    expect(registry.byCallSid("CA-MZ1")).toBe(first);
  });

  it("forgets a call once its stream closes", () => {
    const { registry } = open();

    registry.close("MZ1");

    expect(registry.get("MZ1")).toBeUndefined();
    expect(registry.active()).toHaveLength(0);
  });
});
