/**
 * Re-fetch detail for interviews stored with empty content (early bootstrap failures).
 */
import { sql } from "drizzle-orm";
import pLimit from "p-limit";

import { db, pool } from "@/db/client.js";
import { logger } from "@/lib/logger.js";
import { stepfun } from "@/adapters/stepfun.js";
import { mapInterview } from "@/adapters/mappers.js";
import { upsertInterviews } from "@/sync/store.js";

async function main() {
  const res = await db.execute(sql`
    SELECT id, job_id, title, brief_title, brief_intro, company, city, position_type, recruitment_tag, upstream_create_at
    FROM interviews
    WHERE (content IS NULL OR content::text IN ('null', '{}'))
       OR (content_raw IS NULL OR content_raw = '')
    ORDER BY upstream_create_at DESC NULLS LAST
  `);
  const rows = res.rows as Array<{
    id: string;
    job_id: string | null;
    title: string | null;
    brief_title: string | null;
    brief_intro: string | null;
    company: string | null;
    city: string | null;
    position_type: string | null;
    recruitment_tag: string | null;
    upstream_create_at: Date | string | null;
  }>;
  logger.info({ pending: rows.length }, "refill-content: starting");

  const limit = pLimit(3);
  let ok = 0;
  let failed = 0;

  await Promise.all(
    rows.map((row) =>
      limit(async () => {
        try {
          const detail = await stepfun.interviewDetail(row.id);
          if (!detail) {
            failed += 1;
            return;
          }
          const interviewRow = mapInterview({
            summary: {
              id: row.id,
              title: row.title ?? undefined,
              brief_title: row.brief_title ?? undefined,
              brief_intro: row.brief_intro ?? undefined,
              company: row.company ?? undefined,
              city: row.city ?? undefined,
              position_type: row.position_type ?? undefined,
              recruitment_tag: row.recruitment_tag ?? undefined,
              create_at:
                row.upstream_create_at instanceof Date
                  ? row.upstream_create_at.toISOString()
                  : (row.upstream_create_at ?? undefined),
            },
            detail,
            jobId: row.job_id,
          });
          await upsertInterviews([interviewRow]);
          ok += 1;
          if (ok % 50 === 0) logger.info({ ok, failed }, "refill-content: progress");
        } catch (err) {
          failed += 1;
          logger.warn(
            { id: row.id, err: (err as Error).message },
            "refill-content: detail failed",
          );
        }
      }),
    ),
  );

  logger.info({ ok, failed, total: rows.length }, "refill-content: done");
}

main()
  .catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "refill-content: top-level failed",
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
