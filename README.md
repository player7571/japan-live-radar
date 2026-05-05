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
- Ticketmaster public sale and presale windows are preserved in Korean-facing sale schedule text so reminders can target the earliest available ticket window.
- Supabase migrations run with `npm run db:migrate` or the manual `Supabase Migrate` workflow.

## Admin Operations

Open `/#admin` and enter `ADMIN_API_TOKEN`.

- Use `URL로 초안 가져오기` for Ticket Pia, e+, Lawson Ticket, LiveFans, or other ticket pages. Imported drafts are stored as pending candidates when Supabase is configured, and fall back to local browser storage when the candidate table is not ready.
- Use `검색어 후보 만들기` to create source search links for an artist keyword across Ticket Pia, e+, and Lawson Ticket. These are review candidates, not confirmed events.
- Review `URL 후보`, then choose `초안 적용` to inspect the fields or `승인 저장` to write a complete candidate into the `events` table.
- Use `데이터 품질` before releases to find missing links, missing sale windows, missing prices, ticket-access items that still need review, and alert queue errors.
- Use `알림 큐` to inspect failed, due, or sent alerts. Failed alerts can be returned to the active queue with `재시도`.

## Alert Operations

Users can save interest alerts from the public detail panel. The browser stores the local selection immediately, and `/api/alerts` upserts the server-side reminder when Supabase is configured.

- Reminder timing prefers the first sale-window start, including Ticketmaster presales, and schedules three hours before sales open. If the sale window is missing, it falls back to seven days before the event date.
- Users can add an alert email in the saved-alerts panel. The email is stored with each active server-side alert and sent to the delivery webhook as `contactEmail`.
- Alert messages include an `appUrl` detail link such as `https://japan-live-radar.vercel.app/?event=<event-id>` so recipients can jump back to the matching concert detail.
- `Dispatch Due Alerts` runs every 15 minutes and reads due rows from `/api/admin-alerts`.
- `ALERT_WEBHOOK_URL` receives a JSON payload with `text`, `deliveryKey`, `alertId`, `eventKey`, `contactEmail`, `appUrl`, `event`, `source`, `ticketAccess`, `saleType`, `phoneRequired`, and `remindAt`. `deliveryKey` is stable across retries for the same alert reminder.
- Webhook delivery retries transient HTTP statuses (`408`, `429`, and `5xx`) and network exceptions according to `ALERT_WEBHOOK_ATTEMPTS`.
- Successful deliveries are marked `sent`; delivery failures are marked `error` with `last_error` so they do not silently disappear.
- Operators can inspect non-due queues with `/api/admin-alerts?status=error` or `/api/admin-alerts?status=sent&due=all`. Retrying an errored alert is a `PATCH /api/admin-alerts` with `status: "active"` and an optional `remindAt`.

## Automation

GitHub Actions is the long-running automation layer so Codex heartbeat runs do not need to rely on local full-disk or network permissions.

- `CI`: typecheck, build, and Playwright smoke tests for PRs and pushes to `dev`/`main`.
- `Deploy to Vercel`: validates `dev` preview builds and deploys `main` as production, then verifies production health. Automatic `main` deploys are skipped while open production deploy/health automation blockers exist so quota is preserved for the retry workflow.
- `Auto Release PR`: opens a `dev` to `main` release PR whenever `dev` changes.
- `Merge Release PR`: merges the open `dev` to `main` release PR after all PR checks finish successfully.
- `Retry Production Deploy`: when production deploy or health automation issues are open, retries the main production deploy every six hours and closes the blockers after health passes.
- `Supabase Migrate`: applies migrations automatically when migration files land on `main`, and can also be run manually.
- `Sync Ticketmaster Events`: refreshes seed and Ticketmaster data on a daily schedule. The workflow uses a single concurrency group so scheduled and manual syncs do not overlap.
- `Dispatch Due Alerts`: checks the protected alert queue every 15 minutes and dispatches via `ALERT_WEBHOOK_URL` when configured. The workflow uses a single concurrency group so scheduled and manual runs do not overlap and double-send the same due alert.
- `Production Health Check`: checks `/api/health`, the protected alert queue, and admin alert/sync stats every 30 minutes.

Scheduled workflows create one open `automation` issue when they fail, so Codex can pick up the issue/logs and continue without waiting for a local heartbeat to have elevated permissions.

Required GitHub repository secrets:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
TICKETMASTER_API_KEY
SUPABASE_DB_URL
ADMIN_API_TOKEN
ALERT_WEBHOOK_URL
VERCEL_ORG_ID
VERCEL_PROJECT_ID
VERCEL_TOKEN
```

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` power event reads, admin writes, imports, candidates, stats, health checks, and alert queue APIs.
- `TICKETMASTER_API_KEY` powers the scheduled Ticketmaster sync.
- `SUPABASE_DB_URL` is used only by migration automation.
- `ADMIN_API_TOKEN` protects the admin import, candidate, quality, and alert queue APIs.
- `ALERT_WEBHOOK_URL` is optional until real alert delivery is connected; without it, due alerts are marked `error` instead of pretending they were sent.
- `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and `VERCEL_TOKEN` allow GitHub Actions to sync Vercel environments, build, deploy, and retry production after quota resets.

Vercel runtime environments are synced by GitHub Actions from the repository secrets above. The app expects these runtime variables in both preview and production:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
ADMIN_API_TOKEN
SUPABASE_SERVICE_ROLE_KEY
```

Optional local or workflow env:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
APP_BASE_URL
VITE_USE_SEED_DATA
TICKETMASTER_PAGE_LIMIT
TICKETMASTER_FETCH_TIMEOUT_MS
ALERT_WEBHOOK_ATTEMPTS
ALERT_WEBHOOK_TIMEOUT_MS
SYNC_STALE_AFTER_HOURS
```

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are server-side fallbacks for the Vite-prefixed Supabase values.
- `APP_BASE_URL` overrides the production URL used by health checks and alert dispatch scripts.
- `VITE_USE_SEED_DATA=true` forces the frontend to use local seed data during development.
- `TICKETMASTER_PAGE_LIMIT` caps Ticketmaster sync pagination per search profile. It defaults to `2` pages, is clamped from `1` to `5`, and can be set as a GitHub repository variable for the scheduled sync workflow.
- `TICKETMASTER_FETCH_TIMEOUT_MS` controls each Ticketmaster API request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable for the scheduled sync workflow.
- `ALERT_WEBHOOK_ATTEMPTS` controls retry attempts for transient alert webhook HTTP failures and network exceptions. It defaults to `3`, is clamped from `1` to `5`, and can be set as a GitHub repository variable for `Dispatch Due Alerts`.
- `ALERT_WEBHOOK_TIMEOUT_MS` controls each alert webhook request timeout. It defaults to `10000`, is clamped from `1000` to `30000`, and can be set as a GitHub repository variable for `Dispatch Due Alerts`.
- `SYNC_STALE_AFTER_HOURS` controls when the admin stats API marks the latest sync run as delayed. It defaults to `30` hours to cover the daily Ticketmaster schedule with slack.

## Release Operations

Normal development flow:

1. Branch from `dev` with a `codex/` prefix.
2. Run `npm run typecheck`, `npm run build`, and `npx playwright test`.
3. Open a PR into `dev` and wait for GitHub CI.
4. Merge to `dev`.
5. Let `Auto Release PR` update the open `dev` to `main` release PR.
6. Merge the release PR after its checks pass. The `Merge Release PR` workflow first reconciles `dev` with the latest `main` release commit when prior releases have made the branches diverge, merges the clean release PR, then fast-forwards `dev` to the new `main` release commit. If production deploy capacity is exhausted after merge, leave the matching automation issues open and let `Retry Production Deploy` finish the release later. While those blockers are open, automatic `main` push deploys are intentionally skipped to avoid spending more Vercel quota.
7. Verify production with `npm run health:production` or `https://japan-live-radar.vercel.app/api/health`. With `ADMIN_API_TOKEN`, the script also verifies that alert queue tables are ready, alert errors are cleared, and sync health is current.

If Vercel returns `api-deployments-free-per-day` or `build-rate-limit`, continue feature work on `dev` and avoid manual deploy retries until quota resets. Do not close the matching `automation` issue until a later production deploy succeeds and the health check reports `database: "reachable"`.

Vercel Git preview builds are skipped by `scripts/vercel-ignore-build.sh` so duplicate Vercel builds do not consume quota. GitHub Actions remains the source of truth for preview checks and uses `vercel build` with `vercel deploy --prebuilt` when a preview deployment is needed.

## Branch Rules

- Feature: `codex/feature-*`
- Fix: `codex/fix-*`
- UI: `codex/ui-*`
- Chore: `codex/chore-*`

Feature work targets `dev`. Deployable release PRs target `main`.

Draft PRs are the default for Codex-generated feature work. When CI is green and the PR is ready, Codex can mark it ready and enable auto-merge.
