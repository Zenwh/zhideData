import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { env } from "@/lib/env.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const drizzleDir = join(__dirname, "..", "..", "drizzle");

async function main() {
  const pool = new Pool({ connectionString: env.DATABASE_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(drizzleDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const exists = await pool.query("SELECT 1 FROM _migrations WHERE id = $1", [file]);
    if (exists.rowCount && exists.rowCount > 0) {
      console.log(`[migrate] skip ${file}`);
      continue;
    }
    const sql = readFileSync(join(drizzleDir, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);

    console.log(`[migrate] apply ${file} (${statements.length} statements)`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query("INSERT INTO _migrations (id) VALUES ($1)", [file]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log("[migrate] done.");
}

main().catch((err) => {
  console.error("[migrate] FAILED", err);
  process.exit(1);
});
