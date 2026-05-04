# Japan Live Radar

한국에서 일본 콘서트를 보러 가는 사람들을 위한 일본 콘서트 정보 통합 앱 프로토타입입니다.

## MVP

- 한국어 콘서트 검색
- 도시, 날짜, 아티스트 기준 탐색
- 티켓 구매 가능 여부 표시
- 일본 전화번호 필요 여부 표시
- 추첨/일반판매 일정 표시
- 원본 티켓 링크 제공

## Development

```bash
npm install
npm run dev
```

Local app: <http://localhost:5173>

The Vite dev server uses local seed data. In Vercel, `/api/events` reads from Supabase and falls back to seed data if the database is not configured yet.

## Checks

```bash
npm run typecheck
npm run build
npx playwright test
```

## Backend

- Database schema lives in `supabase/migrations`.
- Public event reads are served by `api/events.ts`.
- Admin event entry, candidate approval, URL import, search candidates, quality stats, and alert subscriptions live under `api/`.
- Stable fallback data is synced with `npm run sync:seed`.
- Ticketmaster ingestion runs with `npm run sync:ticketmaster`.
- Supabase migrations run with `npm run db:migrate` or the manual `Supabase Migrate` workflow.

## Automation

GitHub Actions is the long-running automation layer so Codex heartbeat runs do not need to rely on local full-disk or network permissions.

- `CI`: typecheck, build, and Playwright smoke tests for PRs and pushes to `dev`/`main`.
- `Deploy to Vercel`: deploys `dev` as preview and `main` as production, then verifies production health.
- `Auto Release PR`: opens a `dev` to `main` release PR whenever `dev` changes.
- `Merge Release PR`: merges the open `dev` to `main` release PR after all PR checks finish successfully.
- `Supabase Migrate`: applies migrations automatically when migration files land on `main`, and can also be run manually.
- `Sync Ticketmaster Events`: refreshes seed and Ticketmaster data on a daily schedule.
- `Dispatch Due Alerts`: checks the protected alert queue every 15 minutes and dispatches via `ALERT_WEBHOOK_URL` when configured.
- `Production Health Check`: checks `/api/health` and the protected alert queue every 30 minutes.

Scheduled workflows create one open `automation` issue when they fail, so Codex can pick up the issue/logs and continue without waiting for a local heartbeat to have elevated permissions.

Required runtime secrets:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
TICKETMASTER_API_KEY
SUPABASE_DB_URL
ADMIN_API_TOKEN
ALERT_WEBHOOK_URL
```

`SUPABASE_DB_URL` is used only by migration automation.
`ADMIN_API_TOKEN` protects the admin import, candidate, and quality APIs.
`ALERT_WEBHOOK_URL` is optional until real alert delivery is connected; without it, due alerts are marked `error` instead of pretending they were sent.

## Branch Rules

- Feature: `codex/feature-*`
- Fix: `codex/fix-*`
- UI: `codex/ui-*`
- Chore: `codex/chore-*`

Feature work targets `dev`. Deployable release PRs target `main`.

Draft PRs are the default for Codex-generated feature work. When CI is green and the PR is ready, Codex can mark it ready and enable auto-merge.
