import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client.js";
import { buildJobsWhere } from "@/routes/jobs.js";
import { buildInterviewsWhere } from "@/routes/interviews.js";

/**
 * One MCP tool definition. `inputSchema` is what we expose to clients
 * (JSON Schema, draft-07-ish — MCP doesn't really validate it, so we keep it
 * loose and DO validate inside the handler with zod). `parse` runs the zod
 * coercion + alias resolution and either returns parsed args or throws a
 * user-friendly error. `handler` returns the *inner* `data` payload that
 * goes under structuredContent.data.
 */
export interface ToolDef<P> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parse: (raw: unknown) => P;
  handler: (args: P) => Promise<unknown>;
}

/** Helper: build a JSON-schema-ish stub from a description for an optional string. */
function strField(description?: string): Record<string, unknown> {
  const f: Record<string, unknown> = { type: "string", minLength: 1 };
  if (description) f.description = description;
  return f;
}

/** Helper: required wrapper. */
function withRequired<T extends Record<string, unknown>>(
  properties: T,
  required: (keyof T)[],
): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
    required: required as string[],
  };
}

function noRequired<T extends Record<string, unknown>>(properties: T): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties,
  };
}

// =====================================================================
// account.entitlements
// =====================================================================
const accountEntitlementsTool: ToolDef<Record<string, never>> = {
  name: "account.entitlements",
  description: "查看当前 API Key 的访问权益与服务健康度（不收日额度）。",
  inputSchema: noRequired({}),
  parse: () => ({}),
  handler: async () => {
    const [jobsRow, interviewsRow, lastJobsRow, lastInterviewsRow] = await Promise.all([
      db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE status = 0`),
      db.execute(
        sql`SELECT count(*)::int AS n FROM interviews WHERE publish_status = 0 OR publish_status IS NULL`,
      ),
      db.execute(sql`
        SELECT finished_at FROM sync_logs
        WHERE kind = 'jobs' AND error_message IS NULL AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1
      `),
      db.execute(sql`
        SELECT finished_at FROM sync_logs
        WHERE kind = 'interviews' AND error_message IS NULL AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1
      `),
    ]);
    const num = (r: { rows: unknown[] }) => (r.rows[0] as { n?: number } | undefined)?.n ?? 0;
    const tsAt = (r: { rows: unknown[] }) =>
      (r.rows[0] as { finished_at?: Date | string | null } | undefined)?.finished_at ?? null;
    return {
      // shape diverges from offer-mcp-v2 on purpose: we don't sell unlocks/limits,
      // we surface dataset health instead.
      mcpDailyLimit: null,
      mcpUsedToday: null,
      mcpRemainingToday: null,
      catalog: {
        jobs: num(jobsRow),
        interviews: num(interviewsRow),
        lastJobsSyncAt: tsAt(lastJobsRow),
        lastInterviewsSyncAt: tsAt(lastInterviewsRow),
      },
      hasApiKey: true,
    };
  },
};

// =====================================================================
// jobs.search
// =====================================================================
const JobsSearchArgs = z
  .object({
    keyword: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    industry: z.string().min(1).optional(),
    positionType: z.string().min(1).optional(),
    workType: z.string().min(1).optional(),
    startTime: z.string().min(1).optional(),
    endTime: z.string().min(1).optional(),
    sortBy: z.enum(["relevance", "newest"]).default("relevance"),
    page: z.number().int().min(1).max(100).default(1),
    pageSize: z.number().int().min(1).max(100).default(10),
  })
  .strip();

type JobsSearchInput = z.infer<typeof JobsSearchArgs>;

interface JobRowOut {
  id: string;
  company: string | null;
  position: string | null;
  city: string | null;
  industry: string | null;
  positionType: string | null;
  workType: string | null;
  workplace: string | null;
  salary: string | null;
  companyScale: string | null;
  summary: string | null;
  hot: boolean | null;
  recommendation: boolean | null;
  publishedAt: string | null;
}

function mapJobRow(r: Record<string, unknown>): JobRowOut {
  const t = r as {
    id: string;
    company: string | null;
    position: string | null;
    city: string | null;
    industry: string | null;
    position_type: string | null;
    work_type: string | null;
    workplace: string | null;
    salary: string | null;
    company_scale: string | null;
    content: string | null;
    hot: boolean | null;
    recommendation: boolean | null;
    upstream_update_time: Date | string | null;
  };
  let pub: string | null = null;
  if (t.upstream_update_time instanceof Date) pub = t.upstream_update_time.toISOString();
  else if (typeof t.upstream_update_time === "string") pub = new Date(t.upstream_update_time).toISOString();
  return {
    id: t.id,
    company: t.company,
    position: t.position,
    city: t.city,
    industry: t.industry,
    positionType: t.position_type,
    workType: t.work_type,
    workplace: t.workplace,
    salary: t.salary,
    companyScale: t.company_scale,
    summary: t.content ? t.content.slice(0, 240) : null,
    hot: t.hot,
    recommendation: t.recommendation,
    publishedAt: pub,
  };
}

const jobsSearchTool: ToolDef<JobsSearchInput> = {
  name: "jobs.search",
  description:
    "检索岗位，支持 keyword/company/city/industry/positionType/workType 过滤；可选 startTime/endTime 按发布时间筛选（YYYY-MM-DD 或 ISO 时间）。",
  inputSchema: noRequired({
    keyword: strField(),
    company: strField(),
    city: strField(),
    industry: strField(),
    positionType: strField(),
    workType: strField(),
    startTime: strField("岗位发布时间下限（含）；例如 2026-05-01 或 2026-05-01T00:00:00+08:00。"),
    endTime: strField("岗位发布时间上限（含）；纯日期将被视为当日 23:59:59.999。"),
    sortBy: { type: "string", enum: ["relevance", "newest"], default: "relevance" },
    page: { type: "integer", minimum: 1, maximum: 100, default: 1 },
    pageSize: { type: "integer", minimum: 1, maximum: 100, default: 10 },
  }),
  parse: (raw) => JobsSearchArgs.parse(raw ?? {}),
  handler: async (a) => {
    // Map MCP-style camelCase args to our internal REST schema. The WHERE
    // builder accepts arrays for industry/positionType/city, but MCP exposes
    // single-value strings, so we wrap into one-element arrays.
    const where = buildJobsWhere({
      query: a.keyword,
      company: a.company,
      city: a.city ? [a.city] : undefined,
      industry: a.industry ? [a.industry] : undefined,
      position_type: a.positionType ? [a.positionType] : undefined,
      work_type: a.workType,
      start_time: a.startTime ? normalizeStart(a.startTime) : undefined,
      end_time: a.endTime ? normalizeEnd(a.endTime) : undefined,
    });

    const offset = (a.page - 1) * a.pageSize;

    let orderClause = sql`upstream_update_time DESC NULLS LAST, id DESC`;
    if (a.sortBy === "relevance" && a.keyword && a.keyword.trim()) {
      const q = `%${a.keyword.trim()}%`;
      orderClause = sql`(
        (CASE WHEN position ILIKE ${q} THEN 100 ELSE 0 END) +
        (CASE WHEN company  ILIKE ${q} THEN 80  ELSE 0 END) +
        (CASE WHEN industry ILIKE ${q} THEN 40  ELSE 0 END) +
        (CASE WHEN content  ILIKE ${q} THEN 20  ELSE 0 END)
      ) DESC, upstream_update_time DESC NULLS LAST, id DESC`;
    }

    const [countRes, listRes] = await Promise.all([
      db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE ${where}`),
      db.execute(sql`
        SELECT id, company, position, city, industry, position_type, work_type,
               workplace, salary, company_scale, content, hot, recommendation,
               upstream_update_time
        FROM jobs WHERE ${where}
        ORDER BY ${orderClause}
        LIMIT ${a.pageSize} OFFSET ${offset}
      `),
    ]);
    const total = (countRes.rows[0] as { n: number } | undefined)?.n ?? 0;
    return {
      query: {
        keyword: a.keyword,
        company: a.company,
        city: a.city,
        industry: a.industry,
        positionType: a.positionType,
        workType: a.workType,
        startTime: a.startTime,
        endTime: a.endTime,
        sortBy: a.sortBy,
      },
      page: a.page,
      pageSize: a.pageSize,
      total,
      items: listRes.rows.map((r) => mapJobRow(r as Record<string, unknown>)),
    };
  },
};

// =====================================================================
// jobs.facets
// =====================================================================
const JobsFacetsArgs = z
  .object({
    keyword: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    industry: z.string().min(1).optional(),
    positionType: z.string().min(1).optional(),
    workType: z.string().min(1).optional(),
    startTime: z.string().min(1).optional(),
    endTime: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(100).default(10),
  })
  .strip();
type JobsFacetsInput = z.infer<typeof JobsFacetsArgs>;

const jobsFacetsTool: ToolDef<JobsFacetsInput> = {
  name: "jobs.facets",
  description: "返回岗位筛选项聚合结果（positionTypes/cities/industries/workTypes/companies）。",
  inputSchema: noRequired({
    keyword: strField(),
    company: strField(),
    city: strField(),
    industry: strField(),
    positionType: strField(),
    workType: strField(),
    startTime: strField("岗位发布时间下限（含）"),
    endTime: strField("岗位发布时间上限（含），纯日期将被视为当日 23:59:59.999"),
    limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
  }),
  parse: (raw) => JobsFacetsArgs.parse(raw ?? {}),
  handler: async (a) => {
    const where = buildJobsWhere({
      query: a.keyword,
      company: a.company,
      city: a.city ? [a.city] : undefined,
      industry: a.industry ? [a.industry] : undefined,
      position_type: a.positionType ? [a.positionType] : undefined,
      work_type: a.workType,
      start_time: a.startTime ? normalizeStart(a.startTime) : undefined,
      end_time: a.endTime ? normalizeEnd(a.endTime) : undefined,
    });
    const lim = a.limit;

    const [total, positionTypes, cities, industries, workTypes, companies] = await Promise.all([
      db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE ${where}`),
      db.execute(sql`
        SELECT position_type AS value, count(*)::int AS count
        FROM jobs WHERE ${where} AND position_type IS NOT NULL
        GROUP BY position_type ORDER BY count DESC, value ASC LIMIT ${lim}
      `),
      db.execute(sql`
        SELECT city AS value, count(*)::int AS count
        FROM jobs WHERE ${where} AND city IS NOT NULL
        GROUP BY city ORDER BY count DESC, value ASC LIMIT ${lim}
      `),
      db.execute(sql`
        SELECT industry AS value, count(*)::int AS count
        FROM jobs WHERE ${where} AND industry IS NOT NULL
        GROUP BY industry ORDER BY count DESC, value ASC LIMIT ${lim}
      `),
      db.execute(sql`
        SELECT work_type AS value, count(*)::int AS count
        FROM jobs WHERE ${where} AND work_type IS NOT NULL
        GROUP BY work_type ORDER BY count DESC, value ASC LIMIT ${lim}
      `),
      db.execute(sql`
        SELECT company AS value, count(*)::int AS count
        FROM jobs WHERE ${where} AND company IS NOT NULL
        GROUP BY company ORDER BY count DESC, value ASC LIMIT ${lim}
      `),
    ]);
    return {
      total: (total.rows[0] as { n: number } | undefined)?.n ?? 0,
      facets: {
        positionTypes: positionTypes.rows,
        cities: cities.rows,
        industries: industries.rows,
        workTypes: workTypes.rows,
        companies: companies.rows,
      },
    };
  },
};

// =====================================================================
// jobs.get / jobs.batch_get
// =====================================================================
const JobsGetArgs = z.object({ id: z.string().min(1) });
const jobsGetTool: ToolDef<z.infer<typeof JobsGetArgs>> = {
  name: "jobs.get",
  description: "获取岗位详情。",
  inputSchema: withRequired({ id: strField() }, ["id"]),
  parse: (raw) => JobsGetArgs.parse(raw ?? {}),
  handler: async (a) => {
    const r = await db.execute(sql`SELECT * FROM jobs WHERE id = ${a.id} LIMIT 1`);
    if (r.rows.length === 0) {
      const err = new ToolUserError(`job not found: ${a.id}`);
      throw err;
    }
    return r.rows[0];
  },
};

const IdsField = z.union([
  z
    .array(z.string().min(1))
    .min(1)
    .max(5),
  z.string().min(1),
]);
function parseIds(raw: unknown): string[] {
  const parsed = IdsField.parse(raw);
  const ids = Array.isArray(parsed)
    ? parsed
    : parsed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  if (ids.length === 0 || ids.length > 5) {
    throw new ToolUserError(`ids must be 1-5 items, got ${ids.length}`);
  }
  return ids;
}

const JobsBatchGetArgs = z.object({ ids: z.unknown() });
const jobsBatchGetTool: ToolDef<{ ids: string[] }> = {
  name: "jobs.batch_get",
  description: "批量获取岗位详情（1-5 个 ID，数组或逗号分隔字符串）。",
  inputSchema: withRequired(
    {
      ids: {
        anyOf: [
          { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
          { type: "string", minLength: 1, description: "多个 ID 逗号分隔，最多 5 个" },
        ],
        description: "1-5 个 ID，可以是字符串数组或逗号分隔字符串",
      },
    },
    ["ids"],
  ),
  parse: (raw) => {
    const obj = (raw ?? {}) as Record<string, unknown>;
    return { ids: parseIds(obj.ids) };
  },
  handler: async ({ ids }) => {
    const r = await db.execute(sql`SELECT * FROM jobs WHERE id = ANY(${sql.param(ids)})`);
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of r.rows) {
      const id = (row as { id: string }).id;
      byId.set(id, row as Record<string, unknown>);
    }
    return { items: ids.map((id) => byId.get(id) ?? { id, _missing: true }) };
  },
};

// =====================================================================
// interviews.search
// =====================================================================
const InterviewsSearchArgs = z
  .object({
    query: z.string().min(1).optional(),
    positionQuery: z.string().min(1).optional(),
    position_query: z.string().min(1).optional(),
    jobId: z.string().min(1).optional(),
    job_id: z.string().min(1).optional(),
    jobIds: z.string().min(1).optional(),
    job_ids: z.string().min(1).optional(),
    company: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    recruitmentTag: z.string().min(1).optional(),
    recruitment_tag: z.string().min(1).optional(),
    industry: z.string().min(1).optional(),
    positionType: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strip();
type InterviewsSearchInput = z.infer<typeof InterviewsSearchArgs>;

const interviewsSearchTool: ToolDef<InterviewsSearchInput> = {
  name: "interviews.search",
  description:
    "检索面经列表。支持 jobIds/jobId 精确查询；也支持 query/positionQuery 模糊检索。",
  inputSchema: noRequired({
    query: strField("优先使用的面经检索词。"),
    positionQuery: strField("position_query 的 camelCase 别名。"),
    position_query: strField("position_query 字段。"),
    jobId: strField("单个岗位 ID 的 camelCase 别名。"),
    job_id: strField("单个岗位 ID。"),
    jobIds: strField("多个岗位 ID，逗号分隔。"),
    job_ids: strField("多个岗位 ID，逗号分隔。"),
    company: strField(),
    city: strField(),
    recruitmentTag: strField("招聘标签的 camelCase 别名。"),
    recruitment_tag: strField("招聘标签，如校招/实习/社招。"),
    industry: strField(),
    positionType: strField(),
    limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
  }),
  parse: (raw) => InterviewsSearchArgs.parse(raw ?? {}),
  handler: async (a) => {
    // Resolve aliases (camelCase/snake_case/singular/plural).
    const positionQuery = a.query ?? a.positionQuery ?? a.position_query;
    const jobIdsRaw = a.jobIds ?? a.job_ids;
    const singleJobId = a.jobId ?? a.job_id;
    const recruitmentTag = a.recruitmentTag ?? a.recruitment_tag;

    // Reject "no filter at all" queries (matches REST behavior — prevents an
    // unfiltered ORDER BY upstream_create_at scan from being a public DoS knob).
    if (!positionQuery && !singleJobId && !jobIdsRaw && !a.company) {
      throw new ToolUserError(
        "interviews.search needs at least one of: query/positionQuery, jobId/jobIds, company",
      );
    }

    // jobIds (multiple) overrides single jobId. Multiple jobIds is fast — same
    // btree job_id index, just `IN (...)` instead of `=`.
    let jobIdFilter: string[] | null = null;
    if (jobIdsRaw) {
      jobIdFilter = jobIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (jobIdFilter.length === 0) jobIdFilter = null;
    } else if (singleJobId) {
      jobIdFilter = [singleJobId];
    }

    // Build base WHERE using REST helper for everything except jobIds (which
    // is a list semantic the REST endpoint doesn't expose).
    const baseWhere = buildInterviewsWhere({
      position_query: positionQuery,
      job_id: jobIdFilter && jobIdFilter.length === 1 ? jobIdFilter[0] : undefined,
      company: a.company,
      recruitment_tag: recruitmentTag,
      city: a.city,
      position_type: a.positionType ? [a.positionType] : undefined,
    });
    const where =
      jobIdFilter && jobIdFilter.length > 1
        ? sql`${baseWhere} AND job_id = ANY(${sql.param(jobIdFilter)})`
        : baseWhere;

    let orderClause = sql`upstream_create_at DESC NULLS LAST, id DESC`;
    if (positionQuery && positionQuery.trim()) {
      const q = `%${positionQuery.trim()}%`;
      orderClause = sql`(
        (CASE WHEN title       ILIKE ${q} THEN 100 ELSE 0 END) +
        (CASE WHEN brief_title ILIKE ${q} THEN 80  ELSE 0 END) +
        (CASE WHEN brief_intro ILIKE ${q} THEN 40  ELSE 0 END) +
        (CASE WHEN company     ILIKE ${q} THEN 30  ELSE 0 END)
      ) DESC, upstream_create_at DESC NULLS LAST, id DESC`;
    }

    const r = await db.execute(sql`
      SELECT id, title, brief_title, brief_intro, company, city, position_type,
             recruitment_tag, job_id, tags, upstream_create_at
      FROM interviews WHERE ${where}
      ORDER BY ${orderClause}
      LIMIT ${a.limit + 1}
    `);
    const items = r.rows.slice(0, a.limit).map((row) => {
      const t = row as {
        id: string;
        title: string | null;
        brief_title: string | null;
        brief_intro: string | null;
        company: string | null;
        city: string | null;
        position_type: string | null;
        recruitment_tag: string | null;
        job_id: string | null;
        tags: string[] | null;
        upstream_create_at: Date | string | null;
      };
      let pub: string | null = null;
      if (t.upstream_create_at instanceof Date) pub = t.upstream_create_at.toISOString();
      else if (typeof t.upstream_create_at === "string")
        pub = new Date(t.upstream_create_at).toISOString();
      return {
        id: t.id,
        title: t.title,
        briefTitle: t.brief_title,
        summary: t.brief_intro,
        company: t.company,
        city: t.city,
        positionType: t.position_type,
        recruitmentTag: t.recruitment_tag,
        jobId: t.job_id,
        tags: t.tags ?? [],
        publishedAt: pub,
      };
    });
    return {
      query: { positionQuery, jobIds: jobIdFilter, company: a.company },
      limit: a.limit,
      hasMore: r.rows.length > a.limit,
      items,
    };
  },
};

// =====================================================================
// interviews.get / interviews.batch_get
// =====================================================================
const interviewsGetTool: ToolDef<{ id: string }> = {
  name: "interviews.get",
  description: "获取面经详情。",
  inputSchema: withRequired({ id: strField() }, ["id"]),
  parse: (raw) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return { id: z.string().min(1).parse(o.id) };
  },
  handler: async ({ id }) => {
    const r = await db.execute(sql`SELECT * FROM interviews WHERE id = ${id} LIMIT 1`);
    if (r.rows.length === 0) throw new ToolUserError(`interview not found: ${id}`);
    return r.rows[0];
  },
};

const interviewsBatchGetTool: ToolDef<{ ids: string[] }> = {
  name: "interviews.batch_get",
  description: "批量获取面经详情（1-5 个 ID）。",
  inputSchema: withRequired(
    {
      ids: {
        anyOf: [
          { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 5 },
          { type: "string", minLength: 1, description: "多个 ID 逗号分隔，最多 5 个" },
        ],
        description: "1-5 个 ID，可以是字符串数组或逗号分隔字符串",
      },
    },
    ["ids"],
  ),
  parse: (raw) => {
    const obj = (raw ?? {}) as Record<string, unknown>;
    return { ids: parseIds(obj.ids) };
  },
  handler: async ({ ids }) => {
    const r = await db.execute(sql`SELECT * FROM interviews WHERE id = ANY(${sql.param(ids)})`);
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of r.rows) {
      const id = (row as { id: string }).id;
      byId.set(id, row as Record<string, unknown>);
    }
    return { items: ids.map((id) => byId.get(id) ?? { id, _missing: true }) };
  },
};

// =====================================================================
// Helpers + Registry
// =====================================================================

/**
 * Errors meant to be shown back to the MCP caller verbatim (jsonrpc error or
 * isError content). Anything else thrown will be logged and surfaced as an
 * opaque internal error.
 */
export class ToolUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolUserError";
  }
}

/**
 * MCP exposes startTime/endTime as "2026-05-01" or full ISO. Postgres can take
 * either via timestamptz cast, but we lift "date-only" to inclusive day bounds
 * to match the documented behavior.
 */
function normalizeStart(s: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00+08:00` : s;
}
function normalizeEnd(s: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T23:59:59.999+08:00` : s;
}

export const TOOLS: ToolDef<unknown>[] = [
  accountEntitlementsTool,
  jobsSearchTool,
  jobsFacetsTool,
  jobsGetTool,
  jobsBatchGetTool,
  interviewsSearchTool,
  interviewsGetTool,
  interviewsBatchGetTool,
] as unknown as ToolDef<unknown>[];

export const TOOLS_BY_NAME = new Map<string, ToolDef<unknown>>(
  TOOLS.map((t) => [t.name, t]),
);
