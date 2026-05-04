import { expect, test } from "@playwright/test";

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
  await page.route("/api/admin-events", async (route) => {
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

test("shows an empty state when no concerts match", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("없는공연");

  await expect(page.getByText("0개 공연")).toBeVisible();
  await expect(page.getByText("조건에 맞는 공연이 없어요")).toBeVisible();
  await expect(page.getByText("원정 조건을 조금 넓혀볼까요?")).toBeVisible();
});
