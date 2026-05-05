type EventSnapshot = {
  date?: unknown;
  saleWindow?: unknown;
};

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

function parseSaleWindowStart(value: unknown, fallbackYear?: string) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  const isoDateTime = normalized.match(
    /\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/,
  )?.[0];
  if (isoDateTime) {
    const parsed = new Date(isoDateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const dateMatch = normalized.match(
    /(\d{4}[./年-]\s*\d{1,2}[./月-]\s*\d{1,2})(?:日)?(?:\([^)]*\))?\s*([01]?\d|2[0-3])(?::([0-5]\d)|時\s*([0-5]\d)?\s*分?)/,
  );
  if (dateMatch) {
    const dateParts = parseDateParts(dateMatch[1]);
    if (!dateParts) return null;
    const [year, month, day] = dateParts;
    const minute = dateMatch[3] ?? dateMatch[4] ?? "00";
    return new Date(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${dateMatch[2].padStart(2, "0")}:${minute}:00+09:00`,
    );
  }

  const shortDateMatch = normalized.match(
    /(^|[^\d])(\d{1,2})[./月]\s*(\d{1,2})(?:日)?(?:\([^)]*\))?\s*([01]?\d|2[0-3])(?::([0-5]\d)|時\s*([0-5]\d)?\s*分?)/,
  );
  if (shortDateMatch && fallbackYear) {
    const minute = shortDateMatch[5] ?? shortDateMatch[6] ?? "00";
    return new Date(
      `${fallbackYear}-${shortDateMatch[2].padStart(2, "0")}-${shortDateMatch[3].padStart(2, "0")}T${shortDateMatch[4].padStart(2, "0")}:${minute}:00+09:00`,
    );
  }

  const parsedDate = parseDate(normalized);
  if (parsedDate) return parsedDate;

  const shortDateOnlyMatch = normalized.match(/(^|[^\d])(\d{1,2})[./月]\s*(\d{1,2})(?:日)?/);
  if (shortDateOnlyMatch && fallbackYear) {
    return new Date(
      `${fallbackYear}-${shortDateOnlyMatch[2].padStart(2, "0")}-${shortDateOnlyMatch[3].padStart(2, "0")}T09:00:00+09:00`,
    );
  }

  return null;
}

export function calculateReminderAt(snapshot: EventSnapshot, now = new Date()) {
  const saleStart = parseSaleWindowStart(snapshot.saleWindow, eventYearFromSnapshot(snapshot));
  if (saleStart && saleStart > now) {
    const reminder = new Date(saleStart);
    reminder.setHours(reminder.getHours() - 3);
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
