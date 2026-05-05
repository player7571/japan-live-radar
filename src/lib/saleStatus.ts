import type { Event } from "../types/events";

export type SaleStatus = "전체" | "오픈 예정" | "판매 중" | "판매 종료" | "확인 필요";

const endedStatusCue =
  /(販売終了|受付終了|申込終了|募集終了|終了しました|予定枚数終了|売切|売り切れ|完売|판매\s*종료|sold\s*out|closed|ended)/i;
const activeStatusCue = /(販売中(?!止)|受付中|発売中|申込受付中|チケット発売中|판매\s*중|on\s*sale|available\s*now|now\s*on\s*sale)/i;
const upcomingStatusCue = /(販売予定|受付予定|発売予定|近日発売|準備中|오픈\s*예정|coming\s*soon)/i;

export function currentTokyoDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((acc, part) => {
      if (part.type !== "literal") acc[part.type] = part.value;
      return acc;
    }, {});

  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+09:00`);
}

function parseSaleWindowDateParts(year: number, month: string, day: string, hour?: string, minute?: string) {
  return new Date(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${(hour ?? "00").padStart(2, "0")}:${minute ?? "00"}:00+09:00`,
  );
}

function normalizeFullWidth(value: string) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

const saleWindowDatePattern = String.raw`(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})(?:日)?(?:\([^)]*\))?\s*(?:(\d{1,2})(?::(\d{2})|時\s*(\d{2})?\s*分?))?`;
const shortSaleWindowDatePattern = String.raw`(^|[^\d])(\d{1,2})[./月]\s*(\d{1,2})(?:日)?(?:\([^)]*\))?\s*(?:(\d{1,2})(?::(\d{2})|時\s*(\d{2})?\s*分?))?`;
const isoSaleWindowDateTimePattern = /\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;

function getSaleWindowDates(saleWindow: string, eventDate: string, referenceDate = currentTokyoDay()) {
  const normalizedSaleWindow = normalizeFullWidth(saleWindow);
  const isoDateTimeMatches = Array.from(normalizedSaleWindow.matchAll(isoSaleWindowDateTimePattern))
    .map((match) => new Date(match[0]))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (isoDateTimeMatches.length > 0) return isoDateTimeMatches;

  const eventYear = Number(eventDate.slice(0, 4)) || referenceDate.getFullYear();
  const explicitYearMatches = Array.from(normalizedSaleWindow.matchAll(new RegExp(saleWindowDatePattern, "g")));

  if (explicitYearMatches.length > 0) {
    return explicitYearMatches.map((match) =>
      parseSaleWindowDateParts(Number(match[1]), match[2], match[3], match[4], match[5] ?? match[6]),
    );
  }

  return Array.from(normalizedSaleWindow.matchAll(new RegExp(shortSaleWindowDatePattern, "g"))).map((match) =>
    parseSaleWindowDateParts(eventYear, match[2], match[3], match[4], match[5] ?? match[6]),
  );
}

function getSaleWindowCueStatus(saleWindow: string): Exclude<SaleStatus, "전체"> | null {
  if (endedStatusCue.test(saleWindow)) return "판매 종료";
  if (activeStatusCue.test(saleWindow)) return "판매 중";
  if (upcomingStatusCue.test(saleWindow)) return "오픈 예정";
  return null;
}

export function getSaleStatus(event: Event, referenceDate = currentTokyoDay()): Exclude<SaleStatus, "전체"> {
  const saleWindow = event.saleWindow.trim();
  if (!saleWindow) return "확인 필요";

  const [startDate, endDate] = getSaleWindowDates(saleWindow, event.date, referenceDate);
  if (startDate) {
    if (referenceDate < startDate) return "오픈 예정";
    if (endDate && referenceDate > endDate) return "판매 종료";
    return "판매 중";
  }

  return getSaleWindowCueStatus(saleWindow) ?? "확인 필요";
}
