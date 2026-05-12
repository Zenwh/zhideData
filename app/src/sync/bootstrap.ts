/**
 * Bootstrap：首次部署时跑一次。
 *   1. 全量同步岗位（不带 start_time）
 *   2. 用入库后的所有 job_id 反查面经
 */

import { logger } from "@/lib/logger.js";
import { pool } from "@/db/client.js";
import { syncInterviewsFull, syncJobs } from "@/sync/orchestrator.js";

async function main() {
  logger.info("bootstrap: starting full job sync");
  const jobsResult = await syncJobs({ mode: "bootstrap", startTime: null });
  logger.info({ jobsResult }, "bootstrap: jobs done");

  logger.info("bootstrap: starting full interview sync (by job_id)");
  const interviewsResult = await syncInterviewsFull();
  logger.info({ interviewsResult }, "bootstrap: interviews done");

  await pool.end();
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "bootstrap failed");
  process.exit(1);
});
