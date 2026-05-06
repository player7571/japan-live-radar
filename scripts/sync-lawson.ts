import { createClient } from "@supabase/supabase-js";
import * as cheerio from "cheerio";
import { pathToFileURL } from "node:url";
import { recordSyncRun } from "../src/lib/syncRuns";

type LawsonOffer = {
  url?: string;
  validFrom?: string;
};

type LawsonJsonLdEvent = {
  "@type"?: string;
  name?: string;
  startDate?: string;
  endDate?: string;
  location?: {
    name?: string;
    address?: {
      addressRegion?: string;
      addressCountry?: string;
    };
  };
  image?: string | string[];
  description?: string;
  offers?: LawsonOffer | LawsonOffer[];
  performer?: {
    name?: string;
  };
};

type LawsonTicketMeta = {
  link: string | null;
  reservationStart: string | null;
  reservationEnd: string | null;
  isLottery: boolean;
  optionText: string;
  description: string;
  venueText: string;
};

type LawsonEventRow = {
  source: string;
  source_event_id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string | null;
  genre: string;
  ticket_access: string;
  sale_type: string;
  sale_window: string | null;
  price: string | null;
  phone_required: boolean;
  foreigner_note: string;
  link: string | null;
  image: string | null;
  country_code: string;
  raw: Record<string, unknown>;
};

const lawsonSource = "Lawson Ticket";
const defaultLawsonKeywords = ["J-POP", "K-POP", "ライブ", "コンサート", "フェス", "ROCK", "アジア"];
const defaultLawsonCategoryUrls = [
  "https://cdn.l-tike.com/concert/",
  "https://cdn.l-tike.com/concert/hogaku/",
  "https://cdn.l-tike.com/concert/k-pop/",
  "https://cdn.l-tike.com/concert/musicfestival/",
];

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const lawsonFetchTimeoutMs = normalizeLawsonFetchTimeoutMs(process.env.LAWSON_FETCH_TIMEOUT_MS);
const lawsonPageLimit = normalizeLawsonPageLimit(process.env.LAWSON_PAGE_LIMIT);
const lawsonRowLimit = normalizeLawsonRowLimit(process.env.LAWSON_ROW_LIMIT);

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function normalizeLawsonFetchTimeoutMs(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 12_000;
  return Math.min(Math.max(Math.trunc(parsed), 3_000), 30_000);
}

export function normalizeLawsonPageLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), 3);
}

export function normalizeLawsonRowLimit(value: string | undefined) {
  const parsed = value ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return 80;
  return Math.min(Math.max(Math.trunc(parsed), 1), 120);
}

function envList(name: string) {
  return (process.env[name] ?? "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function lawsonSearchUrls() {
  const explicitUrls = envList("LAWSON_SEARCH_URLS");
  if (explicitUrls.length > 0) return explicitUrls.slice(0, 12);

  const keywords = envList("LAWSON_SYNC_KEYWORDS");
  const keywordUrls = (keywords.length > 0 ? keywords : defaultLawsonKeywords).slice(0, 8).flatMap((keyword) =>
    Array.from({ length: lawsonPageLimit }, (_, index) => {
      const url = new URL("https://cdn.l-tike.com/search/");
      url.searchParams.set("keyword", keyword);
      if (index > 0) url.searchParams.set("page", String(index + 1));
      return url.toString();
    }),
  );

  return [...defaultLawsonCategoryUrls.slice(0, lawsonPageLimit + 1), ...keywordUrls].slice(0, 16);
}

async function fetchLawsonPage(url: string) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 JapanLiveRadar/0.1 (+https://japan-live-radar.vercel.app)",
      accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(lawsonFetchTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Lawson Ticket request failed for ${url}: ${response.status} ${await response.text()}`);
  }

  return response.text();
}

function compactText(value: string | null | undefined) {
  if (!value) return "";
  return cheerio.load(value).text().normalize("NFKC").replace(/\s+/g, " ").trim();
}

function postgrestStringList(values: string[]) {
  return `(${values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")})`;
}

const cityAliases: Array<[string[], string]> = [
  [["東京都", "東京"], "도쿄"],
  [["大阪府", "大阪"], "오사카"],
  [["神奈川県", "神奈川", "横浜"], "요코하마"],
  [["愛知県", "愛知", "名古屋"], "나고야"],
  [["福岡県", "福岡"], "후쿠오카"],
  [["埼玉県", "埼玉"], "사이타마"],
  [["千葉県", "千葉", "幕張"], "치바"],
  [["京都府", "京都"], "교토"],
  [["兵庫県", "兵庫", "神戸"], "고베"],
  [["広島県", "広島"], "히로시마"],
  [["宮城県", "宮城", "仙台"], "센다이"],
  [["北海道", "札幌"], "삿포로"],
  [["沖縄県", "沖縄", "那覇"], "오키나와"],
  [["静岡県", "静岡"], "시즈오카"],
  [["新潟県", "新潟"], "니가타"],
  [["石川県", "石川", "金沢"], "가나자와"],
  [["岡山県", "岡山"], "오카야마"],
  [["熊本県", "熊本"], "구마모토"],
  [["鹿児島県", "鹿児島"], "가고시마"],
  [["愛媛県", "愛媛", "松山"], "마쓰야마"],
  [["香川県", "香川", "高松"], "다카마쓰"],
  [["大分県", "大分"], "오이타"],
  [["長野県", "長野"], "나가노"],
  [["群馬県", "群馬", "高崎"], "다카사키"],
  [["栃木県", "栃木", "宇都宮"], "우쓰노미야"],
  [["茨城県", "茨城", "水戸"], "미토"],
];

function mapCity(...values: Array<string | null | undefined>) {
  const text = values.map(compactText).filter(Boolean).join(" ");
  for (const [signals, city] of cityAliases) {
    if (signals.some((signal) => text.includes(signal))) return city;
  }
  return compactText(values[0]) || "도시 미정";
}

function normalizeLawsonUrl(value: string | null | undefined, baseUrl = "https://cdn.l-tike.com/") {
  if (!value) return null;
  try {
    const url = new URL(value, baseUrl);
    url.protocol = "https:";
    url.hostname = "l-tike.com";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function detailFetchUrl(value: string) {
  const url = new URL(value);
  url.protocol = "https:";
  url.hostname = "cdn.l-tike.com";
  return url.toString();
}

function isLawsonDetailUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname.endsWith("l-tike.com") && url.pathname === "/concert/mevent/" && url.searchParams.has("mid");
  } catch {
    return false;
  }
}

function imageUrl(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  try {
    const url = new URL(raw, "https://cdn.l-tike.com/");
    url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

function firstOfferUrl(offers: LawsonJsonLdEvent["offers"]) {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  return normalizeLawsonUrl(list.find((offer) => offer.url)?.url);
}

function firstOfferValidFrom(offers: LawsonJsonLdEvent["offers"]) {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  return list.find((offer) => offer.validFrom)?.validFrom ?? null;
}

function formatIsoDate(value: string | null | undefined) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function formatLawsonSearchDate(value: string | null | undefined) {
  const match = value?.match(/(\d{4})(\d{2})(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function formatLawsonSaleDateTime(value: string | null | undefined) {
  if (!value || value === "null") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replaceAll("/", ".");
}

function lawsonSaleType(text: string, isLottery = false) {
  if (isLottery || /(抽選|プレリク|LE限定|先行)/.test(text)) return "추첨 접수";
  if (/(先着|スマートフォン受付|発売中|一般発売)/.test(text)) return "선착 판매";
  return "일반 판매";
}

function lawsonSaleWindow(start: string | null, end: string | null, fallbackText = "") {
  const startText = formatLawsonSaleDateTime(start);
  const endText = formatLawsonSaleDateTime(end);
  if (startText || endText) {
    return `접수기간: ${startText ?? "시작일 확인 필요"} - ${endText ?? "종료일 확인 필요"}`;
  }

  const text = compactText(fallbackText);
  const match = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}):(\d{2}).*?[～~]\s*(\d{4})\/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}):(\d{2})/);
  if (!match) return text || null;
  return `접수기간: ${match[1]}.${match[2].padStart(2, "0")}.${match[3].padStart(2, "0")} ${match[4].padStart(2, "0")}:${match[5]} - ${match[6]}.${match[7].padStart(2, "0")}.${match[8].padStart(2, "0")} ${match[9].padStart(2, "0")}:${match[10]}`;
}

function stripPrefectureFromVenue(value: string) {
  return compactText(value).replace(/（[^）]*[都道府県]）\s*$/, "").replace(/\([^)]*[都道府県]\)\s*$/, "").trim();
}

function extractPrefecture(value: string) {
  return value.match(/[（(]([^）)]*[都道府県])/)?.[1] ?? value.match(/(東京都|北海道|大阪府|京都府|.{2,3}県)/)?.[1] ?? "";
}

function isFutureOrToday(date: string, now: Date) {
  return new Date(`${date}T23:59:59+09:00`).getTime() >= now.getTime();
}

const nonConcertSignals = [
  "演劇",
  "舞台",
  "ミュージカル",
  "お笑い",
  "落語",
  "寄席",
  "歌舞伎",
  "スポーツ",
  "野球",
  "サッカー",
  "バスケット",
  "映画",
  "ライブビューイング",
  "イベント・アート",
  "レジャー",
  "オンライン配信",
  "ライブ配信",
];

function isLikelyLawsonConcert(text: string, category = "") {
  if (category && category !== "コンサート") return false;
  if (nonConcertSignals.some((signal) => text.includes(signal))) return false;
  return true;
}

export function lawsonLogicalEventKey(row: Pick<LawsonEventRow, "title" | "date" | "time" | "venue" | "city">) {
  return [row.title, row.date, row.time ?? "", row.venue, row.city]
    .map((value) => value.toLowerCase().replace(/\s+/g, " ").trim())
    .join("|");
}

export function extractLawsonDetailUrls(html: string, baseUrl = "https://cdn.l-tike.com/") {
  const $ = cheerio.load(html);
  const urls = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      if (url.hostname.endsWith("l-tike.com") && url.pathname === "/concert/mevent/" && url.searchParams.has("mid")) {
        url.protocol = "https:";
        url.hostname = "l-tike.com";
        url.hash = "";
        urls.add(url.toString());
      }
    } catch {
      // Ignore malformed marketing links.
    }
  });

  return Array.from(urls);
}

function extractLawsonJsonLdEvents(html: string) {
  const $ = cheerio.load(html);
  const events: LawsonJsonLdEvent[] = [];

  $("script[type='application/ld+json']").each((_, element) => {
    const raw = $(element).text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && typeof item === "object" && (item as LawsonJsonLdEvent)["@type"] === "Event") {
          events.push(item as LawsonJsonLdEvent);
        }
      }
    } catch {
      // Non-event scripts should not make the whole sync fail.
    }
  });

  return events;
}

function extractLawsonTicketMeta(html: string) {
  const $ = cheerio.load(html);
  const metas: LawsonTicketMeta[] = [];

  $(".lt-ticket-list-item").each((_, element) => {
    const item = $(element);
    const link = normalizeLawsonUrl(item.find("a[href]").first().attr("href"));
    metas.push({
      link,
      reservationStart: item.attr("data-reservation-start-date") ?? null,
      reservationEnd: item.attr("data-reservation-end-date") ?? null,
      isLottery: item.attr("data-is-lottery") === "true",
      optionText: compactText(item.find(".lt-ticket-list-item__options").text()),
      description: compactText(item.find(".lt-ticket-list-item__description-text").text()),
      venueText: compactText(item.find(".lt-ticket-list-item__venue-text").text()),
    });
  });

  return metas;
}

function mergeLawsonEventRows(current: LawsonEventRow, next: LawsonEventRow) {
  return {
    ...current,
    source_event_id: current.source_event_id.length <= next.source_event_id.length
      ? current.source_event_id
      : next.source_event_id,
    sale_type: current.sale_type === "추첨 접수" || next.sale_type === "추첨 접수"
      ? "추첨 접수"
      : current.sale_type,
    sale_window: Array.from(new Set([current.sale_window, next.sale_window].filter(Boolean))).slice(0, 3).join(" / ") || null,
    link: current.link ?? next.link,
    raw: { ...current.raw, merged: [...((current.raw.merged as unknown[]) ?? []), next.raw] },
  };
}

export function extractLawsonDetailRows(html: string, sourceUrl: string, now = new Date()) {
  const events = extractLawsonJsonLdEvents(html);
  const ticketMetas = extractLawsonTicketMeta(html);
  const rows: LawsonEventRow[] = [];

  for (const event of events) {
    const date = formatIsoDate(event.startDate);
    const title = compactText(event.name);
    const artist = compactText(event.performer?.name) || title;
    const venue = compactText(event.location?.name);
    const region = compactText(event.location?.address?.addressRegion);
    const link = firstOfferUrl(event.offers) ?? normalizeLawsonUrl(sourceUrl);
    const ticketMeta = ticketMetas.find((meta) => meta.link && link && meta.link === link) ?? ticketMetas[0] ?? null;
    const saleStart = ticketMeta?.reservationStart ?? firstOfferValidFrom(event.offers);
    const saleEnd = ticketMeta?.reservationEnd ?? null;
    const searchText = [title, artist, venue, region, event.description, ticketMeta?.description, ticketMeta?.optionText].join(" ");

    if (!date || !title || !venue || !link || !isLikelyLawsonConcert(searchText)) continue;
    if (!isFutureOrToday(date, now)) continue;

    rows.push({
      source: lawsonSource,
      source_event_id: link,
      artist,
      title,
      city: mapCity(region, venue),
      venue,
      date,
      time: null,
      genre: "Music",
      ticket_access: "일본 번호 필요",
      sale_type: lawsonSaleType(`${ticketMeta?.optionText ?? ""} ${ticketMeta?.description ?? ""}`, ticketMeta?.isLottery),
      sale_window: lawsonSaleWindow(saleStart, saleEnd),
      price: null,
      phone_required: true,
      foreigner_note:
        "Lawson Ticket은 로치케 계정, 일본 전화번호 인증, 결제 방식, Loppi/전자티켓 수령 제한이 있을 수 있어 원본에서 조건을 확인하세요.",
      link,
      image: imageUrl(event.image),
      country_code: "JP",
      raw: { sourceUrl, event, ticketMeta },
    });
  }

  return rows;
}

function attr(element: cheerio.Cheerio<any>, name: string) {
  return element.attr(name) ?? element.attr(name.toLowerCase());
}

function lawsonSearchOrderUrl(button: cheerio.Cheerio<any>) {
  const lcode = attr(button, "data-lcode");
  if (!lcode) return null;
  const url = new URL("https://l-tike.com/order/");
  url.searchParams.set("gLcode", lcode);
  const pfKeys = attr(button, "data-pfKeys");
  const scheduleNo = attr(button, "data-schduleNo");
  const carrierCd = attr(button, "data-carrierCd");
  const pfName = attr(button, "data-prfName");
  const baseVenueCd = attr(button, "data-baseVenueCd");
  if (pfKeys) url.searchParams.set("gPfKey", pfKeys);
  if (scheduleNo) url.searchParams.set("gScheduleNo", scheduleNo);
  if (carrierCd) url.searchParams.set("gCarrierCd", carrierCd);
  if (pfName) url.searchParams.set("gPfName", pfName);
  if (baseVenueCd) url.searchParams.set("gBaseVenueCd", baseVenueCd);
  return url.toString();
}

export function extractLawsonSearchRows(html: string, now = new Date()) {
  const $ = cheerio.load(html);
  const rows: LawsonEventRow[] = [];

  $(".ResultBox.prfSummaryItem").each((_, element) => {
    const box = $(element);
    const category = compactText(box.find(".category").first().text());
    const title = compactText(box.find(".ResultBox__title").first().text());
    const dateText = compactText(
      box.find(".ResultBox__information").filter((__, info) =>
        compactText($(info).find(".ResultBox__informationTitle").text()).includes("公演日"),
      ).first().find(".ResultBox__informationText").text(),
    );
    const venueText = compactText(
      box.find(".ResultBox__information").filter((__, info) =>
        compactText($(info).find(".ResultBox__informationTitle").text()).includes("会場"),
      ).first().find(".ResultBox__informationText").text(),
    );

    box.find(".entryBtn").each((__, buttonElement) => {
      const button = $(buttonElement);
      const date = formatLawsonSearchDate(attr(button, "data-prfDate")) ?? formatLawsonSearchDate(dateText);
      const venue = stripPrefectureFromVenue(attr(button, "data-baseVenueName") ?? venueText);
      const region = extractPrefecture(venueText);
      const saleKind = compactText(button.closest(".ResultBox__table").find("#reception_typename, #sale_name").text());
      const saleWindowText = compactText(button.closest(".ResultBox__table").find("#receiptDat").text());
      const link = lawsonSearchOrderUrl(button);
      const searchText = [category, title, venueText, saleKind].join(" ");

      if (!date || !title || !venue || !link || !isLikelyLawsonConcert(searchText, category)) return;
      if (!isFutureOrToday(date, now)) return;

      rows.push({
        source: lawsonSource,
        source_event_id: link,
        artist: title,
        title,
        city: mapCity(region, venueText),
        venue,
        date,
        time: null,
        genre: "Music",
        ticket_access: "일본 번호 필요",
        sale_type: lawsonSaleType(saleKind),
        sale_window: lawsonSaleWindow(null, null, saleWindowText),
        price: null,
        phone_required: true,
        foreigner_note:
          "Lawson Ticket은 로치케 계정, 일본 전화번호 인증, 결제 방식, Loppi/전자티켓 수령 제한이 있을 수 있어 원본에서 조건을 확인하세요.",
        link,
        image: null,
        country_code: "JP",
        raw: {
          title,
          category,
          dateText,
          venueText,
          saleKind,
          saleWindowText,
          lcode: attr(button, "data-lcode") ?? null,
          pfKeys: attr(button, "data-pfKeys") ?? null,
        },
      });
    });
  });

  return rows;
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const collected = new Map<string, LawsonEventRow>();
  const detailUrls = new Set<string>();
  let fetchedCount = 0;

  try {
    for (const url of lawsonSearchUrls()) {
      const html = await fetchLawsonPage(url);
      if (isLawsonDetailUrl(url)) {
        for (const row of extractLawsonDetailRows(html, normalizeLawsonUrl(url) ?? url, startedAt)) {
          fetchedCount += 1;
          const key = lawsonLogicalEventKey(row);
          const current = collected.get(key);
          collected.set(key, current ? mergeLawsonEventRows(current, row) : row);
        }
      }
      for (const row of extractLawsonSearchRows(html, startedAt)) {
        fetchedCount += 1;
        const key = lawsonLogicalEventKey(row);
        const current = collected.get(key);
        collected.set(key, current ? mergeLawsonEventRows(current, row) : row);
        if (collected.size >= lawsonRowLimit) break;
      }
      for (const detailUrl of extractLawsonDetailUrls(html, url)) {
        detailUrls.add(detailUrl);
        if (detailUrls.size >= lawsonRowLimit) break;
      }
      if (collected.size >= lawsonRowLimit || detailUrls.size >= lawsonRowLimit) break;
    }

    for (const detailUrl of detailUrls) {
      if (collected.size >= lawsonRowLimit) break;
      const rows = extractLawsonDetailRows(await fetchLawsonPage(detailFetchUrl(detailUrl)), detailUrl, startedAt);
      fetchedCount += rows.length;
      for (const row of rows) {
        const key = lawsonLogicalEventKey(row);
        const current = collected.get(key);
        collected.set(key, current ? mergeLawsonEventRows(current, row) : row);
      }
    }

    const rows = [...collected.values()].slice(0, lawsonRowLimit);
    const skippedCount = Math.max(fetchedCount - rows.length, 0);
    if (rows.length === 0) {
      await recordSyncRun(supabase, {
        source: lawsonSource,
        status: "success",
        fetchedCount,
        skippedCount,
        message: "No usable Lawson Ticket concert rows were found. Existing Lawson Ticket rows were preserved.",
        startedAt,
      });
      console.log("No usable Lawson Ticket concert rows were found.");
      return;
    }

    const { error } = await supabase.from("events").upsert(rows, {
      onConflict: "source,source_event_id",
    });

    if (error) {
      throw new Error(`Supabase Lawson Ticket upsert failed: ${error.message}`);
    }

    const { error: staleError, count: staleDeletedCount } = await supabase
      .from("events")
      .delete({ count: "exact" })
      .eq("source", lawsonSource)
      .not("source_event_id", "in", postgrestStringList(rows.map((row) => row.source_event_id)));

    if (staleError) {
      throw new Error(`Supabase stale Lawson Ticket cleanup failed: ${staleError.message}`);
    }

    await recordSyncRun(supabase, {
      source: lawsonSource,
      status: "success",
      fetchedCount,
      upsertedCount: rows.length,
      skippedCount,
      message: `Synced ${rows.length} Lawson Ticket public HTML events. Removed ${staleDeletedCount ?? 0} stale Lawson Ticket rows.`,
      startedAt,
    });
    console.log(
      `Synced ${rows.length} Lawson Ticket events. Skipped ${skippedCount}. Removed ${staleDeletedCount ?? 0} stale rows.`,
    );
  } catch (error) {
    await recordSyncRun(supabase, {
      source: lawsonSource,
      status: "error",
      fetchedCount,
      skippedCount: 0,
      message: error instanceof Error ? error.message : String(error),
      startedAt,
    });
    throw error;
  }
}

function isDirectRun() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
