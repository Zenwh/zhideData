
import { logger } from "@/lib/logger.js";
import { pool } from "@/db/client.js";
import { syncInterviewsIncremental } from "@/sync/orchestrator.js";

syncInterviewsIncremental()
  .then((r) => {
    logger.info({ r }, "run-interviews done");
  })
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "run-interviews failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
