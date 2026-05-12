import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

import { db } from "@/db/client.js";

export function registerHealthRoutes(app: FastifyInstance) {
  app.get("/v1/healthz", async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      reply.send({ code: 0, message: "ok", data: { db: "up" } });
    } catch (err) {
      reply.code(503).send({
        code: 503,
        message: "db down",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.get("/v1/sync/status", async (_req, reply) => {
    const res = await db.execute(sql`
      SELECT kind, mode, started_at, finished_at,
             total_fetched, total_upserted, total_failed, error_message
      FROM sync_logs
      ORDER BY started_at DESC
      LIMIT 20
    `);
    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM jobs) AS jobs_count,
        (SELECT count(*)::int FROM interviews) AS interviews_count
    `);
    reply.send({
      code: 0,
      message: "ok",
      data: {
        counts: counts.rows[0] ?? {},
        recent: res.rows,
      },
    });
  });
}
