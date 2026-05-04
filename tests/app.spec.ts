import { expect, test } from "@playwright/test";
import { extractDraft } from "../api/import-url";

test("extracts Japanese ticket page sales cues", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>Ado 全国ツアー2026｜チケットぴあ</title>
          <meta property="og:image" content="https://example.com/ado.jpg">
        </head>
        <body>
          <h1>Ado 全国ツアー2026</h1>
          <p>会場：Kアリーナ横浜</p>
          <p>公演日：2026年11月12日 18:30</p>
          <p>抽選受付：2026年5月10日 12:00～2026年5月20日 23:59</p>
          <p>料金：￥9,800～￥14,800</p>
          <p>電子チケットの受取には携帯電話番号・SMS認証が必要です。</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600001"),
  );

  expect(draft.artist).toBe("Ado");
  expect(draft.title).toBe("Ado 全国ツアー2026");
  expect(draft.city).toBe("요코하마");
  expect(draft.date).toBe("2026-11-12");
  expect(draft.time).toBe("18:30");
  expect(draft.source).toBe("Ticket Pia");
  expect(draft.saleType).toBe("추첨 접수");
  expect(draft.saleWindow).toContain("2026年5月10日 12:00");
  expect(draft.price).toBe("¥9,800 - ¥14,800");
  expect(draft.ticketAccess).toBe("일본 번호 필요");
  expect(draft.phoneRequired).toBe(true);
});

test("searches concerts and opens the detail panel", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "일본 콘서트 원정 캘린더" })).toBeVisible();
  await expect(page.getByText("샘플 데이터").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /YOASOBI/ })).toBeVisible();

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("NewJeans");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await page.getByRole("button", { name: /NewJeans/ }).click();

  await expect(page.getByRole("heading", { name: "NewJeans" })).toBeVisible();
  await expect(page.getByText("한국 구매 가능").last()).toBeVisible();
  await expect(page.getByRole("link", { name: /원본 링크 열기/ })).toHaveAttribute(
    "href",
    "https://www.ticketmaster.com/",
  );
});

test("filters by city and ticket access without horizontal overflow", async ({ page }) => {
  await page.goto("/");

  await page.locator("select").first().selectOption("오사카");
  await page.locator("select").nth(1).selectOption("일본 번호 필요");

  await expect(page.getByText("1개 공연")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /ONE OK ROCK/ })).toHaveCount(1);

  await expect
    .poll(async () => {
      try {
        return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      } catch {
        return false;
      }
    })
    .toBe(true);
});

test("combines travel date and Korea-friendly filters", async ({ page }) => {
  await page.goto("/");

  await page.locator("select").nth(2).selectOption("여름 원정");
  await page.getByRole("button", { name: /한국에서 예매 쉬운 공연/ }).click();

  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /NewJeans/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "NewJeans" })).toBeVisible();
});

test("persists local alert selections", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();

  await expect(page.getByRole("button", { name: "알림 2개" })).toBeVisible();
  await expect(page.getByRole("button", { name: "알림 설정됨" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();

  await expect(page.getByRole("button", { name: "알림 2개" })).toBeVisible();
  await expect(page.getByRole("button", { name: "알림 설정됨" })).toBeVisible();
});

test("submits an admin event draft", async ({ page }) => {
  let requestBody: Record<string, unknown> | null = null;
  await page.route("**/api/admin-events", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              id: "manual-test",
              artist: "Mrs. GREEN APPLE",
              title: "Arena Live",
              city: "사이타마",
              venue: "Saitama Super Arena",
              date: "2026-10-04",
              source: "Manual",
              updated_at: "2026-05-04T00:00:00Z",
            },
          ],
        }),
      });
      return;
    }

    requestBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, event: { id: "manual-test" } }),
    });
  });

  await page.goto("/#admin");

  await expect(page.getByRole("heading", { name: "공연 정보 입력" })).toBeVisible();
  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByLabel("아티스트").fill("Mrs. GREEN APPLE");
  await page.getByLabel("공연명").fill("Arena Live");
  await page.getByLabel("도시").fill("사이타마");
  await page.getByLabel("회장").fill("Saitama Super Arena");
  await page.getByLabel("공연일").fill("2026-10-04");
  await page.getByLabel("공연 시간").fill("18:00");
  await page.getByLabel("원본 링크").fill("https://example.com/ticket");
  await page.getByRole("button", { name: "공연 저장" }).click();

  await expect(page.getByText("공연 정보가 저장됐어요.")).toBeVisible();
  await expect(page.getByLabel("최근 입력 공연").getByText("Mrs. GREEN APPLE")).toBeVisible();
  expect(requestBody).toMatchObject({
    artist: "Mrs. GREEN APPLE",
    city: "사이타마",
    venue: "Saitama Super Arena",
    date: "2026-10-04",
  });
});

test("imports an admin draft from a URL", async ({ page }) => {
  await page.route("**/api/import-url", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            url: "https://t.pia.jp/example",
            draft: {
              artist: "YOASOBI",
              title: "YOASOBI Dome Live",
              city: "도쿄",
              venue: "Tokyo Dome",
              date: "2026-11-02",
              time: "18:30",
              source: "Ticket Pia",
              link: "https://t.pia.jp/example",
            },
          },
        ],
      }),
    });
  });
  await page.route("**/api/admin-candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ configured: false, candidates: [] }),
    });
  });

  await page.goto("/#admin");

  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByLabel("URL로 초안 가져오기").fill("https://t.pia.jp/example");
  await Promise.all([
    page.waitForResponse((response) => response.url().includes("/api/import-url") && response.status() === 200),
    page.getByRole("button", { name: "가져오기" }).click(),
  ]);

  await expect(page.getByText("1개 URL 초안을 후보에 추가했어요.")).toBeVisible();
  await expect(page.getByLabel("URL 후보").getByText("YOASOBI")).toBeVisible();
  await expect(page.getByLabel("아티스트")).toHaveValue("YOASOBI");
  await expect(page.getByLabel("공연명")).toHaveValue("YOASOBI Dome Live");
  await expect(page.getByLabel("도시")).toHaveValue("도쿄");
  await expect(page.getByLabel("회장")).toHaveValue("Tokyo Dome");
  await expect(page.getByLabel("URL 후보").getByText("2026-11-02")).toBeVisible();

  await page.getByLabel("아티스트").fill("임시값");
  await page.getByLabel("URL 후보").getByRole("button", { name: "초안 적용" }).click();
  await expect(page.getByLabel("아티스트")).toHaveValue("YOASOBI");
});

test("approves a database-backed import candidate", async ({ page }) => {
  let patchBody: Record<string, unknown> | null = null;
  await page.route("**/api/admin-candidates", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          candidates: [
            {
              id: "candidate-1",
              source: "Ticket Pia",
              sourceUrl: "https://t.pia.jp/candidate",
              status: "pending",
              createdAt: "2026-05-04T00:00:00Z",
              draft: {
                artist: "Ado",
                title: "Blue Flame Tour",
                city: "요코하마",
                venue: "K-Arena Yokohama",
                date: "2026-11-12",
                time: "18:00",
                source: "Ticket Pia",
                link: "https://t.pia.jp/candidate",
              },
            },
          ],
        }),
      });
      return;
    }

    patchBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, event: { id: "event-1" } }),
    });
  });
  await page.route("**/api/admin-events", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ events: [] }),
    });
  });

  await page.goto("/#admin");
  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByRole("button", { name: "후보 새로고침" }).click();

  await expect(page.getByLabel("URL 후보").getByText("Ado", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "승인 저장" }).click();

  await expect(page.getByText("후보를 승인하고 공연으로 저장했어요.")).toBeVisible();
  expect(patchBody).toMatchObject({ id: "candidate-1", action: "approve" });
});

test("creates keyword candidates and shows quality stats", async ({ page }) => {
  await page.route("**/api/search-candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        candidates: [
          {
            id: "search-candidate-1",
            source: "Ticket Pia",
            sourceUrl: "https://t.pia.jp/en/pia/search_dtl_input.do?keyword=Ado",
            status: "pending",
            createdAt: "2026-05-04T00:00:00Z",
            draft: {
              artist: "Ado",
              title: "Ado 공연 검색 후보",
              city: "도쿄",
              venue: "",
              date: "",
              source: "Ticket Pia",
              link: "https://t.pia.jp/en/pia/search_dtl_input.do?keyword=Ado",
            },
          },
        ],
      }),
    });
  });
  await page.route("**/api/admin-stats", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        totalEvents: 5,
        pendingCandidates: 1,
        candidateTableReady: true,
        quality: {
          missingLink: 0,
          missingSaleWindow: 1,
          missingPrice: 1,
          needsAccessReview: 2,
          phoneRequired: 3,
          koreaFriendly: 1,
        },
        bySource: [{ label: "Ticket Pia", count: 3 }],
        byCity: [{ label: "도쿄", count: 2 }],
        generatedAt: "2026-05-04T00:00:00Z",
      }),
    });
  });

  await page.goto("/#admin");
  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByLabel("데이터 품질").getByRole("button", { name: "새로고침" }).click();

  await expect(page.getByLabel("데이터 품질").getByText("공연")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("5개")).toBeVisible();

  await page.getByLabel("검색어 후보 수집").fill("Ado");
  await page.getByRole("button", { name: "후보 만들기" }).click();

  await expect(page.getByText("1개 검색 후보를 만들었어요.")).toBeVisible();
  await expect(page.getByLabel("URL 후보").getByText("Ado", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "초안 적용" }).click();
  await expect(page.getByText("후보를 입력폼에 적용했어요.")).toBeVisible();
});

test("shows an empty state when no concerts match", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("없는공연");

  await expect(page.getByText("0개 공연")).toBeVisible();
  await expect(page.getByText("조건에 맞는 공연이 없어요")).toBeVisible();
  await expect(page.getByText("원정 조건을 조금 넓혀볼까요?")).toBeVisible();
});
