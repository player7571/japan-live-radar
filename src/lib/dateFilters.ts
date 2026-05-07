import { currentTokyoDay } from "./saleStatus";

export type DateWindow = "전체" | "60일 이내" | "90일 이내" | "여름 원정";

export const dateWindowOptions: DateWindow[] = ["전체", "60일 이내", "90일 이내", "여름 원정"];

function parseTokyoDate(date: string, endOfDay = false) {
  return new Date(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}+09:00`);
}

export function summerTravelRange(referenceDate = currentTokyoDay()) {
  const referenceYear = referenceDate.getFullYear();
  const currentSummerEnd = new Date(`${referenceYear}-08-31T23:59:59+09:00`);
  const year = referenceDate > currentSummerEnd ? referenceYear + 1 : referenceYear;
  return {
    start: new Date(`${year}-06-01T00:00:00+09:00`),
    end: new Date(`${year}-08-31T23:59:59+09:00`),
  };
}

export function isInDateWindow(date: string, dateWindow: DateWindow, referenceDate = currentTokyoDay()) {
  if (dateWindow === "전체") return true;

  const eventDate = parseTokyoDate(date);
  if (dateWindow === "여름 원정") {
    const range = summerTravelRange(referenceDate);
    return eventDate >= range.start && eventDate <= range.end;
  }

  const limitDays = dateWindow === "60일 이내" ? 60 : 90;
  const limit = new Date(referenceDate);
  limit.setDate(referenceDate.getDate() + limitDays);
  return eventDate >= referenceDate && eventDate <= limit;
}

export function isInSelectedDateRange(
  date: string,
  dateWindow: DateWindow,
  dateFrom: string,
  dateTo: string,
  referenceDate = currentTokyoDay(),
) {
  if (!dateFrom && !dateTo) return isInDateWindow(date, dateWindow, referenceDate);

  const eventDate = parseTokyoDate(date);
  const startDate = dateFrom ? parseTokyoDate(dateFrom) : null;
  const endDate = dateTo ? parseTokyoDate(dateTo, true) : null;
  return (!startDate || eventDate >= startDate) && (!endDate || eventDate <= endDate);
}
