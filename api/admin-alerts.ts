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

type AlertActionPayload = {
  id?: unknown;
  status?: unknown;
  error?: unknown;
};

type AlertUpdate = {
  status: "sent" | "error";
  last_sent_at?: string;
  last_error: string | null;
  send_count?: number;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const adminApiToken = process.env.ADMIN_API_TOKEN;

function headerValue(req: VercelRequest, name: string) {
  const value = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function parseBody(body: unknown): AlertActionPayload {
  if (typeof body === "string") {
    return JSON.parse(body) as AlertActionPayload;
  }
  if (body && typeof body === "object") {
    return body as AlertActionPayload;
  }
  return {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function missingAlertTable(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.message?.includes("event_alerts")));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method && req.method !== "GET" && req.method !== "PATCH") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !serviceRoleKey || !adminApiToken) {
    res.status(503).json({ error: "Admin alert API is not configured" });
    return;
  }

  if (headerValue(req, "x-admin-token") !== adminApiToken) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  if (!req.method || req.method === "GET") {
    const dueBefore = new Date().toISOString();
    const { data, error } = await supabase
      .from("event_alerts")
      .select("id,client_id,event_key,event_snapshot,channel,contact_email,status,remind_at,last_sent_at,send_count,created_at,updated_at")
      .eq("status", "active")
      .not("remind_at", "is", null)
      .lte("remind_at", dueBefore)
      .order("remind_at", { ascending: true })
      .limit(50);

    if (missingAlertTable(error)) {
      res.status(200).json({ configured: false, alerts: [] });
      return;
    }
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.status(200).json({ configured: true, alerts: data ?? [] });
    return;
  }

  const body = parseBody(req.body);
  const id = optionalString(body.id);
  const status = optionalString(body.status);
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  if (status !== "sent" && status !== "error") {
    res.status(400).json({ error: "status must be sent or error" });
    return;
  }

  let update: AlertUpdate;
  if (status === "sent") {
    const { data: current, error: currentError } = await supabase
      .from("event_alerts")
      .select("send_count")
      .eq("id", id)
      .single();

    if (missingAlertTable(currentError)) {
      res.status(503).json({ configured: false, error: "Alert table is not ready" });
      return;
    }
    if (currentError) {
      res.status(500).json({ error: currentError.message });
      return;
    }

    update = {
      status,
      last_sent_at: new Date().toISOString(),
      last_error: null,
      send_count: Number(current?.send_count ?? 0) + 1,
    };
  } else {
    update = {
      status,
      last_error: optionalString(body.error) ?? "Unknown delivery error",
    };
  }

  const { data, error } = await supabase
    .from("event_alerts")
    .update(update)
    .eq("id", id)
    .select("id,event_key,status,last_sent_at,last_error,updated_at")
    .single();

  if (missingAlertTable(error)) {
    res.status(503).json({ configured: false, error: "Alert table is not ready" });
    return;
  }
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(200).json({ ok: true, alert: data });
}
