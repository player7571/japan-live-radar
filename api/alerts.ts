import { createClient } from "@supabase/supabase-js";

type VercelRequest = {
  method?: string;
  body?: unknown;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

type AlertPayload = {
  clientId?: unknown;
  event?: unknown;
  active?: unknown;
};

type EventSnapshot = {
  id?: unknown;
  artist?: unknown;
  title?: unknown;
  date?: unknown;
  saleWindow?: unknown;
  link?: unknown;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function parseBody(body: unknown): AlertPayload {
  if (typeof body === "string") {
    return JSON.parse(body) as AlertPayload;
  }
  if (body && typeof body === "object") {
    return body as AlertPayload;
  }
  return {};
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function missingAlertTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("event_alerts")));
}

function eventKey(snapshot: EventSnapshot) {
  return requiredString(snapshot.id, "event.id").slice(0, 160);
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

function parseSaleWindowStart(value: unknown) {
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
    /(\d{4}[./年-]\s*\d{1,2}[./月-]\s*\d{1,2})(?:日)?(?:\([^)]*\))?\s*([01]?\d|2[0-3]):([0-5]\d)/,
  );
  if (dateMatch) {
    const dateParts = parseDateParts(dateMatch[1]);
    if (!dateParts) return null;
    const [year, month, day] = dateParts;
    return new Date(
      `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${dateMatch[2].padStart(2, "0")}:${dateMatch[3]}:00+09:00`,
    );
  }

  return parseDate(normalized);
}

export function calculateReminderAt(snapshot: EventSnapshot, now = new Date()) {
  const saleStart = parseSaleWindowStart(snapshot.saleWindow);
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey) {
    res.status(503).json({ error: "Alert API is not configured" });
    return;
  }

  try {
    const body = parseBody(req.body);
    const clientId = requiredString(body.clientId, "clientId").slice(0, 120);
    if (!body.event || typeof body.event !== "object") {
      throw new Error("event is required");
    }

    const snapshot = body.event as EventSnapshot;
    const active = body.active !== false;
    const remindAt = active ? calculateReminderAt(snapshot) : null;
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase
      .from("event_alerts")
      .upsert(
        {
          client_id: clientId,
          event_key: eventKey(snapshot),
          event_snapshot: snapshot,
          status: active ? "active" : "cancelled",
          channel: "browser",
          remind_at: remindAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_id,event_key" },
      )
      .select("id,event_key,status,remind_at,updated_at")
      .single();

    if (missingAlertTable(error)) {
      res.status(200).json({ configured: false, ok: true });
      return;
    }
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ configured: true, ok: true, alert: data });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid request" });
  }
}
