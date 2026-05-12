# zhideData

岗位 / 面经数据 API。从 StepFun workflow 同步数据到本地 PostgreSQL，对外提供更快的查询接口。

替代职得 offer 前端 / 后端目前直连 StepFun（p95 5–15s）的链路。

## 运行

```bash
cp .env.example .env       # 填 STEPFUN_TOKEN 和 API_BEARER_TOKEN
docker compose up -d       # 起 postgres + app
docker compose exec app pnpm migrate
docker compose exec app pnpm sync:bootstrap   # 首次全量
```

## 架构

```
StepFun workflow ──同步──▶ Postgres (jobs / interviews / sync_logs)
                              │
                              ▼
                    Fastify API (Bearer token)
                    /v1/jobs/search  /v1/jobs/:id
                    /v1/interviews/search  /v1/interviews/:id
```

详见 `docs/`（待写）。
