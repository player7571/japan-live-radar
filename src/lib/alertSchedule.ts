type EventSnapshot = {
  date?: unknown;
  saleWindow?: unknown;
};

export const defaultAlertLeadTimeHours = 3;
const allowedAlertLeadTimeHours = [3, 24, 72] as const;

export function normalizeAlertLeadTimeHours(value: unknown) {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return defaultAlertLeadTimeHours;
  const normalized = Math.trunc(parsed);
  return allowedAlertLeadTimeHours.find((hours) => hours === normalized) ?? defaultAlertLeadTimeHours;
}

function parseDate(value: string) {
  const isoDate = value.match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return new Date(`${isoDate}T09:00:00+09:00`);

  const jpDate = parseDateParts(value);
  if (jpDate?.length === 3) {
    const [year, month, day] = jpDate;
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T09:00:00+09:00`);
  }

  return null;
}

function parseDateParts(value: string) {
  return value.match(/(\d{4})[./年-]\s*(\d{1,2})[./月-]\s*(\d{1,2})/)?.slice(1) ?? null;
}

function eventYearFromSnapshot(snapshot: EventSnapshot) {
  return typeof snapshot.date === "string" ? snapshot.date.match(/^(\d{4})-/)?.[1] : undefined;
}

function parseDateTime(value: string, fallbackYear?: string) {
  const normalized = value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const isoDateTime = normalized.match(
    /\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/,
  )?.[0];
  if (isoDateTime) {
    const parsed = new Date(isoDateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dateTimeMatch = normalized.match(
    /(?:(\d{4})[./年-]\s*)?(\d{1,2})[./月-]\s*(\d{1,2})(?:日)?(?:\([^)]*\))?\s*([01]?\d|2[0-3])(?::([0-5]\d)|時\s*([0-5]\d)?\s*分?)/,
  );
  if (dateTimeMatch) {
    const year = dateTimeMatch[1] ?? fallbackYear;
    if (!year) return null;
    const minute = dateTimeMatch[5] ?? dateTimeMatch[6] ?? "00";
    return new Date(
      `${year}-${dateTimeMatch[2].padStart(2, "0")}-${dateTimeMatch[3].padStart(2, "0")}T${dateTimeMatch[4].padStart(2, "0")}:${minute}:00+09:00`,
    );
  }

  return null;
}

function uniqueDates(dates: Date[]) {
  const seen = new Set<number>();
  return dates.filter((date) => {
    const time = date.getTime();
    if (seen.has(time)) return false;
    seen.add(time);
    return true;
  });
}

function saleWindowStartCandidates(value: unknown, fallbackYear?: string) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const candidates: Date[] = [];
  const addCandidate = (raw: string | undefined) => {
    if (!raw) return;
    const parsed = parseDateTime(raw, fallbackYear);
    if (parsed) candidates.push(parsed);
  };
  const clockPattern = String.raw`(?:[01]?\d|2[0-3])(?::[0-5]\d|時\s*(?:[0-5]\d)?\s*分?)`;
  const fullDateTimePattern = String.raw`\d{4}[./年-]\s*\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*${clockPattern}`;
  const shortDateTimePattern = String.raw`(?:\d{4}[./年-]\s*)?\d{1,2}[./月-]\s*\d{1,2}(?:日)?(?:\([^)]*\))?\s*${clockPattern}`;
  const startDateTimePattern = fallbackYear ? shortDateTimePattern : fullDateTimePattern;
  const isoDateTimePattern = String.raw`\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?`;
  const rangeEndPattern = String.raw`${shortDateTimePattern}|${isoDateTimePattern}|予定枚数終了|売切|売り切れ`;

  for (const match of normalized.matchAll(new RegExp(`(${isoDateTimePattern})\\s*(?:[~〜～\\-]|から|より)\\s*(?:${rangeEndPattern})`, "g"))) {
    addCandidate(match[1]);
  }

  const rangePattern = new RegExp(
    `(受付期間|販売期間|申込期間|申込み期間|応募期間|エントリー期間|チケット受付期間|発売期間|抽選受付期間|抽選受付|抽選申込期間|抽選販売|先行受付期間|先行受付|一般発売|発売日|선예매|일반 판매|해외 판매|리세일)?[:：]?\\s*` +
      `(${startDateTimePattern})\\s*(?:[~〜～\\-]|から|より)\\s*(?:${rangeEndPattern})`,
    "g",
  );
  for (const match of normalized.matchAll(rangePattern)) {
    addCandidate(match[2]);
  }

  const labeledStartPattern = new RegExp(
    `(受付開始|販売開始日時|販売開始|発売開始日時|発売開始|発売日時|発売日|一般発売|抽選受付|抽選申込|応募開始|エントリー開始|先行受付|선예매|일반 판매|해외 판매|리세일)[:：]?\\s*(${startDateTimePattern}|${isoDateTimePattern})`,
    "g",
  );
  for (const match of normalized.matchAll(labeledStartPattern)) {
    addCandidate(match[2]);
  }

  if (candidates.length > 0) return uniqueDates(candidates);

  const parsedDateTime = parseDateTime(normalized, fallbackYear);
  if (parsedDateTime) return [parsedDateTime];

  const parsedDate = parseDate(normalized);
  if (parsedDate) return [parsedDate];

  const shortDateOnlyMatch = normalized.match(/(^|[^\d])(\d{1,2})[./月]\s*(\d{1,2})(?:日)?/);
  return shortDateOnlyMatch && fallbackYear
    ? [new Date(`${fallbackYear}-${shortDateOnlyMatch[2].padStart(2, "0")}-${shortDateOnlyMatch[3].padStart(2, "0")}T09:00:00+09:00`)]
    : [];
}

export function calculateReminderAt(snapshot: EventSnapshot, now = new Date(), leadTimeHours = defaultAlertLeadTimeHours) {
  const saleStart = (saleWindowStartCandidates(snapshot.saleWindow, eventYearFromSnapshot(snapshot)) ?? [])
    .filter((candidate) => candidate > now)
    .sort((left, right) => left.getTime() - right.getTime())[0];
  if (saleStart && saleStart > now) {
    const reminder = new Date(saleStart);
    reminder.setHours(reminder.getHours() - normalizeAlertLeadTimeHours(leadTimeHours));
    return (reminder > now ? reminder : saleStart).toISOString();
  }

  if (typeof snapshot.date === "string") {
    const eventDate = parseDate(snapshot.date);
    if (eventDate && eventDate > now) {
      eventDate.setDate(eventDate.getDate() - 7);
      return (eventDate > now ? eventDate : parseDate(snapshot.date))?.toISOString() ?? null;
    }
  }

  return null;
}
