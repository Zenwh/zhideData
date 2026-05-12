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
  limit: z.number().int().min(1).max(50).default(10),
  page: z.number().int().positive().default(1),
});

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

    const whereClause = conditions.reduce(
      (acc, c, idx) => (idx === 0 ? c : sql`${acc} AND ${c}`),
      sql`true`,
    );

    const offset = (f.page - 1) * f.limit;

    const res = await db.execute(sql`
      SELECT
        id, title, brief_title, brief_intro, company, industry, city, city_list,
        position_type, recruitment_tag, job_id,
        tags, entities, upstream_create_at
      FROM interviews
      WHERE ${whereClause}
      ORDER BY upstream_create_at DESC NULLS LAST, id DESC
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
