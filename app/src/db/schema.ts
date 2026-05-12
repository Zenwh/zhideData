import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * 岗位主表。
 * id 直接复用 StepFun _id（24-hex），保持与上游对齐。
 */
export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  source: text("source").notNull().default("stepfun"),

  company: text("company"),
  companyIntro: text("company_intro"),
  position: text("position"),
  content: text("content"),

  workType: text("work_type"),
  positionType: text("position_type"),
  industry: text("industry"),

  workplace: text("workplace"),
  city: text("city"),
  cityList: text("city_list").array(),

  tagList: text("tag_list").array(),

  recommendation: boolean("recommendation"),
  recommendationContent: jsonb("recommendation_content"),

  eduRequirement: text("edu_requirement"),
  salary: text("salary"),
  hot: boolean("hot"),
  companyScale: text("company_scale"),
  imgUrl: text("img_url"),
  deliverChannel: text("deliver_channel"),

  explain: jsonb("explain"),

  upstreamUpdateTime: timestamp("upstream_update_time", { withTimezone: true }),

  status: smallint("status").notNull().default(0), // 0 normal / 1 offline

  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 面经主表。
 * content_raw 保存原始 JSON 字符串（StepFun 给的就是 string），content 是 parse 后的 jsonb，避免前端再 parse。
 */
export const interviews = pgTable("interviews", {
  id: text("id").primaryKey(),
  source: text("source").notNull().default("stepfun"),

  title: text("title"),
  briefTitle: text("brief_title"),
  briefIntro: text("brief_intro"),
  abstract: text("abstract"),

  company: text("company"),
  industry: text("industry"),
  city: text("city"),
  cityList: text("city_list").array(),

  positionType: text("position_type"),
  recruitmentTag: text("recruitment_tag"),

  jobId: text("job_id"),

  content: jsonb("content"),
  contentRaw: text("content_raw"),

  tags: text("tags").array(),
  entities: text("entities").array(),
  locations: text("locations").array(),
  images: text("images").array(),

  albumId: text("album_id"),
  author: text("author"),
  authorId: text("author_id"),
  domain: text("domain"),
  pageImage: text("page_image"),
  pageType: text("page_type"),
  contentType: text("content_type"),
  templateId: text("template_id"),
  templateType: text("template_type"),
  templateVersion: text("template_version"),

  auditStatus: smallint("audit_status"),
  deleteStatus: smallint("delete_status"),
  publicStatus: smallint("public_status"),
  publishStatus: smallint("publish_status"),

  upstreamCreateAt: timestamp("upstream_create_at", { withTimezone: true }),
  upstreamUpdateAt: timestamp("upstream_update_at", { withTimezone: true }),

  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * 同步审计。
 */
export const syncLogs = pgTable("sync_logs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(), // 'jobs' | 'interviews'
  mode: text("mode").notNull(), // 'bootstrap' | 'incremental' | 'reconcile' | 'manual'
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  watermarkBefore: timestamp("watermark_before", { withTimezone: true }),
  watermarkAfter: timestamp("watermark_after", { withTimezone: true }),
  totalFetched: integer("total_fetched").notNull().default(0),
  totalUpserted: integer("total_upserted").notNull().default(0),
  totalFailed: integer("total_failed").notNull().default(0),
  errorMessage: text("error_message"),
  meta: jsonb("meta"),
});
