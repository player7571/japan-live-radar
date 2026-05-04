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
          updated_at: new Date().toISOString(),
        },
        { onConflict: "client_id,event_key" },
      )
      .select("id,event_key,status,updated_at")
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
