import { Agent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

import { env } from "@/lib/env.js";
import { logger } from "@/lib/logger.js";

/**
 * StepFun workflow 实际响应壳：
 *   { code, msg, data: { publish_at, version, result: { code, message, data: <inner> } } }
 *
 * <inner> 形状因接口而异：
 *   - position_list:           { current_page, items, page_size, total_items, total_pages }
 *   - position_detail:         [Job]  (单元素列表)
 *   - interview_record_list:   { has_more, items: [InterviewSummary] }
 *   - interview_record_detail: [InterviewDetail] (单元素列表)
 *
 * 所有接口的入参都是 { input: {...} }，list 类的 page_size/page_num 只作用于 V1。
 */

export interface StepFunJob {
  _id: string;
  company?: string;
  company_intro?: string;
  position?: string;
  content?: string;
  work_type?: string;
  position_type?: string;
  industry?: string;
  workplace?: string;
  city?: string;
  tag_list?: string[] | null;
  recommendation?: boolean;
  recommendation_content?: Record<string, unknown> | null;
  edu_requirement?: string;
  hot?: boolean;
  company_scale?: string;
  img_url?: string;
  salary?: string;
  deliver_channel?: string;
  explain?: Record<string, unknown> | null;
  status?: number;
  update_time?: string;
  update_at?: string;
  create_at?: string;
  collect_info?: Record<string, unknown> | null;
  wx_title?: string;
  wx_publisher?: string;
  [key: string]: unknown;
}

/**
 * 列表接口拿到的精简面经摘要。
 */
export interface StepFunInterviewSummary {
  id: string;
  title?: string;
  brief_title?: string;
  brief_intro?: string;
  company?: string;
  city?: string;
  position_type?: string;
  recruitment_tag?: string;
  create_at?: string;
  [key: string]: unknown;
}

/**
 * 详情接口拿到的完整面经。
 */
export interface StepFunInterviewDetail {
  id: string;
  title?: string;
  brief_title?: string;
  brief_intro?: string;
  company?: string;
  city?: string;
  position_type?: string;
  recruitment_tag?: string;
  content?: string; // JSON string，包含 round1/round2/round3/basic_info/background
  raw_content?: string;
  source_url?: string;
  tags?: string[];
  entities?: string[];
  create_at?: string;
  [key: string]: unknown;
}

export interface StepFunJobListInput {
  /** Server's actual pagination key. */
  current_page?: number;
  /** Doc says `page_num` — server ignores it but we send both for forward-compat. */
  page_num?: number;
  page_size?: number;
  hot?: boolean;
  work_type?: string;
  start_time?: string;
  end_time?: string;
  company?: string;
  position?: string;
  industry?: string;
  position_type?: string;
  city?: string;
  [key: string]: unknown;
}

export interface StepFunInterviewListV1Input {
  job_ids: string;
  current_page?: number;
  page_num?: number;
  page_size?: number;
  company?: string;
  industry?: string;
  position_type?: string;
  city?: string;
  [key: string]: unknown;
}

export interface StepFunInterviewListV2Input {
  position_query: string;
  limit?: number;
  company?: string;
  recruitment_tag?: string;
  city?: string;
  [key: string]: unknown;
}

interface WorkflowEnvelope<T> {
  code: number;
  msg?: string;
  data?: {
    publish_at?: number;
    version?: number;
    result?: {
      code: number;
      message?: string;
      data?: T;
    };
  };
}

class StepFunError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "StepFunError";
  }
}

/**
 * Spare's network stack RST's parallel connect attempts to api.stepfun.com.
 * Forcing one keep-alive connection per origin gives the bootstrap a fighting chance.
 * Concurrency at the application layer (multiple in-flight requests) still works
 * via HTTP/1.1 pipelining over the single connection.
 */
const dispatcher = new Agent({
  connect: { timeout: 60_000 },
  connections: 1,
  pipelining: 6,
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: 90_000,
  bodyTimeout: 90_000,
});
setGlobalDispatcher(dispatcher);

async function postWorkflow<T>(
  endpoint: string,
  input: Record<string, unknown>,
  attempt = 0,
): Promise<T> {
  const url = `${env.STEPFUN_BASE_URL}/v1/workflows/${endpoint}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.SYNC_REQUEST_TIMEOUT_MS);

  try {
    const res = await undiciFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.STEPFUN_TOKEN}`,
      },
      body: JSON.stringify({ input }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!res.ok) {
      throw new StepFunError(
        `StepFun ${endpoint} HTTP ${res.status}`,
        res.status,
        body,
      );
    }
    return body as T;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } })?.cause;
    const isAbort = (err as Error)?.name === "AbortError";
    const isServerErr =
      err instanceof StepFunError && err.status >= 500;
    const isTcpTransient =
      cause?.code === "ETIMEDOUT" ||
      cause?.code === "ECONNRESET" ||
      cause?.code === "ECONNREFUSED" ||
      cause?.code === "EAI_AGAIN" ||
      cause?.code === "ENOTFOUND";
    if (attempt < 3 && (isAbort || isServerErr || isTcpTransient)) {
      // exponential backoff w/ jitter: 1.5s, 4s, 9s
      const base = 1500 * Math.pow(2, attempt);
      const delay = base + Math.random() * 500;
      logger.warn(
        {
          endpoint,
          attempt,
          code: cause?.code,
          err: (err as Error).message,
          retryInMs: Math.round(delay),
        },
        "stepfun retry",
      );
      await new Promise((r) => setTimeout(r, delay));
      return postWorkflow<T>(endpoint, input, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function unwrapWorkflow<T>(
  endpoint: string,
  resp: WorkflowEnvelope<T>,
): T {
  if (resp.code !== 0) {
    throw new StepFunError(
      `${endpoint} outer code ${resp.code} ${resp.msg ?? ""}`,
      0,
      resp,
    );
  }
  const result = resp.data?.result;
  if (!result || result.code !== 0) {
    throw new StepFunError(
      `${endpoint} inner code ${result?.code ?? "??"} ${result?.message ?? ""}`,
      0,
      resp,
    );
  }
  if (result.data === undefined || result.data === null) {
    throw new StepFunError(`${endpoint} inner data missing`, 0, resp);
  }
  return result.data;
}

export interface PositionListPage {
  items: StepFunJob[];
  current_page?: number;
  page_size?: number;
  total_items?: number;
  total_pages?: number;
}

export interface InterviewListPage {
  items: StepFunInterviewSummary[];
  has_more?: boolean;
}

export const stepfun = {
  async positionList(input: StepFunJobListInput): Promise<PositionListPage> {
    const resp = await postWorkflow<WorkflowEnvelope<PositionListPage>>(
      "position_list",
      input,
    );
    return unwrapWorkflow("position_list", resp);
  },

  async positionDetail(id: string): Promise<StepFunJob | null> {
    const resp = await postWorkflow<WorkflowEnvelope<StepFunJob[]>>(
      "position_detail",
      { _id: id },
    );
    const data = unwrapWorkflow("position_detail", resp);
    return data[0] ?? null;
  },

  async interviewListV1(
    input: StepFunInterviewListV1Input,
  ): Promise<InterviewListPage> {
    const resp = await postWorkflow<WorkflowEnvelope<InterviewListPage>>(
      "interview_record_list",
      input,
    );
    return unwrapWorkflow("interview_record_list", resp);
  },

  async interviewListV2(
    input: StepFunInterviewListV2Input,
  ): Promise<InterviewListPage> {
    const resp = await postWorkflow<WorkflowEnvelope<InterviewListPage>>(
      "interview_record_list",
      input,
    );
    return unwrapWorkflow("interview_record_list", resp);
  },

  async interviewDetail(id: string): Promise<StepFunInterviewDetail | null> {
    const resp = await postWorkflow<WorkflowEnvelope<StepFunInterviewDetail[]>>(
      "interview_record_detail",
      { _id: id },
    );
    const data = unwrapWorkflow("interview_record_detail", resp);
    return data[0] ?? null;
  },
};

export function parseUpstreamTime(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let date = new Date(trimmed);
  if (!isNaN(date.getTime())) return date;
  const normalized = trimmed.replace(" ", "T") + "Z";
  date = new Date(normalized);
  if (!isNaN(date.getTime())) return date;
  return null;
}

export function formatUpstreamTime(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "")
    .replace(/Z$/, "");
}
