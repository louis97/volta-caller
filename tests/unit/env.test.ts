import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env";

describe("loadEnv", () => {
  it("defaults the operational chat to the low-latency mini model", () => {
    expect(loadEnv({}).VOLTA_COPILOT_MODEL).toBe("gpt-5.4-mini");
  });

  it("accepts a Supabase publishable key for live development", () => {
    expect(
      loadEnv({
        VOLTA_MODE: "live",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example"
      })
    ).toMatchObject({
      VOLTA_MODE: "live",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example"
    });
  });

  it("derives public telephony URLs from Render when unset", () => {
    expect(
      loadEnv({
        RENDER_EXTERNAL_URL: "https://volta-api.onrender.com/"
      })
    ).toMatchObject({
      PUBLIC_BASE_URL: "https://volta-api.onrender.com",
      PUBLIC_WS_URL: "wss://volta-api.onrender.com"
    });
  });
});
