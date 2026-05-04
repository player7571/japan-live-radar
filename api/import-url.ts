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
  saleWindow: string;
  price: string;
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
  saleWindow: "",
  price: "",
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

function extractDraft(html: string, sourceUrl: URL): ImportedDraft {
  const $ = cheerio.load(html);
  const pageText = $("body").text().replace(/\s+/g, " ").trim();
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
  const title = firstString(
    eventJson?.name,
    propertyContent($, "meta[property='og:title']"),
    propertyContent($, "meta[name='twitter:title']"),
    $("title").first().text(),
  );
  const description = firstString(
    eventJson?.description,
    propertyContent($, "meta[property='og:description']"),
    propertyContent($, "meta[name='description']"),
  );
  const dateSource = firstString(eventJson?.startDate, $("time[datetime]").first().attr("datetime"), pageText);
  const price = firstString(offers.price, offers.lowPrice, offers.highPrice);
  const imageValue = eventJson?.image;
  const image = Array.isArray(imageValue) ? firstString(imageValue[0]) : firstString(imageValue);
  const venue = firstString(location.name);
  const textForCity = [venue, address.addressLocality, address.addressRegion, pageText].join(" ");

  return {
    ...fallbackDraft,
    artist: firstString(performer.name, title.split(/[｜|]/)[0]),
    title,
    city: cityFromText(textForCity),
    venue,
    date: normalizeDate(dateSource),
    time: normalizeTime(dateSource),
    source: sourceFromHostname(sourceUrl.hostname),
    saleWindow: firstString(offers.availabilityStarts, offers.validFrom),
    price: price ? `¥${Number(price).toLocaleString("ja-JP")}` : "",
    foreignerNote: description || fallbackDraft.foreignerNote,
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
