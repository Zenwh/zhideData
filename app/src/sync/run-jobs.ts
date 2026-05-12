
import { logger } from "@/lib/logger.js";
import { pool } from "@/db/client.js";
import { syncJobsIncremental } from "@/sync/orchestrator.js";

syncJobsIncremental()
  .then((r) => {
    logger.info({ r }, "run-jobs done");
  })
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "run-jobs failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
