import { createClient } from "@supabase/supabase-js";

type VercelRequest = {
  method?: string;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type TicketAccess = "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
type SaleType = "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";

type Event = {
  id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string;
  genre: string;
  source: string;
  ticketAccess: TicketAccess;
  saleType: SaleType;
  saleWindow: string;
  price: string;
  phoneRequired: boolean;
  foreignerNote: string;
  link: string;
  image: string;
};

type SyncRun = {
  source: string;
  status: "success" | "error";
  fetchedCount: number;
  upsertedCount: number;
  skippedCount: number;
  message: string | null;
  finishedAt: string;
};

type EventApiResponse = {
  events: Event[];
  source: "supabase" | "seed";
  meta?: {
    lastSync?: SyncRun;
  };
};

type EventRow = {
  id: string;
  artist: string;
  title: string;
  city: string;
  venue: string;
  date: string;
  time: string | null;
  genre: string | null;
  source: string;
  ticket_access: string;
  sale_type: string;
  sale_window: string | null;
  price: string | null;
  phone_required: boolean | null;
  foreigner_note: string | null;
  link: string | null;
  image: string | null;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;

const seedEvents: Event[] = [
  {
    id: "seed-yoasobi-tokyo-2026-06-19",
    artist: "YOASOBI",
    title: "Asia Dome Session",
    city: "도쿄",
    venue: "Tokyo Dome",
    date: "2026-06-19",
    time: "18:30",
    genre: "J-Pop",
    source: "Ticket Pia",
    ticketAccess: "확인 필요",
    saleType: "추첨 접수",
    saleWindow: "5.12 12:00 - 5.20 23:59",
    price: "¥9,800 - ¥14,800",
    phoneRequired: true,
    foreignerNote: "일본 번호 인증 가능성이 높아 대행/동행 구매 여부 확인 필요",
    link: "https://t.pia.jp/",
    image:
      "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: "seed-one-ok-rock-osaka-2026-07-03",
    artist: "ONE OK ROCK",
    title: "Neon Arena Night",
    city: "오사카",
    venue: "Osaka-jō Hall",
    date: "2026-07-03",
    time: "19:00",
    genre: "Rock",
    source: "e+",
    ticketAccess: "일본 번호 필요",
    saleType: "선착 판매",
    saleWindow: "5.25 10:00 - 매진 시",
    price: "¥11,000",
    phoneRequired: true,
    foreignerNote: "스마치케 사용 시 앱/전화번호 인증 조건 확인 필요",
    link: "https://eplus.jp/",
    image:
      "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: "seed-ado-yokohama-2026-07-21",
    artist: "Ado",
    title: "Blue Flame Tour",
    city: "요코하마",
    venue: "K-Arena Yokohama",
    date: "2026-07-21",
    time: "18:00",
    genre: "J-Pop",
    source: "Lawson Ticket",
    ticketAccess: "확인 필요",
    saleType: "추첨 접수",
    saleWindow: "5.18 13:00 - 5.27 23:59",
    price: "¥12,500",
    phoneRequired: true,
    foreignerNote: "로치케 전자티켓은 일본 앱스토어/번호 제약을 확인해야 함",
    link: "https://l-tike.com/",
    image:
      "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: "seed-newjeans-fukuoka-2026-08-08",
    artist: "NewJeans",
    title: "Summer Pop-Up Live",
    city: "후쿠오카",
    venue: "Marine Messe Fukuoka",
    date: "2026-08-08",
    time: "17:30",
    genre: "K-Pop",
    source: "Ticketmaster",
    ticketAccess: "한국 구매 가능",
    saleType: "해외 판매",
    saleWindow: "6.02 11:00 - 8.07 18:00",
    price: "¥13,200",
    phoneRequired: false,
    foreignerNote: "해외 카드 결제와 모바일 티켓 수령 조건 확인",
    link: "https://www.ticketmaster.com/",
    image:
      "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1200&q=80",
  },
  {
    id: "seed-radwimps-nagoya-2026-09-12",
    artist: "RADWIMPS",
    title: "Afterglow Hall Set",
    city: "나고야",
    venue: "Nippon Gaishi Hall",
    date: "2026-09-12",
    time: "18:00",
    genre: "Rock",
    source: "Ticket Pia",
    ticketAccess: "한국 구매 가능",
    saleType: "일반 판매",
    saleWindow: "7.04 10:00 - 9.11 23:59",
    price: "¥9,900",
    phoneRequired: false,
    foreignerNote: "해외 판매 페이지가 열릴 경우 여권명 기준으로 예매",
    link: "https://t.pia.jp/en",
    image:
      "https://images.unsplash.com/photo-1524368535928-5b5e00ddc76b?auto=format&fit=crop&w=1200&q=80",
  },
];

function seedResponse(): EventApiResponse {
  return {
    events: seedEvents,
    source: "seed",
  };
}

type SyncRunRow = {
  source: string;
  status: "success" | "error";
  fetched_count: number;
  upserted_count: number;
  skipped_count: number;
  message: string | null;
  finished_at: string;
};

function rowToSyncRun(row: SyncRunRow): SyncRun {
  return {
    source: row.source,
    status: row.status,
    fetchedCount: row.fetched_count,
    upsertedCount: row.upserted_count,
    skippedCount: row.skipped_count,
    message: row.message,
    finishedAt: row.finished_at,
  };
}

function toTicketAccess(value: string): TicketAccess {
  if (value === "한국 구매 가능" || value === "일본 번호 필요" || value === "확인 필요") {
    return value;
  }
  return "확인 필요";
}

function toSaleType(value: string): SaleType {
  if (value === "추첨 접수" || value === "일반 판매" || value === "선착 판매" || value === "해외 판매") {
    return value;
  }
  return "일반 판매";
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    artist: row.artist,
    title: row.title,
    city: row.city.trim() || "도시 미정",
    venue: row.venue,
    date: row.date,
    time: row.time ?? "시간 미정",
    genre: row.genre ?? "Music",
    source: row.source,
    ticketAccess: toTicketAccess(row.ticket_access),
    saleType: toSaleType(row.sale_type),
    saleWindow: row.sale_window ?? "판매 일정 확인 필요",
    price: row.price ?? "가격 확인 필요",
    phoneRequired: row.phone_required ?? true,
    foreignerNote: row.foreigner_note ?? "원본 티켓 페이지에서 해외 결제와 수령 조건을 확인하세요.",
    link: row.link ?? "#",
    image:
      row.image ??
      "https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1200&q=80",
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");

  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(200).json(seedResponse());
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const [eventsResult, syncResult] = await Promise.all([
    supabase
      .from("events")
      .select(
        "id,artist,title,city,venue,date,time,genre,source,ticket_access,sale_type,sale_window,price,phone_required,foreigner_note,link,image",
      )
      .eq("country_code", "JP")
      .gte("date", new Date().toISOString().slice(0, 10))
      .order("date", { ascending: true })
      .limit(100),
    supabase
      .from("sync_runs")
      .select("source,status,fetched_count,upserted_count,skipped_count,message,finished_at")
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (eventsResult.error || !eventsResult.data || eventsResult.data.length === 0) {
    res.status(200).json(seedResponse());
    return;
  }

  res.status(200).json({
    events: (eventsResult.data as EventRow[]).map(rowToEvent),
    source: "supabase",
    meta: !syncResult.error && syncResult.data
      ? {
          lastSync: rowToSyncRun(syncResult.data as SyncRunRow),
        }
      : undefined,
  } satisfies EventApiResponse);
}
