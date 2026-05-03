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

## Checks

```bash
npm run build
npx playwright test
```

## Branch Rules

- Feature: `codex/feature-*`
- Fix: `codex/fix-*`
- UI: `codex/ui-*`
- Chore: `codex/chore-*`

Feature work targets `dev`. Deployable release PRs target `main`.

Draft PRs are the default for Codex-generated feature work. When CI is green and the PR is ready, Codex can mark it ready and enable auto-merge.
