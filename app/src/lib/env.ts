import { z } from "zod";

const schema = z.object({
  STEPFUN_BASE_URL: z.string().url().default("https://api.stepfun.com"),
  STEPFUN_TOKEN: z.string().min(1),

  DATABASE_URL: z.string().min(1),

  API_PORT: z.coerce.number().int().positive().default(8090),
  API_BEARER_TOKEN: z.string().min(8),

  SYNC_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SYNC_JOBS_CRON: z.string().default("*/30 * * * *"),
  SYNC_INTERVIEWS_CRON: z.string().default("15 */2 * * *"),
  SYNC_FULL_RECONCILE_CRON: z.string().default("0 3 * * *"),
  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  SYNC_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] invalid environment:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
