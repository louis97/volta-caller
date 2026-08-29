import { describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env";

describe("loadEnv", () => {
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
});
