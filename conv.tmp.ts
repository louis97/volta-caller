import pg from "pg";
import { env } from "./src/config/env";
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const calls = await pool.query(`select call_id, count(*)::int n, max(created_at) t
  from transcript_segments group by call_id order by t desc limit 3`);

for (const c of calls.rows) {
  console.log("\n═══ " + String(c.call_id).slice(0, 20) + "  (" + c.n + " segs) ═══");
  const { rows } = await pool.query(
    "select speaker, text, start_ms from transcript_segments where call_id=$1 order by start_ms asc",
    [c.call_id]
  );
  for (const r of rows) {
    console.log(`  [${String(r.speaker).padEnd(7)}] ${String(r.text).replace(/\s+/g," ").slice(0, 110)}`);
  }
}
await pool.end(); process.exit(0);
