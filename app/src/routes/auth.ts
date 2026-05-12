import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { env } from "@/lib/env.js";

export function registerAuth(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // 放行 healthz（上游探活常用）
    if (req.url === "/v1/healthz" || req.url === "/healthz") return;

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      reply.code(401).send({ code: 401, message: "unauthorized" });
      return reply;
    }
    const token = header.slice("Bearer ".length).trim();
    if (token !== env.API_BEARER_TOKEN) {
      reply.code(403).send({ code: 403, message: "forbidden" });
      return reply;
    }
    return;
  });
}
