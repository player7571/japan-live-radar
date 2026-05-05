import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { buildAlertStatusUpdate, normalizeAdminAlertListOptions } from "../api/admin-alerts";
import { summarizeAlertQueue, summarizeQualityBySource, summarizeSyncHealth, summarizeSyncRunsAt } from "../api/admin-stats";
import {
  buildAlertUpsertRow,
  calculateReminderAt,
  normalizeAlertContactEmail,
  normalizeAlertLeadTimeHours,
} from "../api/alerts";
import { seedResponse } from "../api/events";
import { assertPublicResolvedAddresses, extractDraft, safeUrl } from "../api/import-url";
import { searchSources } from "../api/search-candidates";
import { migrationFiles } from "../scripts/apply-migrations";
import {
  validateAdminAlertsHealth,
  validateAdminStatsHealth,
  validateProductionHealth,
} from "../scripts/check-production-health";
import {
  buildAppEventUrl,
  buildAlertDeliveryKey,
  buildAlertMessage,
  buildAlertSubject,
  buildAlertWebhookPayload,
  buildAlertWebhookSignature,
  normalizeWebhookAttempts,
  normalizeWebhookTimeoutMs,
  sendWebhook,
  shouldRetryWebhookStatus,
  summarizeDispatchFailures,
} from "../scripts/dispatch-alerts";
import {
  formatSaleWindow,
  isLikelyConcert,
  nextTicketmasterPages,
  normalizeTicketmasterFetchTimeoutMs,
  normalizeTicketmasterPageLimit,
  searchProfiles,
  shouldDeleteStaleTicketmasterRows,
  toTicketmasterEventRow,
} from "../scripts/sync-ticketmaster";
import { toEventRow } from "../src/lib/adminEventRows";
import { rowToEvent } from "../src/lib/eventRows";
import { serverReadKey } from "../src/lib/supabaseServer";
import { seedEvents } from "../src/data/seedEvents";
import { buildAlertEventSnapshot } from "../src/lib/alertSnapshot";
import { splitCandidateRowsByExistingStatus } from "../src/lib/candidateDedupe";
import { currentTokyoDay, getSaleStatus } from "../src/lib/saleStatus";

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

test("rejects private or local admin import URLs", () => {
  expect(() => safeUrl("https://example.com/ticket")).not.toThrow();
  expect(() => safeUrl("https://fc2.com/ticket")).not.toThrow();
  expect(() => safeUrl("https://[2001:4860:4860::8888]/ticket")).not.toThrow();
  expect(() => safeUrl("ftp://example.com/ticket")).toThrow("url must be http or https");

  for (const url of [
    "http://localhost/ticket",
    "http://app.local/ticket",
    "http://127.0.0.1/ticket",
    "http://10.0.0.8/ticket",
    "http://172.16.0.8/ticket",
    "http://192.168.1.8/ticket",
    "http://169.254.169.254/latest/meta-data",
    "http://[::]/ticket",
    "http://[::1]/ticket",
    "http://[::ffff:127.0.0.1]/ticket",
    "http://[::ffff:10.0.0.1]/ticket",
    "http://[::ffff:ac10:1]/ticket",
    "http://[64:ff9b::c0a8:101]/ticket",
    "http://[fc00::1]/ticket",
    "http://[fe80::1]/ticket",
  ]) {
    expect(() => safeUrl(url), url).toThrow("private or local URLs are not allowed");
  }
});

test("rejects admin import URLs that resolve to private or local addresses", () => {
  expect(() => assertPublicResolvedAddresses([{ address: "93.184.216.34" }])).not.toThrow();
  expect(() => assertPublicResolvedAddresses([{ address: "2001:4860:4860::8888" }])).not.toThrow();

  for (const address of [
    "0.0.0.0",
    "10.0.0.8",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.8",
    "192.168.1.8",
    "::",
    "::1",
    "::ffff:7f00:1",
    "64:ff9b::c0a8:101",
    "fc00::1",
    "fe80::1",
  ]) {
    expect(() => assertPublicResolvedAddresses([{ address }]), address).toThrow(
      "private or local URLs are not allowed",
    );
  }
});

test("extracts eplus-style labeled event fields", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>宇多田ヒカル SCIENCE FICTION TOUR｜e+</title>
        </head>
        <body>
          <h1>宇多田ヒカル SCIENCE FICTION TOUR</h1>
          <p>会場：大阪城ホール</p>
          <p>公演日：2026/08/03(土) 18:30</p>
          <p>受付期間：2026/05/10(土) 12:00～05/20(水) 23:59</p>
          <p>料金：12,000円</p>
          <p>海外受付 international ticket credit card available</p>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/0000000001"),
  );

  expect(draft.artist).toBe("宇多田ヒカル SCIENCE FICTION TOUR");
  expect(draft.title).toBe("宇多田ヒカル SCIENCE FICTION TOUR");
  expect(draft.city).toBe("오사카");
  expect(draft.venue).toBe("大阪城ホール");
  expect(draft.date).toBe("2026-08-03");
  expect(draft.time).toBe("18:30");
  expect(draft.source).toBe("e+");
  expect(draft.saleWindow).toContain("2026/05/10(土) 12:00");
  expect(draft.saleWindow).toContain("2026/05/20(水) 23:59");
  expect(draft.price).toBe("¥12,000");
  expect(draft.ticketAccess).toBe("한국 구매 가능");
  expect(draft.phoneRequired).toBe(false);
});

test("uses explicit no-phone overseas cues for Korea-friendly imports", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>YOASOBI ASIA TOUR｜e+</title>
        </head>
        <body>
          <h1>YOASOBI ASIA TOUR</h1>
          <p>会場：札幌文化芸術劇場 hitaru</p>
          <p>公演日：2026年10月04日 18:00</p>
          <p>海外受付 international ticket credit card available</p>
          <p>日本の携帯電話番号は不要です。SMS認証なしで購入できます。</p>
          <p>受付期間：2026年7月1日 12:00～2026年7月8日 23:59</p>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/yoasobi-overseas"),
  );

  expect(draft.city).toBe("삿포로");
  expect(draft.ticketAccess).toBe("한국 구매 가능");
  expect(draft.phoneRequired).toBe(false);
  expect(draft.foreignerNote).toContain("일본 전화번호/SMS 인증 불필요");
});

test("uses overseas phone-number cues for Korea-friendly imported ticket pages", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>LE SSERAFIM Japan Fan Meeting｜e+</title>
        </head>
        <body>
          <h1>LE SSERAFIM Japan Fan Meeting</h1>
          <p>会場：幕張メッセ</p>
          <p>公演日：2026年9月14日 18:00</p>
          <p>海外受付 international ticket credit card available</p>
          <p>電話番号は国番号を選択して登録できます。海外の電話番号でもSMS認証可能です。</p>
          <p>受付期間：2026年6月1日 12:00～2026年6月8日 23:59</p>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/lesserafim-overseas-phone"),
  );

  expect(draft.city).toBe("치바");
  expect(draft.ticketAccess).toBe("한국 구매 가능");
  expect(draft.phoneRequired).toBe(false);
  expect(draft.foreignerNote).toContain("해외 전화번호/SMS 인증 가능");
});

test("flags Japan-only mobile phone registration on imported ticket pages", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>Official HIGE DANdism Arena Live｜ローチケ</title>
        </head>
        <body>
          <h1>Official HIGE DANdism Arena Live</h1>
          <p>会場：大阪城ホール</p>
          <p>公演日：2026年11月02日 18:30</p>
          <p>お申込みには日本国内の携帯電話番号のみ登録できます。SMSを受信できる端末が必要です。</p>
          <p>発売日時：2026年8月1日 10:00</p>
        </body>
      </html>
    `,
    new URL("https://l-tike.com/concert/higedan-phone-only"),
  );

  expect(draft.city).toBe("오사카");
  expect(draft.ticketAccess).toBe("일본 번호 필요");
  expect(draft.phoneRequired).toBe(true);
  expect(draft.foreignerNote).toContain("일본 국내 휴대전화번호/SMS 한정");
});

test("keeps Japan-resident-only ticket pages out of Korea-friendly imports", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>Vaundy arena tour｜ローチケ</title>
        </head>
        <body>
          <h1>Vaundy arena tour</h1>
          <p>会場：Kアリーナ横浜</p>
          <p>公演日：2026年12月12日 18:00</p>
          <p>本受付は日本国内在住者のみ対象です。</p>
          <p>海外からのお申し込みはご利用いただけません。</p>
          <p>海外在住の方は購入できません。</p>
        </body>
      </html>
    `,
    new URL("https://l-tike.com/concert/vaundy-resident-only"),
  );

  expect(draft.city).toBe("요코하마");
  expect(draft.ticketAccess).toBe("확인 필요");
  expect(draft.phoneRequired).toBe(true);
  expect(draft.foreignerNote).toContain("일본 국내 거주자/주소 한정");
});

test("flags Japanese electronic ticket apps as phone-required imports", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>ONE OK ROCK Dome Tour｜チケットぴあ</title>
        </head>
        <body>
          <h1>ONE OK ROCK Dome Tour</h1>
          <p>会場：東京ドーム</p>
          <p>公演日：2026年11月22日 18:00</p>
          <p>本公演は電子チケットアプリ「AnyPASS」でのお受け取りとなります。</p>
          <p>チケプラのPlus member ID登録が必要です。</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600011"),
  );

  expect(draft.city).toBe("도쿄");
  expect(draft.ticketAccess).toBe("일본 번호 필요");
  expect(draft.phoneRequired).toBe(true);
  expect(draft.foreignerNote).toContain("전자티켓 인증");
});

test("adds payment and pickup cues to imported foreigner notes", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>SUPER BEAVER Hall Tour｜ローチケ</title>
          <meta name="description" content="オフィシャル先行受付">
        </head>
        <body>
          <h1>SUPER BEAVER Hall Tour</h1>
          <p>会場：福岡サンパレス</p>
          <p>公演日：2026年9月02日 19:00</p>
          <p>支払方法はクレジットカード決済のみです。</p>
          <p>チケットはローソンまたはミニストップ店頭で発券・受取となります。</p>
        </body>
      </html>
    `,
    new URL("https://l-tike.com/concert/mevent/?mid=2600012"),
  );

  expect(draft.city).toBe("후쿠오카");
  expect(draft.foreignerNote).toContain("オフィシャル先行受付");
  expect(draft.foreignerNote).toContain("신용카드 결제 전용");
  expect(draft.foreignerNote).toContain("편의점 결제/발권");
});

test("adds lottery result announcements to imported foreigner notes", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>Mrs. GREEN APPLE DOME LIVE｜チケットぴあ</title>
        </head>
        <body>
          <h1>Mrs. GREEN APPLE DOME LIVE</h1>
          <p>会場：京セラドーム大阪</p>
          <p>公演日：2026年10月10日 18:00</p>
          <p>抽選受付：2026年6月1日 12:00～2026年6月10日 23:59</p>
          <p>抽選結果発表：2026年6月15日(月) 18:00頃</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600015"),
  );

  expect(draft.city).toBe("오사카");
  expect(draft.saleType).toBe("추첨 접수");
  expect(draft.saleWindow).toContain("2026年6月1日 12:00");
  expect(draft.foreignerNote).toContain("추첨 결과 발표: 2026年6月15日(月) 18:00頃");
});

test("classifies official resale ticket imports", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>King Gnu Stadium Live｜e+</title>
        </head>
        <body>
          <h1>King Gnu Stadium Live</h1>
          <p>会場：日産スタジアム</p>
          <p>公演日：2026年9月21日 18:30</p>
          <p>公式リセール受付：2026年9月1日 12:00～2026年9月10日 23:59</p>
          <p>チケットトレードでの再販売を予定しています。</p>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/kinggnu-resale/"),
  );

  expect(draft.city).toBe("요코하마");
  expect(draft.saleType).toBe("리세일");
  expect(draft.saleWindow).toContain("2026年9月1日 12:00");
});

test("adds identity verification and companion registration cues to imported notes", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>SEKAI NO OWARI Arena Tour｜ローチケ</title>
        </head>
        <body>
          <h1>SEKAI NO OWARI Arena Tour</h1>
          <p>会場：日本ガイシホール</p>
          <p>公演日：2026年10月18日 18:00</p>
          <p>入場時に本人確認を行います。顔写真付き身分証明書またはパスポートをご持参ください。</p>
          <p>同行者登録とチケット分配は来場前にお済ませください。来場者情報の変更はできません。</p>
        </body>
      </html>
    `,
    new URL("https://l-tike.com/concert/sekainoowari-identity"),
  );

  expect(draft.city).toBe("나고야");
  expect(draft.ticketAccess).toBe("확인 필요");
  expect(draft.foreignerNote).toContain("본인확인/신분증/얼굴사진");
  expect(draft.foreignerNote).toContain("동행자 등록/티켓 분배");
});

test("adds fan club and companion membership cues to imported notes", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>IVE Japan Tour｜チケットぴあ</title>
        </head>
        <body>
          <h1>IVE Japan Tour</h1>
          <p>会場：さいたまスーパーアリーナ</p>
          <p>公演日：2026年9月19日 18:00</p>
          <p>FC先行抽選受付：2026年6月1日 12:00～2026年6月8日 23:59</p>
          <p>本受付はファンクラブ有料会員限定です。お申込みには会員認証が必要です。</p>
          <p>同行者もファンクラブ会員登録が必要です。</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600100"),
  );

  expect(draft.city).toBe("사이타마");
  expect(draft.saleType).toBe("추첨 접수");
  expect(draft.saleWindow).toContain("2026年6月1日 12:00");
  expect(draft.foreignerNote).toContain("팬클럽/유료 회원 한정");
  expect(draft.foreignerNote).toContain("동행자도 회원 등록/인증");
});

test("adds special sale and restricted-view cues to imported notes", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>RADWIMPS Arena Live｜チケットぴあ</title>
        </head>
        <body>
          <h1>RADWIMPS Arena Live</h1>
          <p>会場：有明アリーナ</p>
          <p>公演日：2026年11月02日 18:30</p>
          <p>アップグレード抽選受付：2026年8月1日 12:00～2026年8月7日 23:59</p>
          <p>機材席開放につき追加販売を実施します。</p>
          <p>注釈付き指定席、ステージサイド席はステージおよび演出が見えにくい場合があります。</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600099"),
  );

  expect(draft.city).toBe("도쿄");
  expect(draft.saleType).toBe("추첨 접수");
  expect(draft.saleWindow).toContain("2026年8月1日 12:00");
  expect(draft.foreignerNote).toContain("업그레이드 추첨");
  expect(draft.foreignerNote).toContain("추가 판매/기재석 개방");
  expect(draft.foreignerNote).toContain("주석付き/시야제한");
});

test("prefers ticket application links from official imported pages", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>Official髭男dism Arena Tour 2026</title>
        </head>
        <body>
          <h1>Official髭男dism Arena Tour 2026</h1>
          <p>会場：Kアリーナ横浜</p>
          <p>公演日：2026年11月12日 18:30</p>
          <p>受付期間：2026年8月1日 12:00～2026年8月7日 23:59</p>
          <a href="https://eplus.jp/sf/detail/higedan-tour-2026">イープラスでチケット申し込み</a>
          <a href="https://www.youtube.com/watch?v=example">Music video</a>
        </body>
      </html>
    `,
    new URL("https://higedan.example.com/tour/2026"),
  );

  expect(draft.source).toBe("e+");
  expect(draft.link).toBe("https://eplus.jp/sf/detail/higedan-tour-2026");
});

test("extracts Lawson table fields and prefers showtime over doors-open time", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>米津玄師 2026 TOUR | ローチケ</title>
        </head>
        <body>
          <h1>米津玄師 2026 TOUR</h1>
          <table>
            <tr><th>公演日時</th><td>2026/12/24(木) 開場17:30 / 開演18:30</td></tr>
            <tr><th>会場</th><td>さいたまスーパーアリーナ</td></tr>
            <tr><th>発売日時</th><td>2026/06/01(月) 10:00</td></tr>
            <tr><th>席種・料金</th><td>指定席 11,000円</td></tr>
          </table>
          <p>ローチケ電子チケットはSMS認証が必要です。</p>
        </body>
      </html>
    `,
    new URL("https://l-tike.com/concert/mevent/?mid=123456"),
  );

  expect(draft.artist).toBe("米津玄師 2026 TOUR");
  expect(draft.city).toBe("사이타마");
  expect(draft.venue).toBe("さいたまスーパーアリーナ");
  expect(draft.date).toBe("2026-12-24");
  expect(draft.time).toBe("18:30");
  expect(draft.source).toBe("Lawson Ticket");
  expect(draft.saleWindow).toBe("2026/06/01(月) 10:00");
  expect(draft.price).toBe("¥11,000");
  expect(draft.ticketAccess).toBe("일본 번호 필요");
});

test("normalizes full-width unlabeled OPEN/START showtimes", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>藤井風 Stadium Live｜チケットぴあ</title>
        </head>
        <body>
          <h1>藤井風 Stadium Live</h1>
          <p>会場：横浜アリーナ</p>
          <p>２０２６年１１月１２日（木） OPEN １８：００ / START １９：００</p>
          <p>料金：９,８００円</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600005"),
  );

  expect(draft.city).toBe("요코하마");
  expect(draft.date).toBe("2026-11-12");
  expect(draft.time).toBe("19:00");
  expect(draft.price).toBe("¥9,800");
});

test("prefers Japanese showtime words with hour-minute notation", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <title>Vaundy one man live｜ローチケ</title>
        </head>
        <body>
          <h1>Vaundy one man live</h1>
          <p>会場：大阪城ホール</p>
          <p>公演日時：2026年12月25日(金) 開場18時00分／開演19時00分</p>
        </body>
      </html>
    `,
    new URL("https://l-tike.com/concert/mevent/?mid=2600006"),
  );

  expect(draft.city).toBe("오사카");
  expect(draft.date).toBe("2026-12-25");
  expect(draft.time).toBe("19:00");
});

test("detects additional Japanese concert cities from imported pages", () => {
  expect(
    extractDraft(
      `
        <html>
          <head><title>BUMP OF CHICKEN TOUR｜チケットぴあ</title></head>
          <body>
            <h1>BUMP OF CHICKEN TOUR</h1>
            <p>会場：仙台サンプラザホール</p>
            <p>公演日：2026年9月14日 18:30</p>
          </body>
        </html>
      `,
      new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600002"),
    ).city,
  ).toBe("센다이");

  expect(
    extractDraft(
      `
        <html>
          <head><title>Perfume LIVE｜ローチケ</title></head>
          <body>
            <h1>Perfume LIVE</h1>
            <p>会場：広島グリーンアリーナ</p>
            <p>公演日：2026年9月15日 18:30</p>
          </body>
        </html>
      `,
      new URL("https://l-tike.com/concert/mevent/?mid=654321"),
    ).city,
  ).toBe("히로시마");
});

test("detects city from major venue aliases when city text is absent", () => {
  expect(
    extractDraft(
      `
        <html>
          <head><title>King Gnu Stadium Live｜チケットぴあ</title></head>
          <body>
            <h1>King Gnu Stadium Live</h1>
            <p>会場：日産スタジアム</p>
            <p>公演日：2026年10月10日 18:30</p>
          </body>
        </html>
      `,
      new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600007"),
    ).city,
  ).toBe("요코하마");

  expect(
    extractDraft(
      `
        <html>
          <head><title>Mrs. GREEN APPLE Live｜ローチケ</title></head>
          <body>
            <h1>Mrs. GREEN APPLE Live</h1>
            <p>会場：幕張メッセ 国際展示場</p>
            <p>公演日：2026年10月11日 17:00</p>
          </body>
        </html>
      `,
      new URL("https://l-tike.com/concert/mevent/?mid=2600008"),
    ).city,
  ).toBe("치바");
});

test("captures text-only ticket availability cues from imported pages", () => {
  expect(
    extractDraft(
      `
        <html>
          <head><title>Aimer Hall Tour｜チケットぴあ</title></head>
          <body>
            <h1>Aimer Hall Tour</h1>
            <p>会場：東京ガーデンシアター</p>
            <p>公演日：2026年9月21日 18:30</p>
            <p>チケットは予定枚数終了しました。</p>
          </body>
        </html>
      `,
      new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600003"),
    ).saleWindow,
  ).toBe("予定枚数終了");

  expect(
    extractDraft(
      `
        <html>
          <head><title>MAN WITH A MISSION LIVE｜ローチケ</title></head>
          <body>
            <h1>MAN WITH A MISSION LIVE</h1>
            <p>会場：仙台GIGS</p>
            <p>公演日：2026年9月22日 18:30</p>
            <p>現在チケット発売中です。</p>
          </body>
        </html>
      `,
      new URL("https://l-tike.com/concert/mevent/?mid=2600004"),
    ).saleWindow,
  ).toBe("チケット発売中");
});

test("extracts Japanese hour-minute sale windows from imported pages", () => {
  const draft = extractDraft(
    `
      <html>
        <head><title>LiSA Arena Tour｜チケットぴあ</title></head>
        <body>
          <h1>LiSA Arena Tour</h1>
          <p>会場：日本武道館</p>
          <p>公演日：2026年11月12日 18:30</p>
          <p>販売期間：2026年5月10日 12時00分～2026年5月20日 23時59分</p>
        </body>
      </html>
    `,
    new URL("https://t.pia.jp/pia/event/event.do?eventCd=2600009"),
  );

  expect(draft.city).toBe("도쿄");
  expect(draft.saleWindow).toBe("2026年5月10日 12時00分 - 2026年5月20日 23時59分");
});

test("combines separated sale start and end fields from imported pages", () => {
  const draft = extractDraft(
    `
      <html>
        <head><title>RADWIMPS Arena Tour｜e+</title></head>
        <body>
          <h1>RADWIMPS Arena Tour</h1>
          <dl>
            <dt>会場</dt><dd>東京ガーデンシアター</dd>
            <dt>公演日</dt><dd>2026/10/04(日) 開演18:00</dd>
            <dt>受付開始日時</dt><dd>2026/06/02(火) 12:00</dd>
            <dt>受付終了日時</dt><dd>06/15(月) 23:59</dd>
          </dl>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/radwimps-separated-window"),
  );

  expect(draft.city).toBe("도쿄");
  expect(draft.saleWindow).toBe("2026/06/02(火) 12:00 - 2026/06/15(月) 23:59");
});

test("infers sale window years from imported event dates", () => {
  const draft = extractDraft(
    `
      <html>
        <head><title>YOASOBI Dome Live｜ticket board</title></head>
        <body>
          <h1>YOASOBI Dome Live</h1>
          <dl>
            <dt>公演日時</dt><dd>2026年12月12日(土) 開演18:30</dd>
            <dt>会場</dt><dd>京セラドーム大阪</dd>
          </dl>
          <p>抽選受付期間：5/10(土) 12:00～5/20(水) 23:59</p>
          <p>電子チケットはticket boardでの受取となり、SMS認証が必要です。</p>
        </body>
      </html>
    `,
    new URL("https://ticket.tickebo.jp/show/event.html?info=yoasobi"),
  );

  expect(draft.city).toBe("오사카");
  expect(draft.source).toBe("ticket board");
  expect(draft.saleType).toBe("추첨 접수");
  expect(draft.saleWindow).toBe("2026/5/10(土) 12:00 - 2026/5/20(水) 23:59");
  expect(draft.ticketAccess).toBe("일본 번호 필요");
});

test("extracts ticket board lottery application windows and regional cities", () => {
  const draft = extractDraft(
    `
      <html>
        <head><title>BE:FIRST ARENA TOUR 2026｜ticket board</title></head>
        <body>
          <h1>BE:FIRST ARENA TOUR 2026｜ticket board</h1>
          <dl>
            <dt>公演日時</dt><dd>2026年11月23日(月・祝) 開場17:00 / 開演18:00</dd>
            <dt>会場</dt><dd>朱鷺メッセ 新潟コンベンションセンター</dd>
          </dl>
          <p>抽選申込期間：6/1(月) 12:00～6/10(水) 23:59</p>
          <p>電子チケットはticket boardアプリでの受取となります。SMS認証が必要です。</p>
        </body>
      </html>
    `,
    new URL("https://ticket.tickebo.jp/show/event.html?info=befirst-niigata"),
  );

  expect(draft.title).toBe("BE:FIRST ARENA TOUR 2026");
  expect(draft.city).toBe("니가타");
  expect(draft.venue).toBe("朱鷺メッセ 新潟コンベンションセンター");
  expect(draft.date).toBe("2026-11-23");
  expect(draft.time).toBe("18:00");
  expect(draft.source).toBe("ticket board");
  expect(draft.saleType).toBe("추첨 접수");
  expect(draft.saleWindow).toBe("2026/6/1(月) 12:00 - 2026/6/10(水) 23:59");
  expect(draft.ticketAccess).toBe("일본 번호 필요");
});

test("classifies sale status from text-only availability cues", () => {
  expect(currentTokyoDay(new Date("2026-05-04T17:30:00Z")).toISOString()).toBe(
    new Date("2026-05-05T00:00:00+09:00").toISOString(),
  );
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "販売中" })).toBe("판매 중");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "受付終了" })).toBe("판매 종료");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "発売予定" })).toBe("오픈 예정");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "판매 중" })).toBe("판매 중");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "판매 종료" })).toBe("판매 종료");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "오픈 예정" })).toBe("오픈 예정");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "" })).toBe("확인 필요");
});

test("extracts array-based JSON-LD event data", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Event",
              "name": "King Gnu Stadium Live",
              "startDate": "2026-09-05T19:00:00+09:00",
              "performer": [{ "@type": "MusicGroup", "name": "King Gnu" }],
              "location": {
                "@type": "Place",
                "name": "日産スタジアム",
                "address": "神奈川県横浜市港北区小机町3300"
              },
              "offers": [
                {
                  "@type": "Offer",
                  "price": "15000",
                  "validFrom": "2026-06-10T12:00:00+09:00",
                  "validThrough": "2026-06-20T23:59:00+09:00"
                }
              ],
              "image": [{ "@type": "ImageObject", "url": "https://example.com/king-gnu.jpg" }]
            }
          </script>
        </head>
        <body>
          <p>海外受付 international ticket credit card available</p>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/123456"),
  );

  expect(draft.artist).toBe("King Gnu");
  expect(draft.title).toBe("King Gnu Stadium Live");
  expect(draft.city).toBe("요코하마");
  expect(draft.venue).toBe("日産スタジアム");
  expect(draft.date).toBe("2026-09-05");
  expect(draft.time).toBe("19:00");
  expect(draft.saleWindow).toBe("2026-06-10T12:00:00+09:00 - 2026-06-20T23:59:00+09:00");
  expect(draft.price).toBe("¥15,000");
  expect(draft.ticketAccess).toBe("한국 구매 가능");
  expect(draft.image).toBe("https://example.com/king-gnu.jpg");
});

test("extracts JSON-LD offer availability start and end windows", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Event",
              "name": "LE SSERAFIM Japan Fan Meeting",
              "startDate": "2026-08-22T18:00:00+09:00",
              "location": {
                "@type": "Place",
                "name": "有明アリーナ",
                "address": "東京都江東区"
              },
              "offers": {
                "@type": "Offer",
                "availabilityStarts": "2026-05-15T12:00:00+09:00",
                "availabilityEnds": "2026-05-28T23:59:00+09:00",
                "availability": "https://schema.org/PreOrder",
                "price": "12000"
              }
            }
          </script>
        </head>
        <body>
          <p>海外受付 international ticket credit card available</p>
          <p>日本の携帯電話番号は不要です。</p>
        </body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/lesserafim-fanmeeting"),
  );

  expect(draft.city).toBe("도쿄");
  expect(draft.saleWindow).toBe("2026-05-15T12:00:00+09:00 - 2026-05-28T23:59:00+09:00");
  expect(draft.price).toBe("¥12,000");
  expect(draft.ticketAccess).toBe("한국 구매 가능");
});

test("uses JSON-LD offer availability when sale dates are absent", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Event",
              "name": "Aimer Arena Live",
              "startDate": "2026-10-03T18:00:00+09:00",
              "location": {
                "@type": "Place",
                "name": "大阪城ホール",
                "address": "大阪府大阪市"
              },
              "offers": {
                "@type": "Offer",
                "availability": "https://schema.org/SoldOut",
                "price": "9800"
              }
            }
          </script>
        </head>
        <body></body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/aimer-arena-live"),
  );

  expect(draft.saleWindow).toBe("予定枚数終了");
  expect(draft.price).toBe("¥9,800");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: draft.saleWindow })).toBe("판매 종료");
});

test("extracts JSON-LD aggregate and fallback offers", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Event",
              "name": "YOASOBI Dome Live",
              "startDate": "2026-09-20T17:00:00+09:00",
              "location": {
                "@type": "Place",
                "name": "東京ドーム",
                "address": "東京都文京区"
              },
              "offers": [
                {
                  "@type": "AggregateOffer",
                  "lowPrice": "9800",
                  "highPrice": "14800",
                  "availability": "https://schema.org/InStock"
                },
                {
                  "@type": "Offer",
                  "validFrom": "2026-06-01T12:00:00+09:00"
                }
              ]
            }
          </script>
        </head>
        <body></body>
      </html>
    `,
    new URL("https://eplus.jp/sf/detail/yoasobi-dome-live"),
  );

  expect(draft.price).toBe("¥9,800 - ¥14,800");
  expect(draft.saleWindow).toBe("2026-06-01T12:00:00+09:00");
});

test("prefers JSON-LD offer ticket URLs when source pages have no ticket links", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Event",
              "name": "Ado Special Live",
              "startDate": "2026-12-12T18:00:00+09:00",
              "performer": { "@type": "MusicGroup", "name": "Ado" },
              "location": {
                "@type": "Place",
                "name": "Kアリーナ横浜",
                "address": "神奈川県横浜市"
              },
              "offers": {
                "@type": "Offer",
                "url": "https://l-tike.com/concert/ado-special-live/",
                "validFrom": "2026-08-01T12:00:00+09:00",
                "price": "11000"
              }
            }
          </script>
        </head>
        <body>
          <p>チケット受付の詳細は販売ページをご確認ください。</p>
        </body>
      </html>
    `,
    new URL("https://www.universal-music.co.jp/ado/news/special-live/"),
  );

  expect(draft.artist).toBe("Ado");
  expect(draft.link).toBe("https://l-tike.com/concert/ado-special-live/");
  expect(draft.source).toBe("Lawson Ticket");
  expect(draft.saleWindow).toBe("2026-08-01T12:00:00+09:00");
  expect(draft.price).toBe("¥11,000");
});

test("extracts nested JSON-LD aggregate offer ticket windows", () => {
  const draft = extractDraft(
    `
      <html>
        <head>
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "@type": "Event",
              "name": "IVE Japan Arena Tour",
              "startDate": "2026-11-03T18:30:00+09:00",
              "performer": { "@type": "MusicGroup", "name": "IVE" },
              "location": {
                "@type": "Place",
                "name": "大阪城ホール",
                "address": "大阪府大阪市"
              },
              "offers": {
                "@type": "AggregateOffer",
                "lowPrice": "9800",
                "highPrice": "16800",
                "offers": [
                  {
                    "@type": "Offer",
                    "url": "https://ticket.pia.jp/pia/event.do?eventCd=2601234",
                    "validFrom": "2026-07-01T12:00:00+09:00",
                    "validThrough": "2026-07-10T23:59:00+09:00"
                  }
                ]
              }
            }
          </script>
        </head>
        <body>
          <p>抽選受付の詳細をご確認ください。</p>
        </body>
      </html>
    `,
    new URL("https://www.ive-official.jp/news/arena-tour"),
  );

  expect(draft.artist).toBe("IVE");
  expect(draft.city).toBe("오사카");
  expect(draft.price).toBe("¥9,800 - ¥16,800");
  expect(draft.saleWindow).toBe("2026-07-01T12:00:00+09:00 - 2026-07-10T23:59:00+09:00");
  expect(draft.link).toBe("https://ticket.pia.jp/pia/event.do?eventCd=2601234");
  expect(draft.source).toBe("Ticket Pia");
});

test("calculates alert reminders from sale windows and event dates", () => {
  const now = new Date("2026-05-04T00:00:00+09:00");

  expect(
    calculateReminderAt(
      {
        id: "ado-2026",
        date: "2026-11-12",
        saleWindow: "2026年5月10日 12:00～2026年5月20日 23:59",
      },
      now,
    ),
  ).toBe(new Date("2026-05-10T09:00:00+09:00").toISOString());

  expect(
    calculateReminderAt(
      {
        id: "ado-2026",
        date: "2026-11-12",
        saleWindow: "2026年5月10日 12:00～2026年5月20日 23:59",
      },
      now,
      24,
    ),
  ).toBe(new Date("2026-05-09T12:00:00+09:00").toISOString());

  expect(
    calculateReminderAt(
      {
        id: "newjeans-2026",
        date: "2026-06-01",
      },
      now,
    ),
  ).toBe(new Date("2026-05-25T09:00:00+09:00").toISOString());
});

test("calculates alert reminders from Japanese hour-minute sale windows", () => {
  const now = new Date("2026-05-04T00:00:00+09:00");

  expect(
    calculateReminderAt(
      {
        id: "lisa-2026",
        date: "2026-11-12",
        saleWindow: "2026年5月10日 12時00分～2026年5月20日 23時59分",
      },
      now,
    ),
  ).toBe(new Date("2026-05-10T09:00:00+09:00").toISOString());

  expect(
    calculateReminderAt(
      {
        id: "short-window-2026",
        date: "2026-11-12",
        saleWindow: "5月10日 12時00分 - 5月20日 23時59分",
      },
      now,
    ),
  ).toBe(new Date("2026-05-10T09:00:00+09:00").toISOString());
});

test("calculates alert reminders from ISO sale start timestamps", () => {
  const now = new Date("2026-05-04T00:00:00+09:00");

  expect(
    calculateReminderAt(
      {
        id: "king-gnu-2026",
        date: "2026-09-05",
        saleWindow: "2026-06-10T12:00:00+09:00",
      },
      now,
    ),
  ).toBe(new Date("2026-06-10T09:00:00+09:00").toISOString());
});

test("calculates alert reminders from short sale windows using the event year", () => {
  const now = new Date("2026-05-04T00:00:00+09:00");

  expect(
    calculateReminderAt(
      {
        id: "ticketmaster-2026",
        date: "2026-08-08",
        saleWindow: "6.02 11:00 - 8.07 18:00",
      },
      now,
    ),
  ).toBe(new Date("2026-06-02T08:00:00+09:00").toISOString());
});

test("formats Ticketmaster sale windows for alert parsing", () => {
  const saleWindow = formatSaleWindow({
    id: "tm-1",
    sales: {
      public: {
        startDateTime: "2026-06-02T02:00:00Z",
        endDateTime: "2026-08-07T09:00:00Z",
      },
    },
  });

  expect(saleWindow).toBe("일반 판매: 2026.06.02 11:00 - 2026.08.07 18:00");
  expect(formatSaleWindow({ id: "tm-onsale", dates: { status: { code: "onsale" } } })).toBe("판매 중");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "판매 중" })).toBe("판매 중");
  expect(formatSaleWindow({ id: "tm-offsale", dates: { status: { code: "offsale" } } })).toBe("판매 종료");
  expect(getSaleStatus({ ...seedEvents[0], saleWindow: "판매 종료" })).toBe("판매 종료");
  expect(formatSaleWindow({ id: "tm-cancelled", dates: { status: { code: "cancelled" } } })).toBe("공연 취소");
  expect(
    calculateReminderAt(
      {
        id: "ticketmaster-2026",
        date: "2026-08-08",
        saleWindow: saleWindow ?? "",
      },
      new Date("2026-05-04T00:00:00+09:00"),
    ),
  ).toBe(new Date("2026-06-02T08:00:00+09:00").toISOString());
});

test("preserves Ticketmaster presale windows before public sale windows", () => {
  const event = {
    id: "tm-presale",
    name: "YOASOBI Arena Tour",
    url: "https://www.ticketmaster.com/event/tm-presale",
    dates: { start: { localDate: "2026-09-20", localTime: "18:00:00" } },
    sales: {
      presales: [
        {
          name: "Fan Club Presale",
          startDateTime: "2026-06-01T03:00:00Z",
          endDateTime: "2026-06-05T14:59:00Z",
        },
        {
          name: "Venue Presale",
          startDateTime: "2026-05-20T01:00:00Z",
          endDateTime: "2026-05-22T14:59:00Z",
        },
      ],
      public: {
        startDateTime: "2026-07-01T01:00:00Z",
        endDateTime: "2026-09-19T09:00:00Z",
      },
    },
    classifications: [{ segment: { name: "Music" }, genre: { name: "J-Pop" } }],
    _embedded: {
      attractions: [{ name: "YOASOBI" }],
      venues: [{ name: "Saitama Super Arena", city: { name: "Saitama" } }],
    },
  };

  expect(formatSaleWindow(event)).toBe(
    "선예매 - Venue Presale: 2026.05.20 10:00 - 2026.05.22 23:59 / 선예매 - Fan Club Presale: 2026.06.01 12:00 - 2026.06.05 23:59 / 일반 판매: 2026.07.01 10:00 - 2026.09.19 18:00",
  );

  const row = toTicketmasterEventRow(event);
  expect(row).toMatchObject({
    sale_type: "선착 판매",
    sale_window:
      "선예매 - Venue Presale: 2026.05.20 10:00 - 2026.05.22 23:59 / 선예매 - Fan Club Presale: 2026.06.01 12:00 - 2026.06.05 23:59 / 일반 판매: 2026.07.01 10:00 - 2026.09.19 18:00",
  });
  expect(
    calculateReminderAt(
      {
        id: "tm-presale",
        date: "2026-09-20",
        saleWindow: row?.sale_window ?? "",
      },
      new Date("2026-05-01T00:00:00+09:00"),
    ),
  ).toBe(new Date("2026-05-20T07:00:00+09:00").toISOString());
});

test("schedules alerts from the earliest future sale window", () => {
  const saleWindow =
    "일반 판매: 2026.07.01 10:00 - 2026.09.19 18:00 / 선예매: 2026.05.20 10:00 - 2026.05.22 23:59";

  expect(
    calculateReminderAt(
      {
        id: "unsorted-sale-windows",
        date: "2026-09-20",
        saleWindow,
      },
      new Date("2026-05-01T00:00:00+09:00"),
    ),
  ).toBe(new Date("2026-05-20T07:00:00+09:00").toISOString());

  expect(
    calculateReminderAt(
      {
        id: "expired-presale",
        date: "2026-09-20",
        saleWindow:
          "선예매: 2026.05.20 10:00 - 2026.05.22 23:59 / 일반 판매: 2026.07.01 10:00 - 2026.09.19 18:00",
      },
      new Date("2026-06-01T00:00:00+09:00"),
    ),
  ).toBe(new Date("2026-07-01T07:00:00+09:00").toISOString());
});

test("queries Ticketmaster by music classification as well as keywords", () => {
  expect(searchProfiles).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        label: "music-classification",
        params: { classificationName: "music" },
      }),
    ]),
  );
});

test("limits Ticketmaster pagination while following available pages", () => {
  expect(normalizeTicketmasterPageLimit(undefined)).toBe(2);
  expect(normalizeTicketmasterPageLimit("0")).toBe(1);
  expect(normalizeTicketmasterPageLimit("8")).toBe(5);
  expect(normalizeTicketmasterFetchTimeoutMs(undefined)).toBe(12000);
  expect(normalizeTicketmasterFetchTimeoutMs("1000")).toBe(3000);
  expect(normalizeTicketmasterFetchTimeoutMs("45000")).toBe(30000);
  expect(nextTicketmasterPages({ number: 0, totalPages: 4 }, 3)).toEqual([1, 2]);
  expect(nextTicketmasterPages({ number: 1, totalPages: 4 }, 3)).toEqual([2]);
  expect(nextTicketmasterPages({ number: 0, totalPages: 1 }, 3)).toEqual([]);
});

test("preserves Ticketmaster rows when a sync produces zero usable rows", () => {
  expect(shouldDeleteStaleTicketmasterRows(3, [])).toBe(true);
  expect(shouldDeleteStaleTicketmasterRows(0, [])).toBe(false);
  expect(shouldDeleteStaleTicketmasterRows(3, ["music-keyword"])).toBe(false);
});

test("summarizes latest sync run per source for admin quality checks", () => {
  expect(
    summarizeSyncRunsAt(
      [
        {
          source: "ticketmaster",
          status: "success",
          fetched_count: 420,
          upserted_count: 390,
          skipped_count: 30,
          message: null,
          finished_at: "2026-05-04T10:00:00Z",
        },
        {
          source: "ticketmaster",
          status: "error",
          fetched_count: 0,
          upserted_count: 0,
          skipped_count: 0,
          message: "older failure",
          finished_at: "2026-05-03T10:00:00Z",
        },
        {
          source: "seed",
          status: "success",
          fetched_count: null,
          upserted_count: 8,
          skipped_count: null,
          message: null,
          finished_at: "2026-05-04T09:00:00Z",
        },
      ],
      new Date("2026-05-05T12:00:00Z"),
    ),
  ).toEqual([
    {
      source: "ticketmaster",
      status: "success",
      fetchedCount: 420,
      upsertedCount: 390,
      skippedCount: 30,
      message: null,
      finishedAt: "2026-05-04T10:00:00Z",
      ageHours: 26,
    },
    {
      source: "seed",
      status: "success",
      fetchedCount: 0,
      upsertedCount: 8,
      skippedCount: 0,
      message: null,
      finishedAt: "2026-05-04T09:00:00Z",
      ageHours: 27,
    },
  ]);
});

test("summarizes source-specific event quality gaps", () => {
  expect(
    summarizeQualityBySource([
      {
        id: "tm-1",
        source: "Ticketmaster",
        city: "도쿄",
        date: "2026-08-01",
        ticket_access: "확인 필요",
        phone_required: null,
        link: null,
        sale_window: null,
        price: null,
      },
      {
        id: "tm-2",
        source: "Ticketmaster",
        city: "오사카",
        date: "2026-08-02",
        ticket_access: "한국 구매 가능",
        phone_required: false,
        link: "https://www.ticketmaster.com/event/tm-2",
        sale_window: "판매 중",
        price: "¥9,000",
      },
      {
        id: "pia-1",
        source: "Ticket Pia",
        city: "요코하마",
        date: "2026-08-03",
        ticket_access: "확인 필요",
        phone_required: true,
        link: "https://t.pia.jp/example",
        sale_window: "2026年5月10日 12:00",
        price: null,
      },
    ]),
  ).toEqual([
    {
      source: "Ticketmaster",
      total: 2,
      missingLink: 1,
      missingSaleWindow: 1,
      missingPrice: 1,
      needsAccessReview: 1,
    },
    {
      source: "Ticket Pia",
      total: 1,
      missingLink: 0,
      missingSaleWindow: 0,
      missingPrice: 1,
      needsAccessReview: 1,
    },
  ]);
});

test("flags stale and errored sync runs for admin stats", () => {
  expect(
    summarizeSyncHealth(
      [
        {
          source: "ticketmaster",
          status: "success",
          fetched_count: 420,
          upserted_count: 390,
          skipped_count: 30,
          message: null,
          finished_at: "2026-05-04T10:00:00Z",
        },
        {
          source: "seed",
          status: "success",
          fetched_count: null,
          upserted_count: 8,
          skipped_count: null,
          message: null,
          finished_at: "2026-05-04T09:00:00Z",
        },
      ],
      new Date("2026-05-05T12:00:00Z"),
      30,
    ),
  ).toMatchObject({
    status: "healthy",
    lastFinishedAt: "2026-05-04T10:00:00Z",
    staleSources: [],
    errorSources: [],
  });

  expect(
    summarizeSyncHealth(
      [
        {
          source: "ticketmaster",
          status: "success",
          fetched_count: 420,
          upserted_count: 390,
          skipped_count: 30,
          message: null,
          finished_at: "2026-05-04T10:00:00Z",
        },
      ],
      new Date("2026-05-06T17:00:00Z"),
      30,
    ),
  ).toMatchObject({
    status: "stale",
    staleSources: ["ticketmaster"],
  });

  expect(
    summarizeSyncHealth(
      [
        {
          source: "ticketmaster",
          status: "error",
          fetched_count: 0,
          upserted_count: 0,
          skipped_count: 0,
          message: "rate limited",
          finished_at: "2026-05-05T11:00:00Z",
        },
      ],
      new Date("2026-05-05T12:00:00Z"),
      30,
    ),
  ).toMatchObject({
    status: "error",
    errorSources: ["ticketmaster"],
  });
});

test("maps Ticketmaster events as Korea-friendly rows", () => {
  const row = toTicketmasterEventRow({
    id: "tm-korea-friendly",
    name: "NewJeans Live in Fukuoka",
    url: "https://www.ticketmaster.com/event/tm-korea-friendly",
    dates: { start: { localDate: "2026-08-08", localTime: "17:30:00" } },
    sales: {
      public: {
        startDateTime: "2026-06-02T02:00:00Z",
        endDateTime: "2026-08-07T09:00:00Z",
      },
    },
    priceRanges: [
      { min: 9800, max: 14800, currency: "JPY" },
      { min: 6500, max: 22000, currency: "JPY" },
    ],
    classifications: [{ segment: { name: "Music" }, genre: { name: "K-Pop" } }],
    _embedded: {
      attractions: [{ name: "NewJeans" }],
      venues: [{ name: "Marine Messe Fukuoka", city: { name: "Fukuoka" } }],
    },
  });

  expect(row).toMatchObject({
    artist: "NewJeans",
    city: "후쿠오카",
    ticket_access: "한국 구매 가능",
    phone_required: false,
    price: "¥6,500 - ¥22,000",
  });
  expect(row?.foreigner_note).toContain("해외 계정/카드");
});

test("aggregates Ticketmaster price ranges without mixing currencies", () => {
  const row = toTicketmasterEventRow({
    id: "tm-price-ranges",
    name: "YOASOBI Arena",
    url: "https://www.ticketmaster.com/event/tm-price-ranges",
    dates: { start: { localDate: "2026-09-12", localTime: "18:00:00" } },
    priceRanges: [
      { min: 100, max: 140, currency: "USD" },
      { min: 7200, max: 9800, currency: "JPY" },
      { min: 6500, max: 12800, currency: "JPY" },
    ],
    classifications: [{ segment: { name: "Music" }, genre: { name: "J-Pop" } }],
    _embedded: {
      attractions: [{ name: "YOASOBI" }],
      venues: [{ name: "Osaka Jo Hall", city: { name: "Osaka" } }],
    },
  });

  expect(row?.price).toBe("¥6,500 - ¥12,800");
});

test("maps Ticketmaster UTC datetimes to Tokyo local event dates and times", () => {
  const row = toTicketmasterEventRow({
    id: "tm-tokyo-time",
    name: "Ado Countdown Live",
    url: "https://www.ticketmaster.com/event/tm-tokyo-time",
    dates: { start: { dateTime: "2026-12-31T15:30:00Z" } },
    classifications: [{ segment: { name: "Music" }, genre: { name: "J-Pop" } }],
    _embedded: {
      attractions: [{ name: "Ado" }],
      venues: [{ name: "Tokyo Dome", city: { name: "Tokyo" } }],
    },
  });

  expect(row).toMatchObject({
    date: "2027-01-01",
    time: "00:30",
    city: "도쿄",
  });
});

test("normalizes more Ticketmaster venue city aliases for Korean filters", () => {
  expect(
    toTicketmasterEventRow({
      id: "tm-shizuoka-prefecture",
      name: "Fuji Rock Side Show",
      dates: { start: { localDate: "2026-08-12" } },
      classifications: [{ segment: { name: "Music" } }],
      _embedded: {
        venues: [{ name: "Venue TBA", city: { name: "4100" }, state: { name: "Shizuoka" } }],
      },
    })?.city,
  ).toBe("시즈오카");

  expect(
    toTicketmasterEventRow({
      id: "tm-kanazawa-venue",
      name: "King Gnu Hall Tour",
      dates: { start: { localDate: "2026-09-21" } },
      classifications: [{ segment: { name: "Music" } }],
      _embedded: {
        venues: [{ name: "Honda no Mori Hall Kanazawa", city: { name: "1000" }, state: { name: "Ishikawa" } }],
      },
    })?.city,
  ).toBe("가나자와");

  expect(
    toTicketmasterEventRow({
      id: "tm-ehime-japanese",
      name: "Aimer Acoustic Night",
      dates: { start: { localDate: "2026-10-05" } },
      classifications: [{ segment: { name: "Music" } }],
      _embedded: {
        venues: [{ name: "愛媛県県民文化会館", city: { name: "松山市" } }],
      },
    })?.city,
  ).toBe("마쓰야마");
});

test("classifies Japanese Ticketmaster concert signals and sports exclusions", () => {
  expect(
    isLikelyConcert({
      id: "tm-japanese-live",
      name: "米津玄師 2026 ライブツアー",
      classifications: [{ segment: { name: "音楽" }, genre: { name: "J-POP" } }],
    }),
  ).toBe(true);

  expect(
    isLikelyConcert({
      id: "tm-japanese-sports",
      name: "Bリーグ バスケットボール 大阪",
      classifications: [{ segment: { name: "スポーツ" } }],
    }),
  ).toBe(false);
});

test("keeps resale sale types when mapping database rows", () => {
  expect(
    rowToEvent({
      id: "resale-row",
      artist: "King Gnu",
      title: "Stadium Live",
      city: "요코하마",
      venue: "日産スタジアム",
      date: "2026-09-21",
      time: "18:30",
      genre: "Music",
      source: "e+",
      ticket_access: "확인 필요",
      sale_type: "리세일",
      sale_window: "公式リセール受付：2026年9月1日 12:00～2026年9月10日 23:59",
      price: "¥12,000",
      phone_required: true,
      foreigner_note: "리세일 조건 확인",
      link: "https://eplus.jp/kinggnu-resale/",
      image: null,
    }).saleType,
  ).toBe("리세일");

  expect(
    toEventRow({
      artist: "King Gnu",
      title: "Stadium Live",
      city: "요코하마",
      venue: "日産スタジアム",
      date: "2026-09-21",
      saleType: "리세일",
    }).sale_type,
  ).toBe("리세일");
});

test("serves the shared seed event catalog from the events API fallback", () => {
  expect(seedResponse()).toEqual({
    events: seedEvents,
    source: "seed",
  });
});

test("prefers the server key for protected server-side reads", () => {
  expect(serverReadKey("anon-key", "service-role-key")).toBe("service-role-key");
  expect(serverReadKey("anon-key")).toBe("anon-key");
});

test("normalizes alert contact emails", () => {
  expect(normalizeAlertContactEmail(" Fan@Example.COM ")).toBe("fan@example.com");
  expect(normalizeAlertContactEmail("")).toBeNull();
  expect(() => normalizeAlertContactEmail("not-an-email")).toThrow("contactEmail must be a valid email address");
  expect(normalizeAlertLeadTimeHours(undefined)).toBe(3);
  expect(normalizeAlertLeadTimeHours("24")).toBe(24);
  expect(normalizeAlertLeadTimeHours(72)).toBe(72);
  expect(normalizeAlertLeadTimeHours(99)).toBe(3);
});

test("builds alert subscription upsert rows with email and cancellation state", () => {
  const snapshot = {
    id: "seed-ado-yokohama-2026-07-21",
    artist: "Ado",
    title: "Blue Flame Tour",
    date: "2026-11-12",
    saleWindow: "2026年5月10日 12:00～2026年5月20日 23:59",
  };
  const now = new Date("2026-05-01T00:00:00+09:00");

  expect(
    buildAlertUpsertRow({
      clientId: "client-1",
      snapshot,
      active: true,
      contactEmail: "fan@example.com",
      remindBeforeHours: 24,
      now,
    }),
  ).toMatchObject({
    client_id: "client-1",
    event_key: "seed-ado-yokohama-2026-07-21",
    event_snapshot: snapshot,
    status: "active",
    channel: "email",
    contact_email: "fan@example.com",
    remind_before_hours: 24,
    remind_at: new Date("2026-05-09T12:00:00+09:00").toISOString(),
    updated_at: now.toISOString(),
  });

  expect(
    buildAlertUpsertRow({
      clientId: "client-1",
      snapshot,
      active: false,
      contactEmail: null,
      now,
    }),
  ).toMatchObject({
    status: "cancelled",
    channel: "browser",
    contact_email: null,
    remind_at: null,
  });
});

test("builds alert webhook payloads with Korean context and contact email", () => {
  const alert = {
    id: "alert-1",
    event_key: "ado-2026",
    channel: "email",
    contact_email: "fan@example.com",
    remind_at: "2026-05-10T00:00:00.000Z",
    remind_before_hours: 24,
    event_snapshot: {
      id: "seed-ado-yokohama-2026-07-21",
      artist: "Ado",
      title: "Blue Flame Tour",
      city: "요코하마",
      venue: "K-Arena Yokohama",
      date: "2026-11-12",
      time: "18:30",
      source: "Ticket Pia",
      ticketAccess: "일본 번호 필요",
      saleType: "추첨 접수",
      saleWindow: "2026年5月10日 12:00～2026年5月20日 23:59",
      price: "¥9,800",
      phoneRequired: true,
      foreignerNote: "SMS 인증 조건 확인",
      link: "https://t.pia.jp/example",
    },
  };

  expect(buildAlertMessage(alert)).toContain("수신처: fan@example.com");
  expect(buildAlertMessage(alert)).toContain("알림 기준: 예매 시작 24시간 전");
  expect(buildAlertMessage(alert)).toContain("공연: Ado - Blue Flame Tour");
  expect(buildAlertMessage(alert)).toContain("구매 조건: 일본 번호 필요 / 일본 번호 확인 필요");
  expect(buildAlertMessage(alert)).toContain("티켓: 추첨 접수 / ¥9,800");
  expect(buildAlertMessage(alert)).toContain("확인 메모: SMS 인증 조건 확인");
  expect(buildAlertMessage(alert)).toContain(
    "앱에서 보기: https://japan-live-radar.vercel.app/?event=seed-ado-yokohama-2026-07-21",
  );
  expect(buildAppEventUrl(alert, "https://example.com")).toBe(
    "https://example.com/?event=seed-ado-yokohama-2026-07-21",
  );
  expect(buildAlertSubject(alert)).toBe("[Japan Live Radar] Ado - Blue Flame Tour 예매 알림");
  expect(buildAlertDeliveryKey(alert)).toBe("alert-1:ado-2026:2026-05-10T00:00:00.000Z");
  expect(buildAlertWebhookPayload(alert)).toMatchObject({
    subject: "[Japan Live Radar] Ado - Blue Flame Tour 예매 알림",
    text: expect.stringContaining("판매 일정: 2026年5月10日 12:00"),
    deliveryKey: "alert-1:ado-2026:2026-05-10T00:00:00.000Z",
    alertId: "alert-1",
    eventKey: "ado-2026",
    channel: "email",
    contactEmail: "fan@example.com",
    appUrl: "https://japan-live-radar.vercel.app/?event=seed-ado-yokohama-2026-07-21",
    eventUrl: "https://japan-live-radar.vercel.app/?event=seed-ado-yokohama-2026-07-21",
    ticketUrl: "https://t.pia.jp/example",
    source: "Ticket Pia",
    ticketAccess: "일본 번호 필요",
    saleType: "추첨 접수",
    phoneRequired: true,
    remindAt: "2026-05-10T00:00:00.000Z",
    remindBeforeHours: 24,
  });
  expect(buildAlertSubject({ event_key: "missing", id: "alert-2", remind_at: "", event_snapshot: {} })).toBe(
    "[Japan Live Radar] 일본 콘서트 예매 알림",
  );
});

test("builds alert snapshots with ticket access and travel context", () => {
  expect(buildAlertEventSnapshot(seedEvents[0])).toMatchObject({
    id: seedEvents[0].id,
    artist: seedEvents[0].artist,
    city: seedEvents[0].city,
    venue: seedEvents[0].venue,
    time: seedEvents[0].time,
    source: seedEvents[0].source,
    ticketAccess: seedEvents[0].ticketAccess,
    saleType: seedEvents[0].saleType,
    price: seedEvents[0].price,
    phoneRequired: seedEvents[0].phoneRequired,
    foreignerNote: seedEvents[0].foreignerNote,
    link: seedEvents[0].link,
  });
});

test("validates production health with admin alert and sync coverage", () => {
  expect(() =>
    validateProductionHealth({
      ok: true,
      database: "reachable",
      eventCount: 3,
    }),
  ).not.toThrow();

  expect(() => validateProductionHealth({ ok: true, database: "missing", eventCount: 3 })).toThrow(
    "Database is missing",
  );
  expect(() => validateAdminAlertsHealth({ configured: true, alerts: [] })).not.toThrow();
  expect(() => validateAdminAlertsHealth({ configured: false, alerts: [] })).toThrow(
    "Admin alerts API is not configured",
  );
  expect(() =>
    validateAdminStatsHealth({
      alertQueue: {
        activeDue: 0,
        activeScheduled: 2,
        activeNext24h: 1,
        error: 0,
        sent: 5,
        nextReminderAt: "2026-05-05T00:00:00.000Z",
        lastErrorAt: null,
      },
      syncHealth: {
        status: "healthy",
        lastFinishedAt: "2026-05-04T10:00:00Z",
        staleAfterHours: 30,
        errorSources: [],
        staleSources: [],
      },
    }),
  ).not.toThrow();
  expect(() =>
    validateAdminStatsHealth({
      alertQueue: {
        error: 1,
      },
      syncHealth: {
        status: "healthy",
      },
    }),
  ).toThrow("Alert queue has 1 errored alert(s)");
  expect(() =>
    validateAdminStatsHealth({
      alertQueue: {
        error: 0,
      },
      syncHealth: {
        status: "stale",
        staleSources: ["ticketmaster"],
      },
    }),
  ).toThrow("Sync health is stale: ticketmaster");
});

test("applies every checked-in Supabase migration", () => {
  const checkedInMigrations = readdirSync("supabase/migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort();

  expect([...migrationFiles].sort()).toEqual(checkedInMigrations);
});

test("defines an installable PWA app shell", () => {
  const indexHtml = readFileSync("index.html", "utf8");
  const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8")) as {
    name?: string;
    start_url?: string;
    display?: string;
    icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
  };
  const serviceWorker = readFileSync("public/sw.js", "utf8");
  const registrationSource = readFileSync("src/registerServiceWorker.ts", "utf8");

  expect(indexHtml).toContain('rel="manifest" href="/manifest.webmanifest"');
  expect(indexHtml).toContain('name="theme-color"');
  expect(manifest).toMatchObject({
    name: "Japan Live Radar",
    start_url: "/",
    display: "standalone",
  });
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", purpose: expect.stringContaining("maskable") }),
      expect.objectContaining({ src: "/icon-512.png", sizes: "512x512", purpose: expect.stringContaining("maskable") }),
    ]),
  );
  expect(existsSync("public/icon-192.png")).toBe(true);
  expect(existsSync("public/icon-512.png")).toBe(true);
  expect(serviceWorker).toContain('url.pathname.startsWith("/api/")');
  expect(serviceWorker).toContain("caches.open(cacheName)");
  expect(registrationSource).toContain('navigator.serviceWorker.register("/sw.js")');
});

test("keeps automatic Vercel deploys off dev pushes to preserve quota", () => {
  const deployWorkflow = readFileSync(".github/workflows/deploy-vercel.yml", "utf8");
  const pushBlock = deployWorkflow.match(/push:\n\s+branches:\n(?<branches>(?:\s+- .+\n)+)/)?.groups?.branches ?? "";

  expect(pushBlock).toContain("- main");
  expect(pushBlock).not.toContain("- dev");
  expect(deployWorkflow).toContain("workflow_dispatch:");
});

test("limits release PR auto-merges to morning and evening KST windows", () => {
  const mergeWorkflow = readFileSync(".github/workflows/merge-release-pr.yml", "utf8");
  const autoReleaseWorkflow = readFileSync(".github/workflows/auto-release.yml", "utf8");

  expect(mergeWorkflow).toContain("workflow_dispatch:");
  expect(mergeWorkflow).toContain('cron: "0 0,12 * * *"');
  expect(mergeWorkflow).toContain("09:00 and 21:00 in Asia/Seoul");
  expect(mergeWorkflow).not.toContain('cron: "*/10 * * * *"');
  expect(autoReleaseWorkflow).toContain("09:00/21:00 KST release windows");
});

test("summarizes alert dispatch failures for workflow visibility", () => {
  expect(summarizeDispatchFailures([])).toBeNull();
  expect(summarizeDispatchFailures(["alert-1: ALERT_WEBHOOK_URL is not configured"])).toBe(
    "Failed to dispatch 1 alert(s): alert-1: ALERT_WEBHOOK_URL is not configured",
  );
  expect(summarizeDispatchFailures(["a: failed", "b: failed", "c: failed", "d: failed"])).toBe(
    "Failed to dispatch 4 alert(s): a: failed; b: failed; c: failed; +1 more",
  );
});

test("classifies retryable alert webhook delivery statuses", () => {
  expect(normalizeWebhookAttempts(undefined)).toBe(3);
  expect(normalizeWebhookAttempts("0")).toBe(1);
  expect(normalizeWebhookAttempts("9")).toBe(5);
  expect(normalizeWebhookTimeoutMs(undefined)).toBe(10000);
  expect(normalizeWebhookTimeoutMs("500")).toBe(1000);
  expect(normalizeWebhookTimeoutMs("45000")).toBe(30000);
  expect(shouldRetryWebhookStatus(408)).toBe(true);
  expect(shouldRetryWebhookStatus(429)).toBe(true);
  expect(shouldRetryWebhookStatus(500)).toBe(true);
  expect(shouldRetryWebhookStatus(400)).toBe(false);
});

test("signs alert webhook payloads when a webhook secret is configured", async () => {
  const timestamp = "2026-05-10T00:00:00.000Z";
  let capturedBody = "";

  await sendWebhook(
    {
      id: "alert-signed",
      event_key: "ado-2026",
      remind_at: "2026-05-10T00:00:00.000Z",
      event_snapshot: { artist: "Ado", title: "Blue Flame Tour" },
    },
    {
      webhookUrl: "https://example.com/webhook",
      attempts: 1,
      signatureSecret: "webhook-secret",
      signatureTimestamp: timestamp,
      fetchImpl: async (_url, init) => {
        capturedBody = String(init?.body);
        expect(init?.headers).toMatchObject({
          "x-japan-live-radar-signature-timestamp": timestamp,
          "x-japan-live-radar-signature": buildAlertWebhookSignature(capturedBody, "webhook-secret", timestamp),
        });
        return new Response("ok", { status: 200 });
      },
    },
  );

  expect(JSON.parse(capturedBody)).toMatchObject({
    alertId: "alert-signed",
    deliveryKey: "alert-signed:ado-2026:2026-05-10T00:00:00.000Z",
  });
});

test("retries transient alert webhook failures before marking delivery failed", async () => {
  const statuses = [500, 429, 200];
  const sentPayloads: unknown[] = [];

  await sendWebhook(
    {
      id: "alert-retry",
      event_key: "ado-2026",
      contact_email: "fan@example.com",
      remind_at: "2026-05-10T00:00:00.000Z",
      event_snapshot: {
        artist: "Ado",
        title: "Blue Flame Tour",
        link: "https://t.pia.jp/example",
      },
    },
    {
      webhookUrl: "https://example.com/webhook",
      attempts: 3,
      retryDelayMs: 0,
      fetchImpl: async (_url, init) => {
        sentPayloads.push(JSON.parse(String(init?.body)));
        expect(init?.headers).toMatchObject({
          "x-japan-live-radar-alert-id": "alert-retry",
          "x-japan-live-radar-delivery-key": "alert-retry:ado-2026:2026-05-10T00:00:00.000Z",
          "x-japan-live-radar-event-key": "ado-2026",
        });
        return new Response("ok", { status: statuses.shift() ?? 200 });
      },
    },
  );

  expect(sentPayloads).toHaveLength(3);
  expect(sentPayloads).toEqual([
    expect.objectContaining({
      alertId: "alert-retry",
      deliveryKey: "alert-retry:ado-2026:2026-05-10T00:00:00.000Z",
      eventKey: "ado-2026",
    }),
    expect.objectContaining({
      alertId: "alert-retry",
      deliveryKey: "alert-retry:ado-2026:2026-05-10T00:00:00.000Z",
      eventKey: "ado-2026",
    }),
    expect.objectContaining({
      alertId: "alert-retry",
      deliveryKey: "alert-retry:ado-2026:2026-05-10T00:00:00.000Z",
      eventKey: "ado-2026",
    }),
  ]);
});

test("retries transient alert webhook network errors", async () => {
  let attempts = 0;

  await sendWebhook(
    {
      id: "alert-network-retry",
      event_key: "ado-2026",
      remind_at: "2026-05-10T00:00:00.000Z",
      event_snapshot: { artist: "Ado" },
    },
    {
      webhookUrl: "https://example.com/webhook",
      attempts: 3,
      retryDelayMs: 0,
      fetchImpl: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("socket hang up");
        }
        return new Response("ok", { status: 200 });
      },
    },
  );

  expect(attempts).toBe(3);
});

test("sets a timeout signal for alert webhook requests", async () => {
  await sendWebhook(
    {
      id: "alert-timeout",
      event_key: "ado-2026",
      remind_at: "2026-05-10T00:00:00.000Z",
      event_snapshot: { artist: "Ado" },
    },
    {
      webhookUrl: "https://example.com/webhook",
      attempts: 1,
      timeoutMs: 2500,
      fetchImpl: async (_url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal?.aborted).toBe(false);
        return new Response("ok", { status: 200 });
      },
    },
  );
});

test("reports webhook network errors after retry attempts are exhausted", async () => {
  let attempts = 0;

  await expect(
    sendWebhook(
      {
        id: "alert-network-down",
        event_key: "ado-2026",
        remind_at: "2026-05-10T00:00:00.000Z",
        event_snapshot: { artist: "Ado" },
      },
      {
        webhookUrl: "https://example.com/webhook",
        attempts: 2,
        retryDelayMs: 0,
        fetchImpl: async () => {
          attempts += 1;
          throw new Error("network unreachable");
        },
      },
    ),
  ).rejects.toThrow("Webhook network error after 2 attempt(s): network unreachable");

  expect(attempts).toBe(2);
});

test("does not retry non-retryable alert webhook failures", async () => {
  let attempts = 0;

  await expect(
    sendWebhook(
      {
        id: "alert-bad-request",
        event_key: "ado-2026",
        remind_at: "2026-05-10T00:00:00.000Z",
        event_snapshot: { artist: "Ado" },
      },
      {
        webhookUrl: "https://example.com/webhook",
        attempts: 3,
        retryDelayMs: 0,
        fetchImpl: async () => {
          attempts += 1;
          return new Response("bad request", { status: 400 });
        },
      },
    ),
  ).rejects.toThrow("Webhook failed with 400 after 1 attempt(s)");

  expect(attempts).toBe(1);
});

test("normalizes admin alert queue filters and retry updates", () => {
  const now = new Date("2026-05-04T12:00:00Z");

  expect(normalizeAdminAlertListOptions()).toEqual({ status: "active", dueOnly: true, upcomingOnly: false });
  expect(normalizeAdminAlertListOptions({ status: "error" })).toEqual({
    status: "error",
    dueOnly: false,
    upcomingOnly: false,
  });
  expect(normalizeAdminAlertListOptions({ status: "active", due: "upcoming" })).toEqual({
    status: "active",
    dueOnly: false,
    upcomingOnly: true,
  });
  expect(normalizeAdminAlertListOptions({ status: "sent", due: "all" })).toEqual({
    status: "sent",
    dueOnly: false,
    upcomingOnly: false,
  });
  expect(normalizeAdminAlertListOptions({ status: "unknown" })).toEqual({
    status: "active",
    dueOnly: true,
    upcomingOnly: false,
  });

  expect(buildAlertStatusUpdate("sent", 2, now)).toMatchObject({
    status: "sent",
    last_sent_at: "2026-05-04T12:00:00.000Z",
    last_error: null,
    send_count: 3,
  });
  expect(buildAlertStatusUpdate("error", 0, now, "Webhook failed")).toEqual({
    status: "error",
    last_error: "Webhook failed",
  });
  expect(buildAlertStatusUpdate("active", 0, now, null, "2026-05-05T00:00:00.000Z")).toEqual({
    status: "active",
    remind_at: "2026-05-05T00:00:00.000Z",
    last_error: null,
  });
});

test("summarizes alert queue health for admin stats", () => {
  expect(
    summarizeAlertQueue(
      [
        { status: "active", remind_at: "2026-05-04T11:59:00.000Z", updated_at: "2026-05-04T11:00:00.000Z" },
        { status: "active", remind_at: "2026-05-05T11:59:00.000Z", updated_at: "2026-05-04T11:00:00.000Z" },
        { status: "active", remind_at: "2026-05-04T18:00:00.000Z", updated_at: "2026-05-04T11:00:00.000Z" },
        { status: "active", remind_at: null, updated_at: "2026-05-04T11:00:00.000Z" },
        { status: "error", remind_at: "2026-05-04T10:00:00.000Z", updated_at: "2026-05-04T12:00:00.000Z" },
        { status: "sent", remind_at: "2026-05-04T09:00:00.000Z", updated_at: "2026-05-04T09:30:00.000Z" },
      ],
      new Date("2026-05-04T12:00:00.000Z"),
    ),
  ).toEqual({
    activeDue: 1,
    activeScheduled: 3,
    activeNext24h: 2,
    error: 1,
    sent: 1,
    nextReminderAt: "2026-05-04T18:00:00.000Z",
    lastErrorAt: "2026-05-04T12:00:00.000Z",
  });
});

test("uses source URLs for imported admin event ids", () => {
  const row = toEventRow(
    {
      artist: "Ado",
      title: "Blue Flame Tour",
      city: "요코하마",
      venue: "K-Arena Yokohama",
      date: "2026-11-12",
      source: "Ticket Pia",
      link: "https://t.pia.jp/pia/event/event.do?eventCd=2600001",
    },
    {
      candidateSourceUrl: "https://t.pia.jp/pia/event/event.do?eventCd=2600001",
    },
  );

  expect(row.source).toBe("Ticket Pia");
  expect(row.source_event_id).toMatch(/^url-/);
  expect(row.source_event_id).toContain("t-pia-jp");
});

test("keeps approved or rejected candidate URLs out of pending upserts", () => {
  const rows = [
    { source_url: "https://t.pia.jp/new", status: "pending" as const },
    { source_url: "https://t.pia.jp/pending", status: "pending" as const },
    { source_url: "https://t.pia.jp/approved", status: "pending" as const },
    { source_url: "https://t.pia.jp/rejected", status: "pending" as const },
    { source_url: "https://t.pia.jp/approved", status: "pending" as const },
  ];
  const existingRows = [
    { source_url: "https://t.pia.jp/pending", status: "pending" as const },
    { source_url: "https://t.pia.jp/approved", status: "approved" as const },
    { source_url: "https://t.pia.jp/rejected", status: "rejected" as const },
  ];

  const result = splitCandidateRowsByExistingStatus(rows, existingRows);

  expect(result.upsertRows.map((row) => row.source_url)).toEqual([
    "https://t.pia.jp/new",
    "https://t.pia.jp/pending",
  ]);
  expect(result.skippedRows.map((row) => row.status)).toEqual(["approved", "rejected"]);
});

test("creates ticket source search URLs including Ticketmaster", () => {
  expect(searchSources("Ado 東京")).toEqual(
    expect.arrayContaining([
      {
        source: "Ticketmaster",
        url: "https://www.ticketmaster.com/search?q=Ado%20%E6%9D%B1%E4%BA%AC&sort=date%2Casc&country=jp",
      },
    ]),
  );
  expect(searchSources("Ado 東京").map((source) => source.source)).toEqual([
    "Ticket Pia",
    "e+",
    "Lawson Ticket",
    "Ticketmaster",
  ]);
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
  await expect(page.getByLabel("공연 상세").getByText("알림 예정")).toBeVisible();
  await expect(page.getByRole("link", { name: /원본 링크 열기/ })).toHaveAttribute(
    "href",
    "https://www.ticketmaster.com/",
  );
});

test("searches concerts with Korean artist and venue aliases", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("뉴진스");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /NewJeans/ })).toBeVisible();

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("도쿄돔");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /YOASOBI/ })).toBeVisible();

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("원오크락");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /ONE OK ROCK/ })).toBeVisible();
});

test("searches concerts with Japanese city and ticket-condition aliases", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("東京");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /YOASOBI/ })).toBeVisible();

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("로손");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /Ado/ })).toBeVisible();

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("해외예매");
  await expect(page.getByText("2개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /NewJeans/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /RADWIMPS/ })).toBeVisible();

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("sms인증");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /ONE OK ROCK/ })).toBeVisible();
});

test("opens shared event detail URLs and keeps the selected event in the URL", async ({ page }) => {
  await page.goto(`/?event=${seedEvents[3].id}`);

  await expect(page.getByRole("heading", { name: "NewJeans" })).toBeVisible();
  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await expect(page.getByRole("heading", { name: "ONE OK ROCK" })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`event=${seedEvents[1].id}`));
});

test("copies the selected concert detail link", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          window.sessionStorage.setItem("copied-link", value);
        },
      },
    });
  });

  await page.goto(`/?event=${seedEvents[3].id}`);
  await page.getByRole("button", { name: "상세 링크 복사" }).click();

  await expect(page.getByRole("button", { name: "링크 복사됨" })).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => window.sessionStorage.getItem("copied-link")))
    .toContain(`event=${seedEvents[3].id}`);
});

test("filters by city and ticket access without horizontal overflow", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("도시").selectOption("오사카");
  await page.getByLabel("구매 조건").selectOption("일본 번호 필요");

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

test("filters concerts by artist", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("아티스트").selectOption("Ado");

  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /Ado/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /YOASOBI/ })).toHaveCount(0);

  await page.getByRole("button", { name: "초기화" }).click();
  await expect(page.getByLabel("아티스트")).toHaveValue("전체");
  await expect(page.getByText("5개 공연")).toBeVisible();
});

test("filters concerts by ticket source", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("출처").selectOption("Lawson Ticket");

  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /Ado/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /YOASOBI/ })).toHaveCount(0);

  await page.getByRole("button", { name: "초기화" }).click();
  await expect(page.getByLabel("출처")).toHaveValue("전체");
  await expect(page.getByText("5개 공연")).toBeVisible();
});

test("combines travel date and Korea-friendly filters", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("기간").selectOption("여름 원정");
  await page.getByRole("button", { name: /한국에서 예매 쉬운 공연/ }).click();

  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /NewJeans/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "NewJeans" })).toBeVisible();
});

test("filters concerts by custom travel dates", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("시작일").fill("2026-07-01");
  await page.getByLabel("종료일").fill("2026-07-31");

  await expect(page.getByText("2개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /ONE OK ROCK/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ado/ })).toBeVisible();

  await page.getByLabel("종료일").fill("2026-07-10");
  await expect(page.getByText("1개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /ONE OK ROCK/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Ado/ })).toHaveCount(0);
});

test("filters concerts by sale schedule status", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("판매 상태").selectOption("오픈 예정");
  await expect(page.getByText("5개 공연")).toBeVisible();
  await expect(page.getByRole("button", { name: /YOASOBI/ })).toBeVisible();
  await expect(page.getByLabel("공연 상세").getByText("예매 상태")).toBeVisible();
  await expect(page.getByLabel("공연 상세").getByText("오픈 예정")).toBeVisible();

  await page.getByLabel("판매 상태").selectOption("판매 중");
  await expect(page.getByText("0개 공연")).toBeVisible();
  await expect(page.getByText("조건에 맞는 공연이 없어요")).toBeVisible();
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

test("shows alert subscription sync feedback in the detail panel", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();

  const detail = page.getByLabel("공연 상세");
  await expect(detail.getByRole("status")).toHaveText("서버 알림까지 저장됐어요.");

  await page.getByRole("button", { name: "알림 설정됨" }).click();
  await expect(detail.getByRole("status")).toHaveText("서버 알림도 해제됐어요.");
  await expect(page.getByRole("button", { name: "일정 알림" })).toBeVisible();
});

test("opens saved alerts and jumps back to a saved concert", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();
  await page.getByRole("button", { name: "알림 2개" }).click();

  const alertsPanel = page.getByLabel("저장한 알림");
  await expect(alertsPanel.getByText("NewJeans")).toBeVisible();
  await expect(alertsPanel.getByText("ONE OK ROCK")).toBeVisible();
  await expect(alertsPanel.getByText(/알림 예정 ·/).first()).toBeVisible();

  await alertsPanel.getByRole("button", { name: "NewJeans 알림 공연 열기" }).click();
  await expect(page.getByRole("heading", { name: "NewJeans" })).toBeVisible();
  await expect(alertsPanel).toBeHidden();

  await page.getByRole("button", { name: "알림 2개" }).click();
  await page.getByRole("button", { name: "NewJeans 알림 해제" }).click();
  await expect(page.getByRole("button", { name: "알림 1개" })).toBeVisible();
  await expect(page.getByLabel("저장한 알림").getByRole("status")).toHaveText("서버 알림도 해제됐어요.");
  await expect(page.getByLabel("저장한 알림").getByText("NewJeans")).toHaveCount(0);
});

test("persists an alert contact email in the saved alerts panel", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();
  await page.getByRole("button", { name: "알림 2개" }).click();

  const emailInput = page.getByPlaceholder("알림 받을 이메일");
  await emailInput.fill("fan@example.com");
  await page.getByLabel("저장한 알림").getByRole("button", { name: "저장" }).click();

  await page.reload();
  await page.getByRole("button", { name: "알림 2개" }).click();
  await expect(page.getByPlaceholder("알림 받을 이메일")).toHaveValue("fan@example.com");
});

test("persists an alert lead time in the saved alerts panel", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();
  await page.getByRole("button", { name: "알림 2개" }).click();

  await page.getByLabel("알림 시점").selectOption("24");
  await page.getByLabel("저장한 알림").getByRole("button", { name: "저장" }).click();
  await expect(page.getByLabel("저장한 알림").getByRole("status")).toHaveText("알림 시점을 저장했어요.");
  await expect(page.getByLabel("저장한 알림").getByText(/알림 예정 ·/).first()).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "알림 2개" }).click();
  await expect(page.getByLabel("알림 시점")).toHaveValue("24");
});

test("shows alert contact email save feedback", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();
  await page.getByRole("button", { name: "알림 2개" }).click();

  await page.getByPlaceholder("알림 받을 이메일").fill("fan@example.com");
  await page.getByLabel("저장한 알림").getByRole("button", { name: "저장" }).click();

  await expect(page.getByLabel("저장한 알림").getByRole("status")).toHaveText("알림 이메일을 저장했어요.");
});

test("validates alert contact email before saving", async ({ page }) => {
  let alertRequests = 0;
  await page.route("**/api/alerts", async (route) => {
    alertRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ configured: true, ok: true }),
    });
  });

  await page.goto("/");

  await page.getByRole("button", { name: /ONE OK ROCK/ }).click();
  await page.getByRole("button", { name: "일정 알림" }).click();
  await page.getByRole("button", { name: "알림 2개" }).click();

  await page.getByPlaceholder("알림 받을 이메일").fill("not-an-email");
  await page.getByLabel("저장한 알림").getByRole("button", { name: "저장" }).click();

  await expect(page.getByLabel("저장한 알림").getByRole("status")).toHaveText("이메일 형식을 확인해 주세요.");
  expect(alertRequests).toBe(0);
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
  await expect(page.getByLabel("URL 후보").getByText("2026-11-02")).toBeVisible();
  await expect(page.getByLabel("URL 후보").getByRole("link", { name: "원본 열기" })).toHaveAttribute(
    "href",
    "https://t.pia.jp/example",
  );
});

test("does not requeue already approved imported URL candidates", async ({ page }) => {
  await page.route("**/api/import-url", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            url: "https://t.pia.jp/approved",
            draft: {
              artist: "Ado",
              title: "Ado Arena Live",
              city: "도쿄",
              venue: "Tokyo Dome",
              date: "2026-11-02",
              source: "Ticket Pia",
              link: "https://t.pia.jp/approved",
            },
          },
        ],
      }),
    });
  });
  await page.route("**/api/admin-candidates", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        candidates: [],
        skippedCandidates: [
          {
            id: "candidate-approved",
            source: "Ticket Pia",
            sourceUrl: "https://t.pia.jp/approved",
            status: "approved",
            createdAt: "2026-05-04T00:00:00Z",
            draft: {
              artist: "Ado",
              title: "Ado Arena Live",
              city: "도쿄",
              venue: "Tokyo Dome",
              date: "2026-11-02",
              source: "Ticket Pia",
              link: "https://t.pia.jp/approved",
            },
          },
        ],
      }),
    });
  });

  await page.goto("/#admin");

  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByLabel("URL로 초안 가져오기").fill("https://t.pia.jp/approved");
  await page.getByRole("button", { name: "가져오기" }).click();

  await expect(page.getByText("이미 승인/거절된 URL이라 새 후보를 추가하지 않았어요.")).toBeVisible();
  await expect(page.getByLabel("URL 후보").getByText("Ado", { exact: true })).toHaveCount(0);
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
        pastEvents: 2,
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
        alertQueue: {
          activeDue: 2,
          activeScheduled: 5,
          activeNext24h: 3,
          error: 1,
          sent: 3,
          nextReminderAt: "2026-05-04T18:00:00.000Z",
          lastErrorAt: "2026-05-04T00:00:00Z",
        },
        syncRuns: [
          {
            source: "ticketmaster",
            status: "success",
            fetchedCount: 420,
            upsertedCount: 390,
            skippedCount: 30,
            message: null,
            finishedAt: "2026-05-04T10:00:00Z",
            ageHours: 26,
          },
        ],
        syncHealth: {
          status: "healthy",
          lastFinishedAt: "2026-05-04T10:00:00Z",
          staleAfterHours: 30,
          errorSources: [],
          staleSources: [],
        },
        bySource: [{ label: "Ticket Pia", count: 3 }],
        qualityBySource: [
          {
            source: "Ticket Pia",
            total: 3,
            missingLink: 1,
            missingSaleWindow: 2,
            missingPrice: 1,
            needsAccessReview: 2,
          },
        ],
        byCity: [{ label: "도쿄", count: 2 }],
        generatedAt: "2026-05-04T00:00:00Z",
      }),
    });
  });

  await page.goto("/#admin");
  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByLabel("데이터 품질").getByRole("button", { name: "새로고침" }).click();

  await expect(page.getByLabel("데이터 품질").getByText("공연", { exact: true })).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("5개")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("지난 공연")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("판매 일정 누락")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("가격 누락")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("알림 대기")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("24시간 내 알림")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").locator(".admin-stat").filter({ hasText: "24시간 내 알림" }).getByText("3개")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("다음 알림")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("알림 오류")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("동기화 상태")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("정상")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("동기화", { exact: true })).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("출처별 품질")).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText(/Ticket Pia · 3개 · 일정 2 · 가격 1 · 조건 2 · 링크 1/)).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText(/ticketmaster · 성공 · 390\/420/)).toBeVisible();
  await expect(page.getByLabel("데이터 품질").getByText("26시간 전")).toBeVisible();

  await page.getByLabel("검색어 후보 수집").fill("Ado");
  await page.getByRole("button", { name: "후보 만들기" }).click();

  await expect(page.getByText("1개 검색 후보를 만들었어요.")).toBeVisible();
  await expect(page.getByLabel("URL 후보").getByText("Ado", { exact: true })).toBeVisible();
  await expect(page.getByLabel("URL 후보").getByRole("link", { name: "원본 열기" })).toHaveAttribute(
    "href",
    "https://t.pia.jp/en/pia/search_dtl_input.do?keyword=Ado",
  );
  await page.getByRole("button", { name: "초안 적용" }).click();
  await expect(page.getByText("후보를 입력폼에 적용했어요.")).toBeVisible();
});

test("shows admin alert queue and retries errored alerts", async ({ page }) => {
  let retryBody: Record<string, unknown> | null = null;
  let queueReads = 0;
  const queueUrls: string[] = [];

  await page.route("**/api/admin-alerts**", async (route) => {
    if (route.request().method() === "PATCH") {
      retryBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, alert: { id: "alert-1", status: "active" } }),
      });
      return;
    }

    queueReads += 1;
    queueUrls.push(route.request().url());
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        configured: true,
        alerts: queueReads === 1
          ? [
              {
                id: "alert-1",
                event_key: "ado-2026",
                event_snapshot: {
                  artist: "Ado",
                  title: "Blue Flame Tour",
                },
                channel: "email",
                contact_email: "fan@example.com",
                status: "error",
                remind_at: "2026-05-10T00:00:00.000Z",
                last_sent_at: null,
                last_error: "Webhook failed with 500",
                send_count: 0,
                updated_at: "2026-05-04T00:00:00Z",
              },
            ]
          : [],
      }),
    });
  });
  await page.route("**/api/admin-stats", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        totalEvents: 0,
        pendingCandidates: 0,
        candidateTableReady: true,
        alertQueue: {
          activeDue: 0,
          activeScheduled: 1,
          activeNext24h: 1,
          error: 0,
          sent: 0,
          nextReminderAt: "2026-05-10T00:00:00.000Z",
          lastErrorAt: null,
        },
        quality: {
          missingLink: 0,
          missingSaleWindow: 0,
          missingPrice: 0,
          needsAccessReview: 0,
          phoneRequired: 0,
          koreaFriendly: 0,
        },
        bySource: [],
        byCity: [],
        generatedAt: "2026-05-04T00:00:00Z",
      }),
    });
  });

  await page.goto("/#admin");
  await page.getByLabel("관리자 토큰").fill("test-token");
  await page.getByRole("button", { name: "알림 새로고침" }).click();

  await expect(page.getByLabel("알림 큐").getByText("Ado · Blue Flame Tour")).toBeVisible();
  await expect(page.getByLabel("알림 큐").getByText("fan@example.com")).toBeVisible();
  await expect(page.getByLabel("알림 큐").getByText("Webhook failed with 500")).toBeVisible();

  await page.getByRole("button", { name: "재시도" }).click();
  expect(retryBody).toMatchObject({ id: "alert-1", status: "active" });
  await expect(page.getByText("알림을 재시도 큐로 되돌렸어요.")).toBeVisible();

  await page.getByLabel("알림 상태").selectOption("upcoming");
  expect(queueUrls.some((url) => url.includes("status=active") && url.includes("due=upcoming"))).toBe(true);
});

test("shows an empty state when no concerts match", async ({ page }) => {
  await page.goto("/");

  await page.getByPlaceholder("아티스트, 공연명, 회장 검색").fill("없는공연");

  await expect(page.getByText("0개 공연")).toBeVisible();
  await expect(page.getByText("조건에 맞는 공연이 없어요")).toBeVisible();
  await expect(page.getByText("원정 조건을 조금 넓혀볼까요?")).toBeVisible();
});
