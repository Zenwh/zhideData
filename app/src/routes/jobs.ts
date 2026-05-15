import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client.js";

const JobsSearchSchema = z.object({
  query: z.string().optional(),
  company: z.string().optional(),
  position: z.string().optional(),
  work_type: z.string().optional(),
  industry: z.array(z.string()).optional(),
  position_type: z.array(z.string()).optional(),
  city: z.array(z.string()).optional(),
  recommendation: z.enum(["true", "false", ""]).optional(),
  hot: z.boolean().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  sort_by: z.enum(["relevance", "newest"]).default("relevance"),
  page: z.number().int().positive().default(1),
  page_size: z.number().int().min(1).max(100).default(20),
});

type JobsFilters = z.infer<typeof JobsSearchSchema>;

const JobsFacetsSchema = z.object({
  query: z.string().optional(),
  company: z.string().optional(),
  position: z.string().optional(),
  work_type: z.string().optional(),
  industry: z.array(z.string()).optional(),
  position_type: z.array(z.string()).optional(),
  city: z.array(z.string()).optional(),
  recommendation: z.enum(["true", "false", ""]).optional(),
  hot: z.boolean().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

/**
 * Build the WHERE clause shared by /jobs/search and /jobs/facets. Note the
 * facets endpoint typically wants the same filter set so users see counts of
 * what's available under their current refinement.
 */
function buildJobsWhere(
  f: Pick<
    JobsFilters,
    | "query"
    | "company"
    | "position"
    | "work_type"
    | "industry"
    | "position_type"
    | "city"
    | "recommendation"
    | "hot"
    | "start_time"
    | "end_time"
  >,
): ReturnType<typeof sql> {
  const conditions: ReturnType<typeof sql>[] = [sql`status = 0`];

  if (f.query && f.query.trim()) {
    const q = `%${f.query.trim()}%`;
    conditions.push(sql`(company ILIKE ${q} OR position ILIKE ${q} OR content ILIKE ${q})`);
  }
  if (f.company && f.company.trim()) {
    conditions.push(sql`company ILIKE ${`%${f.company.trim()}%`}`);
  }
  if (f.position && f.position.trim()) {
    conditions.push(sql`position ILIKE ${`%${f.position.trim()}%`}`);
  }
  if (f.work_type) {
    conditions.push(sql`work_type = ${f.work_type}`);
  }
  if (f.industry && f.industry.length) {
    conditions.push(sql`industry = ANY(${f.industry})`);
  }
  if (f.position_type && f.position_type.length) {
    conditions.push(sql`position_type = ANY(${f.position_type})`);
  }
  if (f.city && f.city.length) {
    conditions.push(sql`(city = ANY(${f.city}) OR city_list && ${f.city})`);
  }
  if (f.recommendation === "true") {
    conditions.push(sql`recommendation = true`);
  } else if (f.recommendation === "false") {
    conditions.push(sql`recommendation = false`);
  }
  if (typeof f.hot === "boolean") {
    conditions.push(sql`hot = ${f.hot}`);
  }
  if (f.start_time) {
    conditions.push(sql`upstream_update_time >= ${f.start_time}`);
  }
  if (f.end_time) {
    conditions.push(sql`upstream_update_time <= ${f.end_time}`);
  }

  return conditions.reduce(
    (acc, c, idx) => (idx === 0 ? c : sql`${acc} AND ${c}`),
    sql`true`,
  );
}

export function registerJobRoutes(app: FastifyInstance) {
  app.post("/v1/jobs/search", async (req, reply) => {
    const parsed = JobsSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ code: 400, message: "invalid body", errors: parsed.error.flatten() });
      return;
    }
    const f = parsed.data;

    const whereClause = buildJobsWhere(f);

    const offset = (f.page - 1) * f.page_size;

    const [countRow] = (
      await db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE ${whereClause}`)
    ).rows as unknown as Array<{ n: number }>;
    const total = countRow?.n ?? 0;

    // Relevance scoring: weighted matches on the query string, falling back to
    // upstream_update_time. Mirrors the "setweight A/B/C" idea but using trigram
    // ILIKE since we already have those indexes (and no FTS).
    // If sort_by=newest or no query, this collapses to pure time-desc.
    let orderClause = sql`upstream_update_time DESC NULLS LAST, id DESC`;
    if (f.sort_by === "relevance" && f.query && f.query.trim()) {
      const q = `%${f.query.trim()}%`;
      orderClause = sql`(
        (CASE WHEN position ILIKE ${q} THEN 100 ELSE 0 END) +
        (CASE WHEN company  ILIKE ${q} THEN 80  ELSE 0 END) +
        (CASE WHEN industry ILIKE ${q} THEN 40  ELSE 0 END) +
        (CASE WHEN content  ILIKE ${q} THEN 20  ELSE 0 END)
      ) DESC, upstream_update_time DESC NULLS LAST, id DESC`;
    }

    const listRes = await db.execute(sql`
      SELECT
        id, source, company, company_intro, position, content,
        work_type, position_type, industry, workplace, city, city_list,
        tag_list, recommendation, recommendation_content,
        edu_requirement, salary, hot, company_scale, img_url, deliver_channel,
        explain, upstream_update_time, status, created_at, updated_at
      FROM jobs
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ${f.page_size} OFFSET ${offset}
    `);

    reply.send({
      code: 0,
      message: "ok",
      data: {
        page: f.page,
        page_size: f.page_size,
        total,
        has_more: offset + listRes.rows.length < total,
        items: listRes.rows,
      },
    });
  });

  app.post("/v1/jobs/facets", async (req, reply) => {
    const parsed = JobsFacetsSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ code: 400, message: "invalid body", errors: parsed.error.flatten() });
      return;
    }
    const f = parsed.data;
    const whereClause = buildJobsWhere(f);
    const lim = f.limit;

    // Run all five aggregations in parallel. Group-by on indexed text columns
    // takes 10-30ms each on the current dataset, so the total wallclock is
    // bounded by the slowest one — well under 100ms.
    const [total, positionTypes, cities, industries, workTypes, companies] =
      await Promise.all([
        db.execute(sql`SELECT count(*)::int AS n FROM jobs WHERE ${whereClause}`),
        db.execute(sql`
          SELECT position_type AS value, count(*)::int AS count
          FROM jobs WHERE ${whereClause} AND position_type IS NOT NULL
          GROUP BY position_type ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT city AS value, count(*)::int AS count
          FROM jobs WHERE ${whereClause} AND city IS NOT NULL
          GROUP BY city ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT industry AS value, count(*)::int AS count
          FROM jobs WHERE ${whereClause} AND industry IS NOT NULL
          GROUP BY industry ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT work_type AS value, count(*)::int AS count
          FROM jobs WHERE ${whereClause} AND work_type IS NOT NULL
          GROUP BY work_type ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT company AS value, count(*)::int AS count
          FROM jobs WHERE ${whereClause} AND company IS NOT NULL
          GROUP BY company ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
      ]);

    const totalN = (total.rows[0] as { n: number } | undefined)?.n ?? 0;

    reply.send({
      code: 0,
      message: "ok",
      data: {
        total: totalN,
        facets: {
          positionTypes: positionTypes.rows,
          cities: cities.rows,
          industries: industries.rows,
          workTypes: workTypes.rows,
          companies: companies.rows,
        },
      },
    });
  });

  app.get<{ Params: { id: string } }>("/v1/jobs/:id", async (req, reply) => {
    const { id } = req.params;
    const res = await db.execute(sql`
      SELECT * FROM jobs WHERE id = ${id} LIMIT 1
    `);
    if (res.rows.length === 0) {
      reply.code(404).send({ code: 404, message: "job not found" });
      return;
    }
    reply.send({ code: 0, message: "ok", data: res.rows[0] });
  });
}
