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

## Admin Operations

Open `/#admin` and enter `ADMIN_API_TOKEN`.

- Use `URL로 초안 가져오기` for Ticket Pia, e+, Lawson Ticket, LiveFans, or other ticket pages. Imported drafts are stored as pending candidates when Supabase is configured, and fall back to local browser storage when the candidate table is not ready.
- Use `검색어 후보 만들기` to create source search links for an artist keyword across Ticket Pia, e+, and Lawson Ticket. These are review candidates, not confirmed events.
- Review `URL 후보`, then choose `초안 적용` to inspect the fields or `승인 저장` to write a complete candidate into the `events` table.
- Use `데이터 품질` before releases to find missing links, missing sale windows, missing prices, ticket-access items that still need review, and alert queue errors.

## Alert Operations

Users can save interest alerts from the public detail panel. The browser stores the local selection immediately, and `/api/alerts` upserts the server-side reminder when Supabase is configured.

- Reminder timing prefers the sale-window start and schedules three hours before sales open. If the sale window is missing, it falls back to seven days before the event date.
- Users can add an alert email in the saved-alerts panel. The email is stored with each active server-side alert and sent to the delivery webhook as `contactEmail`.
- `Dispatch Due Alerts` runs every 15 minutes and reads due rows from `/api/admin-alerts`.
- `ALERT_WEBHOOK_URL` receives a JSON payload with the Korean message text, alert id, event key, event snapshot, and reminder time.
- Successful deliveries are marked `sent`; delivery failures are marked `error` with `last_error` so they do not silently disappear.
- Operators can inspect non-due queues with `/api/admin-alerts?status=error` or `/api/admin-alerts?status=sent&due=all`. Retrying an errored alert is a `PATCH /api/admin-alerts` with `status: "active"` and an optional `remindAt`.

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

## Release Operations

Normal development flow:

1. Branch from `dev` with a `codex/` prefix.
2. Run `npm run typecheck`, `npm run build`, and `npx playwright test`.
3. Open a PR into `dev` and wait for GitHub CI.
4. Merge to `dev`.
5. Let `Auto Release PR` update the open `dev` to `main` release PR.
6. Merge the release PR only when production deploy capacity is available.
7. Verify production with `npm run health:production` or `https://japan-live-radar.vercel.app/api/health`.

If Vercel returns `api-deployments-free-per-day` or `build-rate-limit`, keep the release PR open and continue feature work on `dev`. Do not close the matching `automation` issue until a later production deploy succeeds and the health check reports `database: "reachable"`.

Vercel Git preview builds are skipped by `scripts/vercel-ignore-build.sh` so duplicate Vercel builds do not consume quota. GitHub Actions remains the source of truth for preview checks and uses `vercel build` with `vercel deploy --prebuilt` when a preview deployment is needed.

## Branch Rules

- Feature: `codex/feature-*`
- Fix: `codex/fix-*`
- UI: `codex/ui-*`
- Chore: `codex/chore-*`

Feature work targets `dev`. Deployable release PRs target `main`.

Draft PRs are the default for Codex-generated feature work. When CI is green and the PR is ready, Codex can mark it ready and enable auto-merge.
