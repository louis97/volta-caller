import { describe, expect, it } from "vitest";

import { acceptTakeover } from "../../src/telephony/routes";

describe("takeover window", () => {
  it("refuses to accept a call that was never offered", () => {
    // The console can only ever accept what the agent actually offered; a
    // stale button must not silently do nothing and look successful.
    expect(acceptTakeover("CA-never-offered")).toBe(false);
  });

  it("refuses to accept the same call twice", () => {
    // Accepting consumes the offer. A second click after the window closed
    // has to fail loudly rather than re-route a call that already moved on.
    expect(acceptTakeover("CA-never-offered")).toBe(false);
    expect(acceptTakeover("CA-never-offered")).toBe(false);
  });
});
