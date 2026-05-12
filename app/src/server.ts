import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

import { env } from "@/lib/env.js";
import { logger } from "@/lib/logger.js";
import { registerAuth } from "@/routes/auth.js";
import { registerHealthRoutes } from "@/routes/health.js";
import { registerInterviewRoutes } from "@/routes/interviews.js";
import { registerJobRoutes } from "@/routes/jobs.js";
import { startSchedulers } from "@/sync/scheduler.js";

async function bootstrap() {
  // Use Fastify's default pino-based logger (avoids type drift with our pino instance).
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    trustProxy: true,
  });

  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    allowList: (req) => req.url === "/v1/healthz",
  });

  registerAuth(app);
  registerHealthRoutes(app);
  registerJobRoutes(app);
  registerInterviewRoutes(app);

  await app.listen({ host: "0.0.0.0", port: env.API_PORT });
  logger.info({ port: env.API_PORT }, "api listening");

  startSchedulers();
}

bootstrap().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, "bootstrap failed");
  process.exit(1);
});
