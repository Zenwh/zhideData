import { logger } from "@/lib/logger.js";
import { pool } from "@/db/client.js";
import { syncInterviewsFull } from "@/sync/orchestrator.js";

syncInterviewsFull()
  .then((r) => {
    logger.info({ r }, "run-interviews-full done");
  })
  .catch((err) => {
    logger.error({ err: err instanceof Error ? err.message : err }, "run-interviews-full failed");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
