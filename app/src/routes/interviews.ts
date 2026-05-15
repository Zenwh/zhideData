import { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db/client.js";

const InterviewsSearchSchema = z.object({
  position_query: z.string().optional(),
  job_id: z.string().optional(),
  company: z.string().optional(),
  recruitment_tag: z.string().optional(),
  city: z.string().optional(),
  position_type: z.array(z.string()).optional(),
  sort_by: z.enum(["relevance", "newest"]).default("relevance"),
  limit: z.number().int().min(1).max(50).default(10),
  page: z.number().int().positive().default(1),
});

type InterviewsFilters = z.infer<typeof InterviewsSearchSchema>;

const InterviewsFacetsSchema = z.object({
  position_query: z.string().optional(),
  job_id: z.string().optional(),
  company: z.string().optional(),
  recruitment_tag: z.string().optional(),
  city: z.string().optional(),
  position_type: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

/**
 * WHERE shared by /interviews/search and /interviews/facets.
 *
 * Differs from jobs in one important way: /search REQUIRES at least one of
 * position_query / job_id / company (to keep general "show me everything"
 * queries off the slow path). /facets has no such requirement — empty filters
 * just return the full catalog breakdown.
 */
function buildInterviewsWhere(
  f: Pick<
    InterviewsFilters,
    "position_query" | "job_id" | "company" | "recruitment_tag" | "city" | "position_type"
  >,
): ReturnType<typeof sql> {
  const conditions: ReturnType<typeof sql>[] = [
    sql`(publish_status = 0 OR publish_status IS NULL)`,
  ];

  if (f.job_id) {
    conditions.push(sql`job_id = ${f.job_id}`);
  }
  if (f.position_query && f.position_query.trim()) {
    const q = `%${f.position_query.trim()}%`;
    conditions.push(
      sql`(title ILIKE ${q} OR brief_title ILIKE ${q} OR brief_intro ILIKE ${q})`,
    );
  }
  if (f.company && f.company.trim()) {
    conditions.push(sql`company ILIKE ${`%${f.company.trim()}%`}`);
  }
  if (f.recruitment_tag) {
    conditions.push(sql`recruitment_tag = ${f.recruitment_tag}`);
  }
  if (f.city && f.city.trim()) {
    conditions.push(sql`(city = ${f.city} OR ${f.city} = ANY(city_list))`);
  }
  if (f.position_type && f.position_type.length) {
    conditions.push(sql`position_type = ANY(${f.position_type})`);
  }

  return conditions.reduce(
    (acc, c, idx) => (idx === 0 ? c : sql`${acc} AND ${c}`),
    sql`true`,
  );
}

export function registerInterviewRoutes(app: FastifyInstance) {
  app.post("/v1/interviews/search", async (req, reply) => {
    const parsed = InterviewsSearchSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ code: 400, message: "invalid body", errors: parsed.error.flatten() });
      return;
    }
    const f = parsed.data;

    if (!f.position_query && !f.job_id && !f.company) {
      reply.code(400).send({
        code: 400,
        message: "one of position_query / job_id / company is required",
      });
      return;
    }

    const whereClause = buildInterviewsWhere(f);

    const offset = (f.page - 1) * f.limit;

    // Relevance for interviews: title > brief_title > brief_intro > company,
    // falling back to upstream_create_at when sort_by=newest or no query.
    let orderClause = sql`upstream_create_at DESC NULLS LAST, id DESC`;
    if (f.sort_by === "relevance" && f.position_query && f.position_query.trim()) {
      const q = `%${f.position_query.trim()}%`;
      orderClause = sql`(
        (CASE WHEN title       ILIKE ${q} THEN 100 ELSE 0 END) +
        (CASE WHEN brief_title ILIKE ${q} THEN 80  ELSE 0 END) +
        (CASE WHEN brief_intro ILIKE ${q} THEN 40  ELSE 0 END) +
        (CASE WHEN company     ILIKE ${q} THEN 30  ELSE 0 END)
      ) DESC, upstream_create_at DESC NULLS LAST, id DESC`;
    }

    const res = await db.execute(sql`
      SELECT
        id, title, brief_title, brief_intro, company, industry, city, city_list,
        position_type, recruitment_tag, job_id,
        tags, entities, upstream_create_at
      FROM interviews
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ${f.limit + 1} OFFSET ${offset}
    `);

    const items = res.rows.slice(0, f.limit);
    const hasMore = res.rows.length > f.limit;

    reply.send({
      code: 0,
      message: "ok",
      data: {
        items,
        has_more: hasMore,
        page: f.page,
        limit: f.limit,
      },
    });
  });

  app.post("/v1/interviews/facets", async (req, reply) => {
    const parsed = InterviewsFacetsSchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ code: 400, message: "invalid body", errors: parsed.error.flatten() });
      return;
    }
    const f = parsed.data;
    const whereClause = buildInterviewsWhere(f);
    const lim = f.limit;

    const [total, positionTypes, cities, industries, recruitmentTags, companies] =
      await Promise.all([
        db.execute(sql`SELECT count(*)::int AS n FROM interviews WHERE ${whereClause}`),
        db.execute(sql`
          SELECT position_type AS value, count(*)::int AS count
          FROM interviews WHERE ${whereClause} AND position_type IS NOT NULL
          GROUP BY position_type ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT city AS value, count(*)::int AS count
          FROM interviews WHERE ${whereClause} AND city IS NOT NULL
          GROUP BY city ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT industry AS value, count(*)::int AS count
          FROM interviews WHERE ${whereClause} AND industry IS NOT NULL
          GROUP BY industry ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT recruitment_tag AS value, count(*)::int AS count
          FROM interviews WHERE ${whereClause} AND recruitment_tag IS NOT NULL
          GROUP BY recruitment_tag ORDER BY count DESC, value ASC LIMIT ${lim}
        `),
        db.execute(sql`
          SELECT company AS value, count(*)::int AS count
          FROM interviews WHERE ${whereClause} AND company IS NOT NULL
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
          recruitmentTags: recruitmentTags.rows,
          companies: companies.rows,
        },
      },
    });
  });

  app.get<{ Params: { id: string } }>("/v1/interviews/:id", async (req, reply) => {
    const { id } = req.params;
    const res = await db.execute(sql`
      SELECT * FROM interviews WHERE id = ${id} LIMIT 1
    `);
    if (res.rows.length === 0) {
      reply.code(404).send({ code: 404, message: "interview not found" });
      return;
    }
    reply.send({ code: 0, message: "ok", data: res.rows[0] });
  });
}
