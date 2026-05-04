import { createClient } from "@supabase/supabase-js";

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

type TicketAccess = "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
type SaleType = "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";

type AdminEventInput = {
  artist?: unknown;
  title?: unknown;
  city?: unknown;
  venue?: unknown;
  date?: unknown;
  time?: unknown;
  genre?: unknown;
  source?: unknown;
  ticketAccess?: unknown;
  saleType?: unknown;
  saleWindow?: unknown;
  price?: unknown;
  phoneRequired?: unknown;
  foreignerNote?: unknown;
  link?: unknown;
  image?: unknown;
};

type AdminEventRow = {
  id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  source: string;
  updated_at: string;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminApiToken = process.env.ADMIN_API_TOKEN;

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody(body: unknown): AdminEventInput {
  if (typeof body === "string") {
    return JSON.parse(body) as AdminEventInput;
  }
  if (body && typeof body === "object") {
    return body as AdminEventInput;
  }
  return {};
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toTicketAccess(value: unknown): TicketAccess {
  if (value === "한국 구매 가능" || value === "일본 번호 필요" || value === "확인 필요") {
    return value;
  }
  return "확인 필요";
}

function toSaleType(value: unknown): SaleType {
  if (value === "추첨 접수" || value === "일반 판매" || value === "선착 판매" || value === "해외 판매") {
    return value;
  }
  return "일반 판매";
}

function slugify(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function toEventRow(input: AdminEventInput) {
  const artist = requiredString(input.artist, "artist");
  const title = requiredString(input.title, "title");
  const city = requiredString(input.city, "city");
  const venue = requiredString(input.venue, "venue");
  const date = requiredString(input.date, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const source = optionalString(input.source) ?? "Manual";
  const sourceEventId = `manual-${slugify([artist, title, city, venue, date].join("-"))}`;

  return {
    source,
    source_event_id: sourceEventId,
    artist,
    title,
    city,
    venue,
    date,
    time: optionalString(input.time),
    genre: optionalString(input.genre) ?? "Music",
    ticket_access: toTicketAccess(input.ticketAccess),
    sale_type: toSaleType(input.saleType),
    sale_window: optionalString(input.saleWindow),
    price: optionalString(input.price),
    phone_required: Boolean(input.phoneRequired),
    foreigner_note:
      optionalString(input.foreignerNote) ?? "원본 티켓 페이지에서 해외 결제와 수령 조건을 확인하세요.",
    link: optionalString(input.link),
    image: optionalString(input.image),
    country_code: "JP",
    raw: {
      source: "admin",
      submittedAt: new Date().toISOString(),
      input,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey || !adminApiToken) {
    res.status(503).json({ error: "Admin API is not configured" });
    return;
  }

  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  if (!req.method || req.method === "GET") {
    const { data, error } = await supabase
      .from("events")
      .select("id,artist,title,city,venue,date,source,updated_at")
      .eq("country_code", "JP")
      .order("updated_at", { ascending: false })
      .limit(20);

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ events: data as AdminEventRow[] });
    return;
  }

  try {
    const row = toEventRow(parseBody(req.body));
    const { data, error } = await supabase
      .from("events")
      .upsert(row, { onConflict: "source,source_event_id" })
      .select("id,artist,title,city,venue,date,source,source_event_id")
      .single();

    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ ok: true, event: data });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
  }
}
