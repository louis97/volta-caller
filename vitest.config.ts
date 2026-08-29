import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    setupFiles: ["./frontend/vitest.setup.ts"]
  }
});
