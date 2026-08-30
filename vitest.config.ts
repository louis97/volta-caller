import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    passWithNoTests: true,
    // Resolved against this file, not the working directory: the frontend
    // workspace runs vitest from its own folder and a relative path there
    // looks for frontend/frontend/vitest.setup.ts.
    setupFiles: [
      fileURLToPath(new URL("./frontend/vitest.setup.ts", import.meta.url))
    ]
  }
});
