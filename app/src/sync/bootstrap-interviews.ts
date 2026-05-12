/**
 * Resumable interviews bootstrap: only walks jobs that don't yet have any interview row.
 * Safe to re-run if the previous attempt died mid-way.
 */
import { logger } from "@/lib/logger.js";
import { pool } from "@/db/client.js";
import { listJobIdsWithoutInterviews } from "@/sync/store.js";
import { syncInterviewsByJobIds } from "@/sync/orchestrator.js";

async function main() {
  const ids = await listJobIdsWithoutInterviews();
  logger.info({ pendingJobs: ids.length }, "bootstrap-interviews: resumable scan");
  if (ids.length === 0) {
    logger.info("bootstrap-interviews: nothing to do");
    return;
  }
  const r = await syncInterviewsByJobIds({
    mode: "bootstrap",
    jobIds: ids,
    jobConcurrency: 4,
    detailConcurrency: 2,
  });
  logger.info({ r }, "bootstrap-interviews: done");
}

main()
  .catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      "bootstrap-interviews: failed",
    );
    process.exitCode = 1;
  })
  .finally(() => pool.end());
