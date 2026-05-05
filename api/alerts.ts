import { createClient } from "@supabase/supabase-js";
import { calculateReminderAt, normalizeAlertLeadTimeHours } from "../src/lib/alertSchedule.js";

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
  contactEmail?: unknown;
  remindBeforeHours?: unknown;
};

type EventSnapshot = {
  id?: unknown;
  artist?: unknown;
  title?: unknown;
  city?: unknown;
  venue?: unknown;
  date?: unknown;
  time?: unknown;
  source?: unknown;
  ticketAccess?: unknown;
  saleType?: unknown;
  saleWindow?: unknown;
  price?: unknown;
  phoneRequired?: unknown;
  foreignerNote?: unknown;
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

export function normalizeAlertContactEmail(value: unknown) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("contactEmail must be a valid email address");
  }
  return email.slice(0, 254);
}

export { calculateReminderAt, normalizeAlertLeadTimeHours };

export function buildAlertUpsertRow(input: {
  clientId: string;
  snapshot: EventSnapshot;
  active: boolean;
  contactEmail: string | null;
  remindBeforeHours?: unknown;
  now?: Date;
}) {
  const remindBeforeHours = normalizeAlertLeadTimeHours(input.remindBeforeHours);
  return {
    client_id: input.clientId,
    event_key: eventKey(input.snapshot),
    event_snapshot: input.snapshot,
    status: input.active ? "active" : "cancelled",
    channel: input.contactEmail ? "email" : "browser",
    contact_email: input.contactEmail,
    remind_before_hours: remindBeforeHours,
    remind_at: input.active ? calculateReminderAt(input.snapshot, input.now, remindBeforeHours) : null,
    last_sent_at: null,
    last_error: null,
    send_count: 0,
    updated_at: (input.now ?? new Date()).toISOString(),
  };
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
    const contactEmail = normalizeAlertContactEmail(body.contactEmail);
    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { data, error } = await supabase
      .from("event_alerts")
      .upsert(
        buildAlertUpsertRow({ clientId, snapshot, active, contactEmail, remindBeforeHours: body.remindBeforeHours }),
        { onConflict: "client_id,event_key" },
      )
      .select("id,event_key,status,remind_at,remind_before_hours,updated_at")
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
