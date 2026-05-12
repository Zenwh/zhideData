import pLimit from "p-limit";

import {
  formatUpstreamTime,
  stepfun,
  type StepFunJobListInput,
} from "@/adapters/stepfun.js";
import { mapJob, mapInterview, type JobRow, type InterviewRow } from "@/adapters/mappers.js";
import { env } from "@/lib/env.js";
import { logger } from "@/lib/logger.js";
import {
  finishSyncLog,
  getLastSuccessfulWatermark,
  listAllJobIds,
  listJobIdsUpdatedSince,
  startSyncLog,
  upsertInterviews,
  upsertJobs,
} from "@/sync/store.js";

const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

export interface SyncJobsResult {
  fetched: number;
  upserted: number;
  newWatermark: Date | null;
}

export async function syncJobs(opts: {
  mode: "bootstrap" | "incremental" | "manual";
  startTime?: Date | null;
}): Promise<SyncJobsResult> {
  const watermarkBefore = opts.startTime ?? null;
  const logId = await startSyncLog({
    kind: "jobs",
    mode: opts.mode,
    watermarkBefore,
    meta: { startTime: watermarkBefore?.toISOString() ?? null },
  });

  let fetched = 0;
  let upserted = 0;
  let maxUpdateTime: Date | null = null;
  const pageSize = env.SYNC_PAGE_SIZE;

  try {
    let pageNum = 1;
    while (true) {
      // Server uses `current_page`, not `page_num` (docs are wrong). Send both for safety.
      const input: StepFunJobListInput = {
        current_page: pageNum,
        page_num: pageNum,
        page_size: pageSize,
      };
      if (opts.startTime) {
        input.start_time = formatUpstreamTime(opts.startTime);
      }

      logger.info({ pageNum, pageSize, startTime: input.start_time }, "fetching jobs page");
      const page = await stepfun.positionList(input);

      const items = page.items ?? [];
      if (items.length === 0) break;

      const rows: JobRow[] = items.map(mapJob);
      const n = await upsertJobs(rows);
      fetched += items.length;
      upserted += n;

      for (const row of rows) {
        if (row.upstreamUpdateTime && (!maxUpdateTime || row.upstreamUpdateTime > maxUpdateTime)) {
          maxUpdateTime = row.upstreamUpdateTime;
        }
      }

      const totalItems = page.total_items ?? 0;
      const pagedSoFar = pageNum * pageSize;
      if (items.length < pageSize || pagedSoFar >= totalItems) break;
      pageNum += 1;
    }

    await finishSyncLog({
      id: logId,
      totalFetched: fetched,
      totalUpserted: upserted,
      watermarkAfter: maxUpdateTime,
    });
    logger.info({ fetched, upserted, maxUpdateTime }, "syncJobs done");
    return { fetched, upserted, newWatermark: maxUpdateTime };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishSyncLog({
      id: logId,
      totalFetched: fetched,
      totalUpserted: upserted,
      errorMessage: msg,
    });
    logger.error({ err: msg }, "syncJobs failed");
    throw err;
  }
}

export async function syncJobsIncremental(): Promise<SyncJobsResult> {
  const last = await getLastSuccessfulWatermark("jobs");
  if (!last) {
    logger.info("no prior jobs watermark, doing full sync");
    return syncJobs({ mode: "incremental", startTime: null });
  }
  const startTime = new Date(last.getTime() - WATERMARK_OVERLAP_MS);
  return syncJobs({ mode: "incremental", startTime });
}

export interface SyncInterviewsResult {
  fetched: number;
  upserted: number;
  jobsScanned: number;
  jobsWithInterviews: number;
  detailsFetched: number;
  detailsFailed: number;
}

/**
 * 通过 V1 + job_id 反查面经摘要。
 * V1 inner data shape：{ has_more, items: [InterviewSummary] }
 */
async function fetchInterviewSummariesForJob(jobId: string) {
  const page = await stepfun.interviewListV1({
    job_ids: jobId,
    page_num: 1,
    page_size: 50,
  });
  return page.items ?? [];
}

/**
 * 走完一个 job：列出摘要 → 并发拉详情 → 合并入库。
 */
async function syncOneJobInterviews(
  jobId: string,
  detailLimit: ReturnType<typeof pLimit>,
): Promise<{
  fetched: number;
  upserted: number;
  detailsFetched: number;
  detailsFailed: number;
  hasInterviews: boolean;
}> {
  const summaries = await fetchInterviewSummariesForJob(jobId);
  if (summaries.length === 0) {
    return {
      fetched: 0,
      upserted: 0,
      detailsFetched: 0,
      detailsFailed: 0,
      hasInterviews: false,
    };
  }

  let detailsFetched = 0;
  let detailsFailed = 0;

  const rows: InterviewRow[] = await Promise.all(
    summaries.map((summary) =>
      detailLimit(async () => {
        try {
          const detail = await stepfun.interviewDetail(summary.id);
          detailsFetched += 1;
          return mapInterview({ summary, detail, jobId });
        } catch (err) {
          detailsFailed += 1;
          logger.warn(
            { jobId, interviewId: summary.id, err: (err as Error).message },
            "interview detail fetch failed; falling back to summary-only",
          );
          return mapInterview({ summary, detail: null, jobId });
        }
      }),
    ),
  );

  const n = await upsertInterviews(rows);
  return {
    fetched: rows.length,
    upserted: n,
    detailsFetched,
    detailsFailed,
    hasInterviews: true,
  };
}

export async function syncInterviewsByJobIds(opts: {
  mode: "bootstrap" | "incremental" | "manual" | "reconcile";
  jobIds: string[];
  jobConcurrency?: number;
  detailConcurrency?: number;
}): Promise<SyncInterviewsResult> {
  const logId = await startSyncLog({
    kind: "interviews",
    mode: opts.mode,
    meta: { totalJobIds: opts.jobIds.length },
  });

  const jobLimit = pLimit(opts.jobConcurrency ?? 8);
  const detailLimit = pLimit(opts.detailConcurrency ?? 4);
  let fetched = 0;
  let upserted = 0;
  let jobsWithInterviews = 0;
  let detailsFetched = 0;
  let detailsFailed = 0;
  let listFailed = 0;

  try {
    await Promise.all(
      opts.jobIds.map((jobId) =>
        jobLimit(async () => {
          try {
            const r = await syncOneJobInterviews(jobId, detailLimit);
            fetched += r.fetched;
            upserted += r.upserted;
            detailsFetched += r.detailsFetched;
            detailsFailed += r.detailsFailed;
            if (r.hasInterviews) jobsWithInterviews += 1;
          } catch (err) {
            listFailed += 1;
            logger.warn(
              { jobId, err: (err as Error).message },
              "interview list fetch failed",
            );
          }
        }),
      ),
    );

    await finishSyncLog({
      id: logId,
      totalFetched: fetched,
      totalUpserted: upserted,
      totalFailed: listFailed + detailsFailed,
    });
    logger.info(
      {
        mode: opts.mode,
        jobsScanned: opts.jobIds.length,
        jobsWithInterviews,
        fetched,
        upserted,
        detailsFetched,
        detailsFailed,
        listFailed,
      },
      "syncInterviews done",
    );
    return {
      fetched,
      upserted,
      jobsScanned: opts.jobIds.length,
      jobsWithInterviews,
      detailsFetched,
      detailsFailed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await finishSyncLog({
      id: logId,
      totalFetched: fetched,
      totalUpserted: upserted,
      totalFailed: listFailed + detailsFailed,
      errorMessage: msg,
    });
    throw err;
  }
}

export async function syncInterviewsIncremental(): Promise<SyncInterviewsResult> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recent = await listJobIdsUpdatedSince(since);
  if (recent.length === 0) {
    logger.info("no recently-updated jobs, skipping interview incremental");
    return {
      fetched: 0,
      upserted: 0,
      jobsScanned: 0,
      jobsWithInterviews: 0,
      detailsFetched: 0,
      detailsFailed: 0,
    };
  }
  return syncInterviewsByJobIds({ mode: "incremental", jobIds: recent });
}

export async function syncInterviewsFull(): Promise<SyncInterviewsResult> {
  const all = await listAllJobIds();
  return syncInterviewsByJobIds({ mode: "reconcile", jobIds: all });
}
