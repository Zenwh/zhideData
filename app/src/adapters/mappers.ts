import {
  parseUpstreamTime,
  type StepFunInterviewDetail,
  type StepFunInterviewSummary,
  type StepFunJob,
} from "@/adapters/stepfun.js";

function splitCity(city: string | undefined | null): string[] {
  if (!city) return [];
  return city
    .split(/[,，、;；/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function safeParseJSON<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export interface JobRow {
  id: string;
  source: string;
  company: string | null;
  companyIntro: string | null;
  position: string | null;
  content: string | null;
  workType: string | null;
  positionType: string | null;
  industry: string | null;
  workplace: string | null;
  city: string | null;
  cityList: string[];
  tagList: string[];
  recommendation: boolean | null;
  recommendationContent: unknown;
  eduRequirement: string | null;
  salary: string | null;
  hot: boolean | null;
  companyScale: string | null;
  imgUrl: string | null;
  deliverChannel: string | null;
  explain: unknown;
  upstreamUpdateTime: Date | null;
  status: number;
  raw: unknown;
}

export function mapJob(item: StepFunJob): JobRow {
  return {
    id: item._id,
    source: "stepfun",
    company: item.company ?? null,
    companyIntro: item.company_intro ?? null,
    position: item.position ?? null,
    content: item.content ?? null,
    workType: item.work_type ?? null,
    positionType: item.position_type ?? null,
    industry: item.industry ?? null,
    workplace: item.workplace ?? null,
    city: item.city ?? null,
    cityList: splitCity(item.city),
    tagList: Array.isArray(item.tag_list) ? item.tag_list : [],
    recommendation:
      typeof item.recommendation === "boolean" ? item.recommendation : null,
    recommendationContent: item.recommendation_content ?? null,
    eduRequirement: item.edu_requirement ?? null,
    salary: item.salary ?? null,
    hot: typeof item.hot === "boolean" ? item.hot : null,
    companyScale: item.company_scale ?? null,
    imgUrl: item.img_url ?? null,
    deliverChannel: item.deliver_channel ?? null,
    explain: item.explain ?? null,
    upstreamUpdateTime: parseUpstreamTime(item.update_time),
    status: typeof item.status === "number" ? item.status : 0,
    raw: item,
  };
}

export interface InterviewRow {
  id: string;
  source: string;
  title: string | null;
  briefTitle: string | null;
  briefIntro: string | null;
  abstract: string | null;
  company: string | null;
  industry: string | null;
  city: string | null;
  cityList: string[];
  positionType: string | null;
  recruitmentTag: string | null;
  jobId: string | null;
  content: unknown;
  contentRaw: string | null;
  tags: string[];
  entities: string[];
  locations: string[];
  images: string[];
  albumId: string | null;
  author: string | null;
  authorId: string | null;
  domain: string | null;
  pageImage: string | null;
  pageType: string | null;
  contentType: string | null;
  templateId: string | null;
  templateType: string | null;
  templateVersion: string | null;
  auditStatus: number | null;
  deleteStatus: number | null;
  publicStatus: number | null;
  publishStatus: number | null;
  upstreamCreateAt: Date | null;
  upstreamUpdateAt: Date | null;
  raw: unknown;
}

/**
 * 把摘要 + 详情合并成入库行。jobId 由调用方传入（来自反查时绑定的 job_id）。
 * 详情可以为 null，此时只入库摘要字段。
 */
export function mapInterview(args: {
  summary: StepFunInterviewSummary;
  detail: StepFunInterviewDetail | null;
  jobId: string | null;
}): InterviewRow {
  const { summary, detail, jobId } = args;
  const merged: StepFunInterviewSummary & Partial<StepFunInterviewDetail> = {
    ...summary,
    ...(detail ?? {}),
  };
  const contentRaw =
    typeof merged.content === "string"
      ? merged.content
      : merged.raw_content && typeof merged.raw_content === "string"
        ? merged.raw_content
        : null;

  return {
    id: merged.id,
    source: "stepfun",
    title: merged.title ?? null,
    briefTitle: merged.brief_title ?? null,
    briefIntro: merged.brief_intro ?? null,
    abstract: null,
    company: merged.company ?? null,
    industry:
      typeof (merged as { industry?: unknown }).industry === "string"
        ? ((merged as { industry?: string }).industry ?? null)
        : null,
    city: merged.city ?? null,
    cityList: splitCity(merged.city),
    positionType: merged.position_type ?? null,
    recruitmentTag: merged.recruitment_tag ?? null,
    jobId: jobId ?? null,
    content: safeParseJSON(merged.content),
    contentRaw,
    tags: Array.isArray(merged.tags) ? merged.tags : [],
    entities: Array.isArray(merged.entities) ? merged.entities : [],
    locations: [],
    images: [],
    albumId: null,
    author: null,
    authorId: null,
    domain: null,
    pageImage: null,
    pageType: null,
    contentType: null,
    templateId: null,
    templateType: null,
    templateVersion: null,
    auditStatus: null,
    deleteStatus: null,
    publicStatus: null,
    publishStatus: null,
    upstreamCreateAt: parseUpstreamTime(merged.create_at),
    upstreamUpdateAt: parseUpstreamTime(merged.create_at),
    raw: { summary, detail },
  };
}
