import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

await build({
  entryPoints: ["api/_entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "api/index.js",
  external: [
    "express",
    "ws",
    "twilio",
    "openai",
    "pg",
    "zod",
    "@supabase/supabase-js"
  ]
});

await mkdir("api/migrations", { recursive: true });
await cp("src/storage/migrations", "api/migrations", { recursive: true });
