CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'stepfun' NOT NULL,
	"company" text,
	"company_intro" text,
	"position" text,
	"content" text,
	"work_type" text,
	"position_type" text,
	"industry" text,
	"workplace" text,
	"city" text,
	"city_list" text[],
	"tag_list" text[],
	"recommendation" boolean,
	"recommendation_content" jsonb,
	"edu_requirement" text,
	"salary" text,
	"hot" boolean,
	"company_scale" text,
	"img_url" text,
	"deliver_channel" text,
	"explain" jsonb,
	"upstream_update_time" timestamp with time zone,
	"status" smallint DEFAULT 0 NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text DEFAULT 'stepfun' NOT NULL,
	"title" text,
	"brief_title" text,
	"brief_intro" text,
	"abstract" text,
	"company" text,
	"industry" text,
	"city" text,
	"city_list" text[],
	"position_type" text,
	"recruitment_tag" text,
	"job_id" text,
	"content" jsonb,
	"content_raw" text,
	"tags" text[],
	"entities" text[],
	"locations" text[],
	"images" text[],
	"album_id" text,
	"author" text,
	"author_id" text,
	"domain" text,
	"page_image" text,
	"page_type" text,
	"content_type" text,
	"template_id" text,
	"template_type" text,
	"template_version" text,
	"audit_status" smallint,
	"delete_status" smallint,
	"public_status" smallint,
	"publish_status" smallint,
	"upstream_create_at" timestamp with time zone,
	"upstream_update_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"watermark_before" timestamp with time zone,
	"watermark_after" timestamp with time zone,
	"total_fetched" integer DEFAULT 0 NOT NULL,
	"total_upserted" integer DEFAULT 0 NOT NULL,
	"total_failed" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"meta" jsonb
);
--> statement-breakpoint
-- jobs indexes
CREATE INDEX "jobs_upstream_update_time_desc_idx" ON "jobs" ("upstream_update_time" DESC NULLS LAST);
CREATE INDEX "jobs_company_trgm_idx" ON "jobs" USING gin ("company" gin_trgm_ops);
CREATE INDEX "jobs_position_trgm_idx" ON "jobs" USING gin ("position" gin_trgm_ops);
CREATE INDEX "jobs_content_trgm_idx" ON "jobs" USING gin ("content" gin_trgm_ops);
CREATE INDEX "jobs_city_idx" ON "jobs" ("city");
CREATE INDEX "jobs_city_list_gin_idx" ON "jobs" USING gin ("city_list");
CREATE INDEX "jobs_position_type_idx" ON "jobs" ("position_type");
CREATE INDEX "jobs_work_type_idx" ON "jobs" ("work_type");
CREATE INDEX "jobs_industry_idx" ON "jobs" ("industry");
CREATE INDEX "jobs_tag_list_gin_idx" ON "jobs" USING gin ("tag_list");
CREATE INDEX "jobs_status_idx" ON "jobs" ("status");
--> statement-breakpoint
-- interviews indexes
CREATE INDEX "interviews_upstream_create_at_desc_idx" ON "interviews" ("upstream_create_at" DESC NULLS LAST);
CREATE INDEX "interviews_job_id_idx" ON "interviews" ("job_id");
CREATE INDEX "interviews_company_trgm_idx" ON "interviews" USING gin ("company" gin_trgm_ops);
CREATE INDEX "interviews_title_trgm_idx" ON "interviews" USING gin ("title" gin_trgm_ops);
CREATE INDEX "interviews_brief_title_trgm_idx" ON "interviews" USING gin ("brief_title" gin_trgm_ops);
CREATE INDEX "interviews_position_type_idx" ON "interviews" ("position_type");
CREATE INDEX "interviews_recruitment_tag_idx" ON "interviews" ("recruitment_tag");
CREATE INDEX "interviews_city_idx" ON "interviews" ("city");
CREATE INDEX "interviews_city_list_gin_idx" ON "interviews" USING gin ("city_list");
CREATE INDEX "interviews_publish_status_idx" ON "interviews" ("publish_status");
--> statement-breakpoint
-- sync_logs indexes
CREATE INDEX "sync_logs_kind_started_at_idx" ON "sync_logs" ("kind", "started_at" DESC);
