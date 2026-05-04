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

function cleanTitle(value: string, hostname: string) {
  return compactWhitespace(value)
    .replace(/\s*[|｜]\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|LiveFans).*$/i, "")
    .replace(/\s*-\s*(チケットぴあ|e\+|イープラス|ローチケ|ローソンチケット|LiveFans).*$/i, "")
    .replace(new RegExp(`\\s*[|｜-]\\s*${hostname.replace(/^www\\./, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`, "i"), "")
    .trim();
}

function normalizeDate(value: string) {
  const isoDate = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;

  const jpDate = value.match(/(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/)?.slice(1);
  if (jpDate?.length === 3) {
    const [year, month, day] = jpDate;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return "";
}

function normalizeTime(value: string) {
  return value.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)?.[0] ?? "";
}

function normalizePriceText(value: string) {
  const normalized = normalizeFullWidth(value);
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
  const phoneSignal = /(電話番号|携帯電話|SMS|SMS認証|本人確認|電子チケット|スマチケ|MOALA|ローチケ電子チケット|認証)/i.test(text);

  if (overseasSignal && !phoneSignal) {
    return {
      phoneRequired: false,
      ticketAccess: "한국 구매 가능",
      foreignerNote: "해외/외국인 판매 신호가 있어 한국에서 예매 가능성이 있습니다. 결제와 수령 조건은 원본에서 확인하세요.",
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
  const range = normalized.match(
    /(受付期間|販売期間|申込期間|発売期間|抽選受付|先行受付|一般発売|発売日)?[:：]?\s*(\d{4}[./年-]\s*\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*(?:[01]?\d|2[0-3]):[0-5]\d)\s*(?:[~〜～\-]|から|より)\s*(\d{4}[./年-]\s*\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*(?:[01]?\d|2[0-3]):[0-5]\d|予定枚数終了|売切|売り切れ)/,
  );
  if (!range) return "";
  return `${compactWhitespace(range[2])} - ${compactWhitespace(range[3])}`;
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
    ["大阪", "오사카"],
    ["Osaka", "오사카"],
    ["横浜", "요코하마"],
    ["Yokohama", "요코하마"],
    ["名古屋", "나고야"],
    ["Nagoya", "나고야"],
    ["福岡", "후쿠오카"],
    ["Fukuoka", "후쿠오카"],
    ["埼玉", "사이타마"],
    ["Saitama", "사이타마"],
    ["千葉", "치바"],
    ["Chiba", "치바"],
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
  const offers = eventJson?.offers && typeof eventJson.offers === "object" ? (eventJson.offers as Record<string, unknown>) : {};
  const performer =
    eventJson?.performer && typeof eventJson.performer === "object"
      ? (eventJson.performer as Record<string, unknown>)
      : {};
  const rawTitle = firstString(
    eventJson?.name,
    propertyContent($, "meta[property='og:title']"),
    propertyContent($, "meta[name='twitter:title']"),
    $("title").first().text(),
  );
  const title = cleanTitle(rawTitle, sourceUrl.hostname);
  const description = firstString(
    eventJson?.description,
    propertyContent($, "meta[property='og:description']"),
    propertyContent($, "meta[name='description']"),
  );
  const dateSource = firstString(eventJson?.startDate, $("time[datetime]").first().attr("datetime"), pageText);
  const price = normalizePriceText(firstString(offers.price, offers.lowPrice, offers.highPrice, pageText));
  const imageValue = eventJson?.image;
  const image = Array.isArray(imageValue) ? firstString(imageValue[0]) : firstString(imageValue);
  const venue = firstString(location.name);
  const textForCity = [venue, address.addressLocality, address.addressRegion, pageText].join(" ");
  const access = accessFromText(`${description} ${pageText}`);
  const saleWindow = firstString(offers.availabilityStarts, offers.validFrom, saleWindowFromText(pageText));

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
