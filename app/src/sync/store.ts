import { sql } from "drizzle-orm";

import { db } from "@/db/client.js";
import { jobs, interviews, syncLogs } from "@/db/schema.js";
import type { JobRow, InterviewRow } from "@/adapters/mappers.js";

/**
 * 用 ON CONFLICT 语义 upsert 一批岗位。
 * 只在 upstream_update_time 更新或字段变化时覆盖；旧版本不覆盖新版本（按 NULL-safe 比较）。
 */
export async function upsertJobs(rows: JobRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db
    .insert(jobs)
    .values(rows)
    .onConflictDoUpdate({
      target: jobs.id,
      set: {
        source: sql`excluded.source`,
        company: sql`excluded.company`,
        companyIntro: sql`excluded.company_intro`,
        position: sql`excluded.position`,
        content: sql`excluded.content`,
        workType: sql`excluded.work_type`,
        positionType: sql`excluded.position_type`,
        industry: sql`excluded.industry`,
        workplace: sql`excluded.workplace`,
        city: sql`excluded.city`,
        cityList: sql`excluded.city_list`,
        tagList: sql`excluded.tag_list`,
        recommendation: sql`excluded.recommendation`,
        recommendationContent: sql`excluded.recommendation_content`,
        eduRequirement: sql`excluded.edu_requirement`,
        salary: sql`excluded.salary`,
        hot: sql`excluded.hot`,
        companyScale: sql`excluded.company_scale`,
        imgUrl: sql`excluded.img_url`,
        deliverChannel: sql`excluded.deliver_channel`,
        explain: sql`excluded.explain`,
        upstreamUpdateTime: sql`excluded.upstream_update_time`,
        status: sql`excluded.status`,
        raw: sql`excluded.raw`,
        updatedAt: sql`now()`,
      },
      setWhere: sql`(${jobs.upstreamUpdateTime} IS NULL OR excluded.upstream_update_time IS NULL OR excluded.upstream_update_time >= ${jobs.upstreamUpdateTime})`,
    });
  return result.rowCount ?? rows.length;
}

export async function upsertInterviews(rows: InterviewRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await db
    .insert(interviews)
    .values(rows)
    .onConflictDoUpdate({
      target: interviews.id,
      set: {
        source: sql`excluded.source`,
        title: sql`excluded.title`,
        briefTitle: sql`excluded.brief_title`,
        briefIntro: sql`excluded.brief_intro`,
        abstract: sql`excluded.abstract`,
        company: sql`excluded.company`,
        industry: sql`excluded.industry`,
        city: sql`excluded.city`,
        cityList: sql`excluded.city_list`,
        positionType: sql`excluded.position_type`,
        recruitmentTag: sql`excluded.recruitment_tag`,
        jobId: sql`excluded.job_id`,
        content: sql`excluded.content`,
        contentRaw: sql`excluded.content_raw`,
        tags: sql`excluded.tags`,
        entities: sql`excluded.entities`,
        locations: sql`excluded.locations`,
        images: sql`excluded.images`,
        albumId: sql`excluded.album_id`,
        author: sql`excluded.author`,
        authorId: sql`excluded.author_id`,
        domain: sql`excluded.domain`,
        pageImage: sql`excluded.page_image`,
        pageType: sql`excluded.page_type`,
        contentType: sql`excluded.content_type`,
        templateId: sql`excluded.template_id`,
        templateType: sql`excluded.template_type`,
        templateVersion: sql`excluded.template_version`,
        auditStatus: sql`excluded.audit_status`,
        deleteStatus: sql`excluded.delete_status`,
        publicStatus: sql`excluded.public_status`,
        publishStatus: sql`excluded.publish_status`,
        upstreamCreateAt: sql`excluded.upstream_create_at`,
        upstreamUpdateAt: sql`excluded.upstream_update_at`,
        raw: sql`excluded.raw`,
        updatedAt: sql`now()`,
      },
    });
  return result.rowCount ?? rows.length;
}

export interface SyncLogStartArgs {
  kind: "jobs" | "interviews";
  mode: "bootstrap" | "incremental" | "reconcile" | "manual";
  watermarkBefore?: Date | null;
  meta?: Record<string, unknown>;
}

export async function startSyncLog(args: SyncLogStartArgs): Promise<number> {
  const [row] = await db
    .insert(syncLogs)
    .values({
      kind: args.kind,
      mode: args.mode,
      watermarkBefore: args.watermarkBefore ?? null,
      meta: args.meta ?? null,
    })
    .returning({ id: syncLogs.id });
  return row!.id;
}

export interface SyncLogFinishArgs {
  id: number;
  totalFetched: number;
  totalUpserted: number;
  totalFailed?: number;
  watermarkAfter?: Date | null;
  errorMessage?: string | null;
}

export async function finishSyncLog(args: SyncLogFinishArgs): Promise<void> {
  await db
    .update(syncLogs)
    .set({
      finishedAt: sql`now()`,
      totalFetched: args.totalFetched,
      totalUpserted: args.totalUpserted,
      totalFailed: args.totalFailed ?? 0,
      watermarkAfter: args.watermarkAfter ?? null,
      errorMessage: args.errorMessage ?? null,
    })
    .where(sql`${syncLogs.id} = ${args.id}`);
}

export async function getLastSuccessfulWatermark(
  kind: "jobs" | "interviews",
): Promise<Date | null> {
  const result = await db.execute(sql`
    SELECT watermark_after
    FROM sync_logs
    WHERE kind = ${kind}
      AND error_message IS NULL
      AND finished_at IS NOT NULL
      AND watermark_after IS NOT NULL
    ORDER BY finished_at DESC
    LIMIT 1
  `);
  const row = (result.rows[0] ?? null) as { watermark_after: Date | null } | null;
  return row?.watermark_after ?? null;
}

export async function listJobIdsUpdatedSince(since: Date): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT id FROM jobs
    WHERE upstream_update_time IS NOT NULL AND upstream_update_time >= ${since}
    ORDER BY upstream_update_time DESC
  `);
  return result.rows.map((r) => (r as { id: string }).id);
}

export async function listAllJobIds(): Promise<string[]> {
  const result = await db.execute(sql`SELECT id FROM jobs`);
  return result.rows.map((r) => (r as { id: string }).id);
}

/**
 * Job IDs that have no interview row yet — used to make a full reconcile resumable.
 * Order: most-recently-updated first, since newer jobs are more likely to have interviews.
 */
export async function listJobIdsWithoutInterviews(): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT j.id FROM jobs j
    LEFT JOIN interviews i ON i.job_id = j.id
    WHERE i.id IS NULL
    GROUP BY j.id, j.upstream_update_time
    ORDER BY j.upstream_update_time DESC NULLS LAST, j.id
  `);
  return result.rows.map((r) => (r as { id: string }).id);
}
