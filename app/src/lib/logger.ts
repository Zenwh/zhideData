// fastify ships pino as a transitive dep; we reuse the same one to avoid version drift.
import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "zhide-data-api" },
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } },
});
