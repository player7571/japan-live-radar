export type TicketAccess = "한국 구매 가능" | "일본 번호 필요" | "확인 필요";
export type SaleType = "추첨 접수" | "일반 판매" | "선착 판매" | "해외 판매";

export type AdminEventInput = {
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

export function parseAdminEventBody(body: unknown): AdminEventInput {
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

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function sourceUrlId(value: string) {
  try {
    const url = new URL(value);
    url.hash = "";
    const normalized = url.toString();
    const readable = slugify(`${url.hostname}-${url.pathname}-${url.search}`);
    return `url-${hashString(normalized)}-${readable}`.slice(0, 120);
  } catch {
    return `url-${hashString(value)}-${slugify(value)}`.slice(0, 120);
  }
}

export function toEventRow(input: AdminEventInput, rawMeta: Record<string, unknown> = {}) {
  const artist = requiredString(input.artist, "artist");
  const title = requiredString(input.title, "title");
  const city = requiredString(input.city, "city");
  const venue = requiredString(input.venue, "venue");
  const date = requiredString(input.date, "date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }

  const source = optionalString(input.source) ?? "Manual";
  const sourceUrl = optionalString(rawMeta.candidateSourceUrl) ?? optionalString(input.link);
  const sourceEventId =
    source !== "Manual" && sourceUrl
      ? sourceUrlId(sourceUrl)
      : `manual-${slugify([artist, title, city, venue, date].join("-"))}`;

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
      ...rawMeta,
    },
  };
}
