/**
 * Smoke test：拉 1 页岗位（10 条）入库，再对前 3 个 jobId 反查面经，验证全链路。
 */

import { logger } from "@/lib/logger.js";
import { pool } from "@/db/client.js";
import { stepfun } from "@/adapters/stepfun.js";
import { mapJob, mapInterview } from "@/adapters/mappers.js";
import { upsertJobs, upsertInterviews } from "@/sync/store.js";

async function main() {
  logger.info("smoke: fetching 1 page of jobs");
  const page = await stepfun.positionList({ page_num: 1, page_size: 10 });
  logger.info({ items: page.items.length, total: page.total_items }, "smoke: jobs page");

  const rows = page.items.map(mapJob);
  const n = await upsertJobs(rows);
  logger.info({ upserted: n }, "smoke: jobs upserted");

  for (const row of rows.slice(0, 3)) {
    logger.info({ jobId: row.id }, "smoke: querying interviews for job");
    const list = await stepfun.interviewListV1({
      job_ids: row.id,
      page_num: 1,
      page_size: 50,
    });
    logger.info({ jobId: row.id, items: list.items.length }, "smoke: interview summaries");
    if (list.items.length === 0) continue;

    const interviews = [];
    for (const summary of list.items) {
      try {
        const detail = await stepfun.interviewDetail(summary.id);
        interviews.push(mapInterview({ summary, detail, jobId: row.id }));
      } catch (err) {
        logger.warn({ id: summary.id, err: (err as Error).message }, "detail failed");
        interviews.push(mapInterview({ summary, detail: null, jobId: row.id }));
      }
    }
    const m = await upsertInterviews(interviews);
    logger.info({ jobId: row.id, interviews: m }, "smoke: interviews upserted");
  }

  await pool.end();
  logger.info("smoke: done");
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "smoke failed");
  process.exit(1);
});
