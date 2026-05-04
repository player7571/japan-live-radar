import * as cheerio from "cheerio";

type VercelRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type ImportPayload = {
  url?: unknown;
  urls?: unknown;
};

type ImportedDraft = {
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string;
  genre: string;
  source: string;
  ticketAccess: "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
  saleType: "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";
  saleWindow: string;
  price: string;
  phoneRequired: boolean;
  foreignerNote: string;
  link: string;
  image: string;
};

const adminApiToken = process.env.ADMIN_API_TOKEN;
const fallbackDraft: ImportedDraft = {
  artist: "",
  title: "",
  city: "도쿄",
  venue: "",
  date: "",
  time: "",
  genre: "Music",
  source: "Imported URL",
  ticketAccess: "확인 필요",
  saleType: "일반 판매",
  saleWindow: "",
  price: "",
  phoneRequired: true,
  foreignerNote: "원본 티켓 페이지에서 해외 결제와 수령 조건을 확인하세요.",
  link: "",
  image: "",
};

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody(body: unknown): ImportPayload {
  if (typeof body === "string") {
    return JSON.parse(body) as ImportPayload;
  }
  if (body && typeof body === "object") {
    return body as ImportPayload;
  }
  return {};
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("url is required");
  }

  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("url must be http or https");
  }
  if (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "0.0.0.0" ||
    url.hostname.endsWith(".local")
  ) {
    throw new Error("local URLs are not allowed");
  }

  return url;
}

function requestedUrls(payload: ImportPayload) {
  if (Array.isArray(payload.urls)) {
    return payload.urls.slice(0, 10).map(safeUrl);
  }
  return [safeUrl(payload.url)];
}

function firstString(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function compactWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFullWidth(value: string) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTitle(value: string, hostname: string) {
  return compactWhitespace(value)
    .replace(/\s*[|｜]\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|LiveFans).*$/i, "")
    .replace(/\s*-\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|LiveFans).*$/i, "")
    .replace(new RegExp(`\\s*[|｜-]\\s*${hostname.replace(/^www\\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "i"), "")
    .trim();
}

function normalizeDate(value: string) {
  const normalized = normalizeFullWidth(value);
  const isoDate = normalized.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;

  const jpDate = normalized.match(/(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/)?.slice(1);
  if (jpDate?.length === 3) {
    const [year, month, day] = jpDate;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return "";
}

function formatClockTime(hour: string, minute?: string) {
  return `${hour}:${minute ?? "00"}`;
}

function normalizeTime(value: string) {
  const normalized = normalizeFullWidth(value);
  const isoTime = normalized.match(/T([01]\d|2[0-3]):([0-5]\d)/);
  if (isoTime) return `${isoTime[1]}:${isoTime[2]}`;
  const showtime = normalized.match(
    /(?:開演|START)\s*[:：]?\s*([01]?\d|2[0-3])(?::([0-5]\d)|時\s*([0-5]\d)?\s*分?)/i,
  );
  if (showtime) return formatClockTime(showtime[1], showtime[2] ?? showtime[3]);
  const japaneseTime = normalized.match(/\b([01]?\d|2[0-3])時\s*([0-5]\d)?\s*分?/);
  if (japaneseTime) return formatClockTime(japaneseTime[1], japaneseTime[2]);
  return normalized.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)?.[0] ?? "";
}

function labeledTextValue(text: string, labels: string[]) {
  const normalized = normalizeFullWidth(text);
  const labelPattern = labels.map(escapePattern).join("|");
  const lines = normalized
    .split(/\r?\n/)
    .map(compactWhitespace)
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(new RegExp(`^(?:${labelPattern})\\s*[:：]\\s*(.+)$`, "i"));
    if (match) return compactWhitespace(match[1]);
  }

  const inlineMatch = normalized.match(new RegExp(`(?:${labelPattern})\\s*[:：]\\s*([^\\n。]+)`, "i"));
  return inlineMatch ? compactWhitespace(inlineMatch[1]) : "";
}

function matchesLabel(text: string, labels: string[]) {
  const normalized = normalizeFullWidth(compactWhitespace(text)).replace(/[：:]+$/, "");
  return labels.some((label) => normalized === normalizeFullWidth(label));
}

function labeledElementValue($: cheerio.CheerioAPI, labels: string[]) {
  for (const row of $("tr").toArray()) {
    const cells = $(row).children("th,td");
    const label = cells.first().text();
    if (matchesLabel(label, labels)) {
      const value = compactWhitespace(cells.slice(1).text());
      if (value) return value;
    }
  }

  for (const term of $("dt").toArray()) {
    if (matchesLabel($(term).text(), labels)) {
      const value = compactWhitespace($(term).next("dd").text());
      if (value) return value;
    }
  }

  return "";
}

function labeledValue($: cheerio.CheerioAPI, text: string, labels: string[]) {
  return firstString(labeledElementValue($, labels), labeledTextValue(text, labels));
}

function normalizePriceText(value: string) {
  const normalized = normalizeFullWidth(value);
  const bareStructuredPrice = normalized.match(/^\s*([0-9,]{3,})\s*$/);
  if (bareStructuredPrice) {
    const amount = Number(bareStructuredPrice[1].replaceAll(",", ""));
    return Number.isFinite(amount) ? `¥${amount.toLocaleString("ja-JP")}` : "";
  }

  const price = normalized.match(/[¥￥]\s?([0-9,]{3,})(?:\s?[~〜-]\s?[¥￥]?\s?([0-9,]{3,}))?/) ??
    normalized.match(/([0-9,]{3,})\s?円(?:\s?[~〜-]\s?([0-9,]{3,})\s?円)?/);

  if (!price) return "";
  const first = Number(price[1].replaceAll(",", ""));
  const second = price[2] ? Number(price[2].replaceAll(",", "")) : null;
  if (!Number.isFinite(first)) return "";
  if (second && Number.isFinite(second)) {
    return `¥${first.toLocaleString("ja-JP")} - ¥${second.toLocaleString("ja-JP")}`;
  }
  return `¥${first.toLocaleString("ja-JP")}`;
}

function saleTypeFromText(text: string): ImportedDraft["saleType"] {
  if (/(海外|international|overseas).{0,16}(受付|販売|ticket)/i.test(text)) return "해외 판매";
  if (/(抽選|プレリザーブ|先行受付|先行抽選|lottery|抽せん)/i.test(text)) return "추첨 접수";
  if (/(先着|先着順|first[- ]come|先行先着)/i.test(text)) return "선착 판매";
  if (/(一般発売|一般販売|general sale|発売日)/i.test(text)) return "일반 판매";
  return "일반 판매";
}

function accessFromText(text: string): Pick<ImportedDraft, "phoneRequired" | "ticketAccess" | "foreignerNote"> {
  const overseasSignal = /(海外|international|overseas|foreign|外国|訪日|インバウンド).{0,28}(受付|販売|ticket|購入|カード)/i.test(text);
  const noPhoneSignal =
    /(日本|国内|携帯|電話番号|SMS|SMS認証|認証).{0,18}(不要|なし|無し|必要ありません|必要なし|不要です)/i.test(text) ||
    /(不要|なし|無し|必要ありません|必要なし|不要です).{0,18}(日本|国内|携帯|電話番号|SMS|SMS認証|認証)/i.test(text);
  const phoneSignal =
    /(電話番号|携帯電話|SMS|SMS認証|本人確認|電子チケット|スマチケ|MOALA|AnyPASS|チケプラ|Plus member ID|ローチケ電子チケット|認証)/i.test(text);

  if ((overseasSignal && !phoneSignal) || (overseasSignal && noPhoneSignal)) {
    return {
      phoneRequired: false,
      ticketAccess: "한국 구매 가능",
      foreignerNote: noPhoneSignal
        ? "해외 판매와 일본 전화번호/SMS 인증 불필요 신호가 있어 한국에서 예매 가능성이 높습니다."
        : "해외/외국인 판매 신호가 있어 한국에서 예매 가능성이 있습니다. 결제와 수령 조건은 원본에서 확인하세요.",
    };
  }

  if (phoneSignal) {
    return {
      phoneRequired: true,
      ticketAccess: "일본 번호 필요",
      foreignerNote: "전화번호/SMS/전자티켓 인증 신호가 있어 일본 번호 또는 앱 조건 확인이 필요합니다.",
    };
  }

  return {
    phoneRequired: true,
    ticketAccess: "확인 필요",
    foreignerNote: fallbackDraft.foreignerNote,
  };
}

function saleWindowFromText(text: string) {
  const normalized = normalizeFullWidth(text);
  const clockPattern = String.raw`(?:[01]?\d|2[0-3])(?::[0-5]\d|時\s*(?:[0-5]\d)?\s*分?)`;
  const fullDateTimePattern = String.raw`(\d{4})[./年-]\s*\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*${clockPattern}`;
  const shortDateTimePattern = String.raw`(?:\d{4}[./年-]\s*)?\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*${clockPattern}`;
  const normalizeEndDate = (start: string, end: string) => {
    const trimmedEnd = compactWhitespace(end);
    if (/^\d{4}/.test(trimmedEnd)) return trimmedEnd;
    const startYear = compactWhitespace(start).match(/^\d{4}/)?.[0];
    return startYear ? `${startYear}/${trimmedEnd}` : trimmedEnd;
  };

  const separateStart = normalized.match(
    new RegExp(
      `(受付開始日時|受付開始|販売開始|発売開始|発売日時|申込開始|抽選受付開始|先行受付開始)[:：]?\\s*(${fullDateTimePattern})`,
    ),
  );
  const separateEnd = normalized.match(
    new RegExp(
      `(受付終了日時|受付終了|販売終了|発売終了|申込締切|申込終了|抽選受付終了|先行受付終了)[:：]?\\s*(${shortDateTimePattern})`,
    ),
  );
  if (separateStart && separateEnd) {
    const start = compactWhitespace(separateStart[2]);
    return `${start} - ${normalizeEndDate(start, separateEnd[2])}`;
  }

  const range = normalized.match(
    new RegExp(
      `(受付期間|販売期間|申込期間|発売期間|抽選受付|先行受付|一般発売|発売日)?[:：]?\\s*` +
        `(${fullDateTimePattern})\\s*(?:[~〜～\\-]|から|より)\\s*` +
        `(${shortDateTimePattern}|予定枚数終了|売切|売り切れ)`,
    ),
  );
  if (range) {
    const end = normalizeEndDate(range[2], range[4]);
    return `${compactWhitespace(range[2])} - ${compactWhitespace(end)}`;
  }

  const singleStart = normalized.match(
    new RegExp(`(受付開始|販売開始|発売開始|発売日時|発売日|一般発売|抽選受付|先行受付)[:：]?\\s*(${fullDateTimePattern})`),
  );
  if (singleStart) return compactWhitespace(singleStart[2]);

  const availabilityCue = normalized.match(
    /(販売終了|受付終了|申込終了|募集終了|終了しました|予定枚数終了|売切|売り切れ|完売|販売中(?!止)|受付中|発売中|申込受付中|チケット発売中|販売予定|受付予定|発売予定|近日発売|準備中|sold\s*out|closed|ended|on\s*sale|available\s*now|now\s*on\s*sale|coming\s*soon)/i,
  );
  return availabilityCue ? compactWhitespace(availabilityCue[1]) : "";
}

function artistFromTitle(title: string) {
  const leadingLatinName = title.match(/^[A-Za-z0-9][A-Za-z0-9 ._'&+-]{1,40}(?=\s|　|全国|ライブ|コンサート|ツアー|公演|$)/)?.[0];
  if (leadingLatinName) return leadingLatinName.trim();

  return title
    .split(/[｜|]/)[0]
    .replace(/\s*(チケット|ライブ|コンサート|公演|ツアー).*$/i, "")
    .trim();
}

function flattenJsonLd(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const graph = objectValue["@graph"];
    return [objectValue, ...flattenJsonLd(graph)];
  }
  return [];
}

function firstObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return firstObject(value[0]);
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function objectList(value: unknown): Array<Record<string, unknown>> {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(objectList);
  return typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function firstJsonString(value: unknown) {
  if (Array.isArray(value)) return firstString(...value);
  return firstString(value);
}

function normalizeSchemaPriceRange(lowPrice: unknown, highPrice: unknown) {
  const low = firstString(lowPrice);
  const high = firstString(highPrice);
  if (!low || !high || low === high) return "";
  const lowAmount = Number(low.replaceAll(",", ""));
  const highAmount = Number(high.replaceAll(",", ""));
  if (!Number.isFinite(lowAmount) || !Number.isFinite(highAmount)) return "";
  return `¥${lowAmount.toLocaleString("ja-JP")} - ¥${highAmount.toLocaleString("ja-JP")}`;
}

function schemaOfferPrice(offer: Record<string, unknown>) {
  return firstString(
    normalizeSchemaPriceRange(offer.lowPrice, offer.highPrice),
    normalizePriceText(firstString(offer.price)),
    normalizePriceText(firstString(offer.lowPrice, offer.highPrice)),
  );
}

function priceFromOffers(offers: Array<Record<string, unknown>>) {
  return firstString(...offers.map(schemaOfferPrice));
}

function schemaAvailabilityCue(value: unknown) {
  const availability = firstJsonString(value).toLowerCase();
  if (!availability) return "";
  if (/(soldout|outofstock)/.test(availability)) return "予定枚数終了";
  if (/discontinued/.test(availability)) return "販売終了";
  if (/(instock|limitedavailability|preorder|presale)/.test(availability)) return "販売中";
  return "";
}

function saleWindowFromOffers(offers: Array<Record<string, unknown>>) {
  return firstString(
    ...offers.flatMap((offer) => [firstJsonString(offer.availabilityStarts), firstJsonString(offer.validFrom)]),
    ...offers.map((offer) => schemaAvailabilityCue(offer.availability)),
  );
}

function sourceFromHostname(hostname: string) {
  if (hostname.includes("pia.jp")) return "Ticket Pia";
  if (hostname.includes("eplus.jp")) return "e+";
  if (hostname.includes("l-tike.com")) return "Lawson Ticket";
  if (hostname.includes("livefans.jp")) return "LiveFans";
  return hostname.replace(/^www\./, "");
}

function cityFromText(text: string) {
  const citySignals: Array<[string, string]> = [
    ["東京", "도쿄"],
    ["Tokyo", "도쿄"],
    ["日本武道館", "도쿄"],
    ["有明アリーナ", "도쿄"],
    ["東京ドーム", "도쿄"],
    ["大阪", "오사카"],
    ["Osaka", "오사카"],
    ["大阪城ホール", "오사카"],
    ["横浜", "요코하마"],
    ["Yokohama", "요코하마"],
    ["K-Arena", "요코하마"],
    ["Kアリーナ", "요코하마"],
    ["ぴあアリーナMM", "요코하마"],
    ["日産スタジアム", "요코하마"],
    ["名古屋", "나고야"],
    ["Nagoya", "나고야"],
    ["Nippon Gaishi Hall", "나고야"],
    ["日本ガイシホール", "나고야"],
    ["福岡", "후쿠오카"],
    ["Fukuoka", "후쿠오카"],
    ["マリンメッセ", "후쿠오카"],
    ["PayPayドーム", "후쿠오카"],
    ["札幌", "삿포로"],
    ["Sapporo", "삿포로"],
    ["真駒内セキスイハイムアイスアリーナ", "삿포로"],
    ["仙台", "센다이"],
    ["Sendai", "센다이"],
    ["広島", "히로시마"],
    ["Hiroshima", "히로시마"],
    ["埼玉", "사이타마"],
    ["さいたま", "사이타마"],
    ["Saitama", "사이타마"],
    ["千葉", "치바"],
    ["Chiba", "치바"],
    ["幕張メッセ", "치바"],
    ["ZOZOマリンスタジアム", "치바"],
    ["京都", "교토"],
    ["Kyoto", "교토"],
    ["神戸", "고베"],
    ["Kobe", "고베"],
  ];
  return citySignals.find(([signal]) => text.includes(signal))?.[1] ?? "도쿄";
}

function propertyContent($: cheerio.CheerioAPI, selector: string) {
  return firstString($(selector).first().attr("content"));
}

export function extractDraft(html: string, sourceUrl: URL): ImportedDraft {
  const $ = cheerio.load(html);
  const pageText = compactWhitespace($("body").text());
  const jsonLdItems = $("script[type='application/ld+json']")
    .toArray()
    .flatMap((element) => {
      try {
        return flattenJsonLd(JSON.parse($(element).text()));
      } catch {
        return [];
      }
    });
  const eventJson = jsonLdItems.find((item) => {
    const type = item["@type"];
    return type === "Event" || (Array.isArray(type) && type.includes("Event"));
  });
  const location =
    eventJson?.location && typeof eventJson.location === "object"
      ? (eventJson.location as Record<string, unknown>)
      : {};
  const address =
    location.address && typeof location.address === "object" ? (location.address as Record<string, unknown>) : {};
  const offers = firstObject(eventJson?.offers);
  const offerList = objectList(eventJson?.offers);
  const performer = firstObject(eventJson?.performer);
  const rawTitle = firstString(
    eventJson?.name,
    propertyContent($, "meta[property='og:title']"),
    propertyContent($, "meta[name='twitter:title']"),
    $("h1").first().text(),
    $("title").first().text(),
  );
  const title = cleanTitle(rawTitle, sourceUrl.hostname);
  const description = firstString(
    eventJson?.description,
    propertyContent($, "meta[property='og:description']"),
    propertyContent($, "meta[name='description']"),
  );
  const rawBodyText = $("body").text();
  const dateSource = firstString(
    eventJson?.startDate,
    $("time[datetime]").first().attr("datetime"),
    labeledValue($, rawBodyText, ["公演日", "開催日", "開催日時", "日程", "日時", "公演日時", "公演期間"]),
    pageText,
  );
  const price = normalizePriceText(
    firstString(
      priceFromOffers(offerList),
      labeledValue($, rawBodyText, ["料金", "価格", "チケット料金", "席種・料金"]),
      pageText,
    ),
  );
  const imageValue = eventJson?.image;
  const image = firstJsonString(imageValue);
  const venue = firstString(
    location.name,
    labeledValue($, rawBodyText, ["会場", "会場名", "場所", "Venue", "公演会場"]),
  );
  const textForCity = [venue, address.addressLocality, address.addressRegion, firstString(location.address), pageText].join(" ");
  const access = accessFromText(`${description} ${pageText}`);
  const saleWindow = firstString(
    saleWindowFromOffers(offerList),
    saleWindowFromText(pageText),
    labeledValue($, rawBodyText, ["受付期間", "販売期間", "申込期間", "発売期間", "発売日時", "発売日", "一般発売"]),
  );

  return {
    ...fallbackDraft,
    artist: firstString(performer.name, artistFromTitle(title), title),
    title,
    city: cityFromText(textForCity),
    venue,
    date: normalizeDate(dateSource),
    time: normalizeTime(dateSource),
    source: sourceFromHostname(sourceUrl.hostname),
    ticketAccess: access.ticketAccess,
    saleType: saleTypeFromText(`${description} ${pageText}`),
    saleWindow,
    price,
    phoneRequired: access.phoneRequired,
    foreignerNote: description || access.foreignerNote,
    link: sourceUrl.toString(),
    image: firstString(image, propertyContent($, "meta[property='og:image']")),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!adminApiToken) {
    res.status(503).json({ error: "Import API is not configured" });
    return;
  }
  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const payload = parseBody(req.body);
    const urls = requestedUrls(payload);
    const results = [];

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            "user-agent": "JapanLiveRadarBot/0.1 (+https://japan-live-radar.vercel.app)",
            accept: "text/html,application/xhtml+xml",
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!response.ok) {
          throw new Error(`source returned ${response.status}`);
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
          throw new Error("source did not return HTML");
        }

        const html = await response.text();
        results.push({
          url: url.toString(),
          draft: extractDraft(html.slice(0, 2_000_000), url),
        });
      } catch (error) {
        results.push({
          url: url.toString(),
          error: error instanceof Error ? error.message : "Import failed",
        });
      }
    }

    if (!Array.isArray(payload.urls)) {
      const [result] = results;
      if (!result || "error" in result || !("draft" in result)) {
        throw new Error(result && "error" in result ? result.error : "Import failed");
      }
      res.status(200).json({ draft: result.draft });
      return;
    }

    res.status(200).json({ results });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Import failed" });
  }
}
