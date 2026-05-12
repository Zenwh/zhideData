import cron from "node-cron";

import { env } from "@/lib/env.js";
import { logger } from "@/lib/logger.js";
import {
  syncInterviewsFull,
  syncInterviewsIncremental,
  syncJobsIncremental,
} from "@/sync/orchestrator.js";

let jobsRunning = false;
let interviewsRunning = false;

function guard(name: string, lock: () => boolean, set: (v: boolean) => void, fn: () => Promise<unknown>) {
  return async () => {
    if (lock()) {
      logger.warn({ name }, "previous run still in progress, skipping");
      return;
    }
    set(true);
    try {
      await fn();
    } catch (err) {
      logger.error({ name, err: err instanceof Error ? err.message : err }, "scheduled job failed");
    } finally {
      set(false);
    }
  };
}

export function startSchedulers() {
  if (!env.SYNC_ENABLED) {
    logger.warn("SYNC_ENABLED=false, schedulers not started");
    return;
  }

  cron.schedule(
    env.SYNC_JOBS_CRON,
    guard("jobs", () => jobsRunning, (v) => (jobsRunning = v), syncJobsIncremental),
  );
  cron.schedule(
    env.SYNC_INTERVIEWS_CRON,
    guard(
      "interviews",
      () => interviewsRunning,
      (v) => (interviewsRunning = v),
      syncInterviewsIncremental,
    ),
  );
  cron.schedule(
    env.SYNC_FULL_RECONCILE_CRON,
    guard(
      "reconcile",
      () => interviewsRunning,
      (v) => (interviewsRunning = v),
      syncInterviewsFull,
    ),
  );

  logger.info(
    {
      jobs: env.SYNC_JOBS_CRON,
      interviews: env.SYNC_INTERVIEWS_CRON,
      reconcile: env.SYNC_FULL_RECONCILE_CRON,
    },
    "schedulers started",
  );
}
