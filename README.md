# Japan Live Radar

한국에서 일본 콘서트를 보러 가는 사람들을 위한 일본 콘서트 정보 통합 앱 프로토타입입니다.

## MVP

- 한국어 콘서트 검색
- 도시, 날짜, 아티스트, 티켓 출처 기준 탐색
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

## App Install

The web MVP is also an installable PWA. Mobile users can add the production URL to their home screen, and supported desktop browsers can install it from the address bar.

- `public/manifest.webmanifest` defines the app name, Korean description, standalone display mode, theme color, and maskable icons.
- `public/sw.js` caches the app shell and static assets for faster repeat launches. It intentionally leaves `/api/*` uncached so concert data, alert subscriptions, and admin operations stay fresh.
- `src/registerServiceWorker.ts` registers the service worker only for production builds.

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
- Public source metadata lives in `src/lib/publicSources.ts` and is shared by `sync:public-sources`, Admin sync health, and search candidate generation so source additions stay aligned.
- Stable fallback data is synced with `npm run sync:seed`.
- All configured public source syncs can be run in sequence with `npm run sync:public-sources`. Set `SYNC_PUBLIC_SOURCES=lawson,ticket-pia` to run a subset, or `SYNC_CONTINUE_ON_ERROR=true` to collect failures across sources during manual operations.
- Creativeman public schedule ingestion runs with `npm run sync:creativeman`, follows public upcoming/schedule links into event detail pages, and preserves existing Creativeman rows when a run finds no usable public schedule rows.
- Live Nation H.I.P. public schedule ingestion runs with `npm run sync:livenation-hip`, follows public `all-events/*-tickets-ae*` pages from the home page, extracts visible Japanese schedule rows, and preserves existing Live Nation H.I.P. rows when a run finds no usable public schedule rows.
- LiveFans public event ingestion runs with `npm run sync:livefans`, follows public search result links into event pages, keeps Japan venue rows only, and preserves existing LiveFans rows when a run finds no usable Japan concert rows.
- Ticketmaster ingestion runs with `npm run sync:ticketmaster`.
- e+ public search ingestion runs with `npm run sync:eplus`, maps usable public concert rows into the live catalog, merges duplicate ticket-phase listings for the same performance, and removes stale e+ rows only after a successful usable sync.
- Lawson Ticket / ローチケ public HTML ingestion runs with `npm run sync:lawson`, reads public concert category/search pages plus `concert/mevent/?mid=...` detail pages, maps JSON-LD Event and visible search result rows into the live catalog, and removes stale Lawson Ticket rows only after a successful usable sync.
- Ticket Pia public search ingestion runs with `npm run sync:ticket-pia`, maps the public `rlsInfo` search result rows into the live catalog, and removes stale Ticket Pia rows only after a successful usable sync.
- Rakuten Ticket public category ingestion runs with `npm run sync:rakuten-ticket`, follows public music category links into detail pages, reuses the URL import parser, and removes stale Rakuten Ticket rows only after a successful usable sync.
- Ticketmaster public sale and presale windows are preserved in Korean-facing sale schedule text so reminders can target the earliest available ticket window.
- Ticketmaster stale cleanup only runs after a sync produces at least one usable concert row, so a temporary empty or misclassified API response does not wipe the existing catalog.
- Supabase migrations run with `npm run db:migrate` or the manual `Supabase Migrate` workflow.

## Admin Operations

Open `/#admin` and enter `ADMIN_API_TOKEN`. In local development, the token is usually stored in `.env.admin.local`; copy only the value after `ADMIN_API_TOKEN=` into the admin token field. A `401 Unauthorized` response means the token is missing, was copied with extra quotes/spaces, or does not match the Vercel production environment value.

- Use `URL로 초안 가져오기` for Ticket Pia, e+, Lawson Ticket, Rakuten Ticket, Tixplus, ticket board, LiveFans, official artist pages, or other ticket pages. When an official page links to a known ticket platform, the imported draft prefers that application link as the source ticket URL. Imported drafts are stored as pending candidates when Supabase is configured, and fall back to local browser storage when the candidate table is not ready.
- Use `검색어 후보 만들기` to collect artist-keyword candidates across Ticket Pia, e+, Lawson Ticket, Ticketmaster, Rakuten Ticket, LiveFans, Live Nation H.I.P., and Creativeman. The API first tries to parse public, future-dated detail pages that match the keyword, rejects stale or unrelated pages, then falls back to source search URL candidates when a safe detail candidate is not available. These are review candidates, not confirmed events.
- Review `URL 후보`, open the original source link when needed, then choose `초안 적용` to inspect the fields or `승인 저장` to write a complete candidate into the `events` table.
- Use `데이터 품질` before releases to find missing links, missing sale windows, missing prices, ticket-access items that still need review, and alert queue errors.
- Use `알림 큐` to inspect failed, due, or sent alerts. Failed alerts can be returned to the active queue with `재시도`.

## Alert Operations

Users can save interest alerts from the public detail panel. The browser stores the local selection immediately, and `/api/alerts` upserts the server-side reminder when Supabase is configured.

- Reminder timing prefers the first sale-window start, including Ticketmaster presales, and schedules three hours before sales open. If the sale window is missing, it falls back to seven days before the event date.
- Users can choose the alert lead time in the saved-alerts panel: three hours, one day, or three days before the ticket window opens. The selected lead time is stored on the server alert row as `remind_before_hours`.
- Users can add an alert email in the saved-alerts panel. The email is stored with each active server-side alert and sent to the delivery webhook as `contactEmail`.
- Alert messages include an `appUrl`/`eventUrl` detail link such as `https://japan-live-radar.vercel.app/?event=<event-id>` so recipients can jump back to the matching concert detail. Webhook payloads also include a Korean `subject` and `ticketUrl` when the source ticket link is known.
- `Dispatch Due Alerts` runs twice daily while the app is pre-launch and reads due rows from `/api/admin-alerts`.
- `ALERT_WEBHOOK_URL` receives a JSON payload with `subject`, `text`, `deliveryKey`, `alertId`, `eventKey`, `channel`, `contactEmail`, `appUrl`, `eventUrl`, `ticketUrl`, `event`, `source`, `ticketAccess`, `saleType`, `phoneRequired`, `remindAt`, and `remindBeforeHours`. `deliveryKey` is stable across retries for the same alert reminder.
- Webhook requests include `x-japan-live-radar-alert-id`, `x-japan-live-radar-event-key`, and `x-japan-live-radar-delivery-key` headers so delivery workers can dedupe retries before parsing the body.
- When `ALERT_WEBHOOK_SECRET` is configured, webhook requests also include `x-japan-live-radar-signature` and `x-japan-live-radar-signature-timestamp`. The signature is `sha256=` plus an HMAC-SHA256 hex digest of `${timestamp}.${rawBody}` using the shared secret.
- Webhook delivery retries transient HTTP statuses (`408`, `429`, and `5xx`) and network exceptions according to `ALERT_WEBHOOK_ATTEMPTS`.
- Successful deliveries are marked `sent`; delivery failures are marked `error` with `last_error` so they do not silently disappear.
- Operators can inspect non-due queues with `/api/admin-alerts?status=error` or `/api/admin-alerts?status=sent&due=all`. Retrying an errored alert is a `PATCH /api/admin-alerts` with `status: "active"` and an optional `remindAt`.

## Automation

GitHub Actions is the long-running automation layer so Codex heartbeat runs do not need to rely on local full-disk or network permissions.

- `CI`: typecheck, build, and desktop Playwright smoke tests for PRs. Manual `workflow_dispatch` runs the full desktop/mobile Playwright suite when deeper validation is worth spending Actions minutes.
- `Deploy to Vercel`: deploys `main` as production with the Vercel CLI, then verifies production health. Vercel Git auto-deployments are disabled in `vercel.json` so PRs and branch pushes do not spend Vercel build quota. Manual `workflow_dispatch` preview validation is still available when a real Vercel preview is worth spending quota. Automatic `main` deploys are skipped before Node setup while open production deploy/health automation blockers exist so quota is preserved for the retry workflow.
- `Auto Release PR`: opens or updates a `dev` to `main` release PR whenever `dev` changes. The PR is a release candidate and can remain open while development continues.
- `Merge Release PR`: merges the open `dev` to `main` release PR after all PR checks finish successfully during the 09:00 and 21:00 KST release windows. It can also be run manually with `workflow_dispatch` when an immediate production release is desired.
- `Retry Production Deploy`: when production deploy or health automation issues are open, retries the main production deploy once daily and closes the blockers after health passes.
- `Supabase Migrate`: applies migrations automatically when migration files land on `main`, and can also be run manually.
- `Sync External Events`: refreshes seed, Ticketmaster, e+ public search, Lawson Ticket public HTML, Ticket Pia public search, Rakuten Ticket public category, and Creativeman public schedule data twice weekly while Actions minutes are constrained. Live Nation H.I.P. and LiveFans are supported by `npm run sync:public-sources` and Admin sync health, but are intentionally left out of the scheduled workflow until Actions budget allows broader scheduled coverage. The workflow uses a single concurrency group so scheduled and manual syncs do not overlap.
- `Dispatch Due Alerts`: checks the protected alert queue twice daily and dispatches via `ALERT_WEBHOOK_URL` when configured. The workflow uses a single concurrency group so scheduled and manual runs do not overlap and double-send the same due alert.
- `Production Health Check`: checks `/api/health`, including source-level latest sync summaries when `sync_runs` is available, plus the protected alert queue and admin alert/sync stats once daily.

Scheduled workflows create one open `automation` issue when they fail, so Codex can pick up the issue/logs and continue without waiting for a local heartbeat to have elevated permissions.

GitHub repository secrets and deployment credentials:

```text
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
TICKETMASTER_API_KEY
SUPABASE_DB_URL
ADMIN_API_TOKEN
ALERT_WEBHOOK_URL
ALERT_WEBHOOK_SECRET
VERCEL_ORG_ID
VERCEL_PROJECT_ID
VERCEL_TOKEN
```

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` power event reads, admin writes, imports, candidates, stats, health checks, and alert queue APIs.
- `TICKETMASTER_API_KEY` powers the scheduled Ticketmaster sync.
- `SUPABASE_DB_URL` is used only by migration automation.
- `ADMIN_API_TOKEN` protects the admin import, candidate, quality, and alert queue APIs. For local admin use, keep the same value in `.env.admin.local` and paste that raw value into `/#admin`.
- `ALERT_WEBHOOK_URL` is optional until real alert delivery is connected; without it, due alerts are marked `error` instead of pretending they were sent.
- `ALERT_WEBHOOK_SECRET` is optional and signs alert webhook payloads for downstream delivery workers.
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
EVENT_API_LIMIT
EPLUS_SYNC_KEYWORDS
EPLUS_ROW_LIMIT
EPLUS_FETCH_TIMEOUT_MS
LAWSON_SEARCH_URLS
LAWSON_SYNC_KEYWORDS
LAWSON_PAGE_LIMIT
LAWSON_ROW_LIMIT
LAWSON_FETCH_TIMEOUT_MS
TICKET_PIA_SYNC_KEYWORDS
TICKET_PIA_PAGE_LIMIT
TICKET_PIA_ROW_LIMIT
TICKET_PIA_FETCH_TIMEOUT_MS
RAKUTEN_TICKET_CATEGORY_URLS
RAKUTEN_TICKET_CATEGORY_LIMIT
RAKUTEN_TICKET_ROW_LIMIT
RAKUTEN_TICKET_FETCH_TIMEOUT_MS
CREATIVEMAN_INDEX_URLS
CREATIVEMAN_INDEX_LIMIT
CREATIVEMAN_ROW_LIMIT
CREATIVEMAN_FETCH_TIMEOUT_MS
ALERT_WEBHOOK_ATTEMPTS
ALERT_WEBHOOK_TIMEOUT_MS
ALERT_WEBHOOK_SECRET
ALERT_QUEUE_CONNECT_TIMEOUT_SECONDS
ALERT_QUEUE_MAX_TIME_SECONDS
ALERT_QUEUE_RETRY_ATTEMPTS
SYNC_PUBLIC_SOURCES
SYNC_CONTINUE_ON_ERROR
SYNC_STALE_AFTER_HOURS
```

- `SUPABASE_URL` and `SUPABASE_ANON_KEY` are server-side fallbacks for the Vite-prefixed Supabase values.
- `APP_BASE_URL` overrides the production URL used by health checks and alert dispatch scripts.
- `VITE_USE_SEED_DATA=true` forces the frontend to use local seed data during development.
- `EVENT_API_LIMIT` caps `/api/events` rows returned to the app. It defaults to `300`, is clamped from `50` to `500`, and should stay high enough to cover the current public-source catalog.
- `TICKETMASTER_PAGE_LIMIT` caps Ticketmaster sync pagination per search profile. It defaults to `2` pages, is clamped from `1` to `5`, and can be set as a GitHub repository variable for the scheduled sync workflow.
- `TICKETMASTER_FETCH_TIMEOUT_MS` controls each Ticketmaster API request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable for the scheduled sync workflow.
- `EPLUS_SYNC_KEYWORDS` controls public e+ search keywords for the scheduled sync. It defaults to `J-POP,K-POP,ライブ,コンサート,フェス,ROCK`.
- `EPLUS_ROW_LIMIT` caps e+ rows inserted per run. It defaults to `80`, is clamped from `1` to `120`, and can be set as a GitHub repository variable.
- `EPLUS_FETCH_TIMEOUT_MS` controls each e+ page request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `LAWSON_SEARCH_URLS` optionally overrides the public Lawson Ticket pages used by `npm run sync:lawson`. Use only publicly reachable `https://cdn.l-tike.com/` or `https://l-tike.com/` category/search/detail URLs.
- `LAWSON_SYNC_KEYWORDS` controls public Lawson Ticket search keywords. It defaults to `J-POP,K-POP,ライブ,コンサート,フェス,ROCK,アジア`.
- `LAWSON_PAGE_LIMIT` caps Lawson Ticket category/search page expansion. It defaults to `1`, is clamped from `1` to `3`, and can be set as a GitHub repository variable.
- `LAWSON_ROW_LIMIT` caps Lawson Ticket rows inserted per run. It defaults to `80`, is clamped from `1` to `120`, and can be set as a GitHub repository variable.
- `LAWSON_FETCH_TIMEOUT_MS` controls each Lawson Ticket HTML request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `TICKET_PIA_SYNC_KEYWORDS` controls public Ticket Pia search keywords for the scheduled sync. It defaults to `J-POP,K-POP,ライブ,コンサート,フェス,ROCK`.
- `TICKET_PIA_PAGE_LIMIT` caps Ticket Pia search result pages fetched per keyword. It defaults to `1`, is clamped from `1` to `3`, and can be set as a GitHub repository variable.
- `TICKET_PIA_ROW_LIMIT` caps Ticket Pia rows inserted per run. It defaults to `80`, is clamped from `1` to `120`, and can be set as a GitHub repository variable.
- `TICKET_PIA_FETCH_TIMEOUT_MS` controls each Ticket Pia page request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `RAKUTEN_TICKET_CATEGORY_URLS` optionally overrides the public Rakuten Ticket music category pages used by `npm run sync:rakuten-ticket`.
- `RAKUTEN_TICKET_CATEGORY_LIMIT` caps Rakuten Ticket category pages fetched per run. It defaults to `4`, is clamped from `1` to `8`, and can be set as a GitHub repository variable.
- `RAKUTEN_TICKET_ROW_LIMIT` caps Rakuten Ticket detail pages inserted per run. It defaults to `60`, is clamped from `1` to `100`, and can be set as a GitHub repository variable.
- `RAKUTEN_TICKET_FETCH_TIMEOUT_MS` controls each Rakuten Ticket page request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `CREATIVEMAN_INDEX_URLS` optionally overrides the public Creativeman schedule/index pages used by `npm run sync:creativeman`.
- `CREATIVEMAN_INDEX_LIMIT` caps Creativeman index pages fetched per run. It defaults to `2`, is clamped from `1` to `6`, and can be set as a GitHub repository variable.
- `CREATIVEMAN_ROW_LIMIT` caps Creativeman rows inserted per run. It defaults to `60`, is clamped from `1` to `100`, and can be set as a GitHub repository variable.
- `CREATIVEMAN_FETCH_TIMEOUT_MS` controls each Creativeman page request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `LIVENATION_HIP_INDEX_URLS` optionally overrides the public Live Nation H.I.P. index pages used by `npm run sync:livenation-hip`.
- `LIVENATION_HIP_INDEX_LIMIT` caps Live Nation H.I.P. index pages fetched per run. It defaults to `1`, is clamped from `1` to `4`, and can be set as a GitHub repository variable.
- `LIVENATION_HIP_ROW_LIMIT` caps Live Nation H.I.P. rows inserted per run. It defaults to `60`, is clamped from `1` to `100`, and can be set as a GitHub repository variable.
- `LIVENATION_HIP_FETCH_TIMEOUT_MS` controls each Live Nation H.I.P. page request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `LIVEFANS_SYNC_KEYWORDS` controls public LiveFans search keywords. It defaults to `K-POP,J-POP,ライブ,コンサート,フェス,ROCK,アジア`.
- `LIVEFANS_KEYWORD_LIMIT` caps LiveFans keyword searches per run. It defaults to `4`, is clamped from `1` to `8`, and can be set as a GitHub repository variable.
- `LIVEFANS_ROW_LIMIT` caps LiveFans rows inserted per run. It defaults to `60`, is clamped from `1` to `100`, and can be set as a GitHub repository variable.
- `LIVEFANS_FETCH_TIMEOUT_MS` controls each LiveFans page request timeout. It defaults to `12000`, is clamped from `3000` to `30000`, and can be set as a GitHub repository variable.
- `ALERT_WEBHOOK_ATTEMPTS` controls retry attempts for transient alert webhook HTTP failures and network exceptions. It defaults to `3`, is clamped from `1` to `5`, and can be set as a GitHub repository variable for `Dispatch Due Alerts`.
- `ALERT_WEBHOOK_TIMEOUT_MS` controls each alert webhook request timeout. It defaults to `10000`, is clamped from `1000` to `30000`, and can be set as a GitHub repository variable for `Dispatch Due Alerts`.
- `ALERT_WEBHOOK_SECRET` optionally signs alert webhook payloads so downstream delivery workers can reject spoofed requests before processing.
- `ALERT_QUEUE_CONNECT_TIMEOUT_SECONDS`, `ALERT_QUEUE_MAX_TIME_SECONDS`, and `ALERT_QUEUE_RETRY_ATTEMPTS` control the lightweight due-alert precheck in GitHub Actions. They default to `10`, `30`, and `2` so a transient Vercel or network hang cannot consume the full job timeout.
- `SYNC_PUBLIC_SOURCES` limits `npm run sync:public-sources` to a comma-separated subset such as `lawson,pia`.
- `SYNC_CONTINUE_ON_ERROR=true` lets source sync orchestration continue later sources after an earlier source fails.
- `SYNC_STALE_AFTER_HOURS` controls when the admin stats API marks the latest sync run as delayed. It defaults to `108` hours to cover the constrained twice-weekly Ticketmaster schedule with slack.

## External Source Notes

Supported automated sources:

- `Ticketmaster`: official Discovery API for Japan events.
- `e+`: public search HTML payload from `https://eplus.jp/sf/search`.
- `Ticket Pia`: public search HTML from `https://t.pia.jp/pia/rlsInfo.do`.
- `Lawson Ticket`: public `cdn.l-tike.com` concert/category/search HTML and public `concert/mevent/?mid=...` detail HTML. The sync prefers visible JSON-LD Event data and visible ticket-list/search-result metadata, stores the original `https://l-tike.com/order/...` ticket URL, and records runs under `Lawson Ticket`.
- `Rakuten Ticket`: public music category/detail HTML.
- `Creativeman`: public upcoming/schedule/detail HTML from `https://www.creativeman.co.jp/`.
- `Live Nation H.I.P.`: public home page links and visible public artist/event schedule HTML from `https://www.livenationhip.co.jp/`.
- `LiveFans`: public search and event detail HTML from `https://www.livefans.jp/`, limited to Japan venue rows and linked public ticket pages when present.

`src/lib/publicSources.ts` is the source registry for public sync scripts, Admin sync-health coverage, and Admin search-candidate links. When adding a source, update that registry first, then add the parser/sync script and docs. Scheduled GitHub Actions may still run a smaller subset when quota is constrained; missing run history is surfaced in Admin sync health without failing production health by itself.

Lawson Ticket limitations:

- The sync does not log in, open payment pages, use member-only pages, bypass bot or captcha controls, or call private/undocumented APIs. Direct `https://l-tike.com/` pages can close HTTP/2 connections from some CLI clients, so the implementation reads the publicly mirrored `https://cdn.l-tike.com/` HTML where available and normalizes stored links back to `https://l-tike.com/`.
- 로치케 공연의 결제, 전자티켓 앱, Loppi/편의점 수령, 동행자 등록, 일본 전화번호 인증 조건은 공연마다 다릅니다. Rows are therefore stored conservatively with `ticket_access = 일본 번호 필요`, `phone_required = true`, and a Korean `foreigner_note` telling users to verify account, payment, and pickup restrictions on the original page.
- If public HTML access fails or a run finds zero usable concert rows, existing Lawson Ticket rows are preserved and the outcome is recorded in `sync_runs`. Stale cleanup runs only after at least one usable Lawson Ticket row is produced.

## Release Operations

Normal development flow:

1. Branch from `dev` with a `codex/` prefix.
2. Run `npm run typecheck`, `npm run build`, and `npx playwright test`.
3. Open a PR into `dev` and wait for GitHub CI.
4. Merge to `dev`.
5. Let `Auto Release PR` update the open `dev` to `main` release PR.
6. Leave the release PR open until the next release window. `Merge Release PR` runs at 09:00 and 21:00 KST, or can be run manually for an immediate production release. The workflow first reconciles `dev` with the latest `main` release commit when prior releases have made the branches diverge, merges the clean release PR, then fast-forwards `dev` to the new `main` release commit. If production deploy capacity is exhausted after merge, leave the matching automation issues open and let `Retry Production Deploy` finish the release later. While those blockers are open, automatic `main` push deploys are intentionally skipped to avoid spending more Vercel quota.
7. Verify production with `npm run health:production` or `https://japan-live-radar.vercel.app/api/health`. The public health response includes `latestSyncBySource` so operators can confirm source-specific sync coverage without spending an admin request. `/api/events` also includes the same source summary, including latest success/error status, in `meta.latestSyncBySource`, which powers the app's visible sync coverage label. With `ADMIN_API_TOKEN`, the script also verifies that alert queue tables are ready, alert errors are cleared, and sync health is current.

If Vercel returns `api-deployments-free-per-day` or `build-rate-limit`, continue feature work on `dev` and avoid manual deploy retries until quota resets. Do not close the matching `automation` issue until a later production deploy succeeds and the health check reports `database: "reachable"`.

Vercel Git auto-deployments are disabled by `git.deploymentEnabled: false` in `vercel.json`, and `scripts/vercel-ignore-build.sh` is kept as a fallback guard for any legacy ignored-build path. GitHub Actions `CI` remains the source of truth for PR checks, with push-only duplicate CI intentionally avoided to preserve Actions minutes. Use the `Deploy to Vercel` manual workflow only when a real Vercel preview validation is worth spending quota; production deploys happen from `main` or the retry workflow after quota resets.

## Branch Rules

- Feature: `codex/feature-*`
- Fix: `codex/fix-*`
- UI: `codex/ui-*`
- Chore: `codex/chore-*`

Feature work targets `dev`. Deployable release PRs target `main`.

Draft PRs are the default for Codex-generated feature work. When CI is green and the PR is ready, Codex can mark it ready and enable auto-merge.
