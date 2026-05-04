import { createClient } from "@supabase/supabase-js";
import { seedEvents } from "../src/data/seedEvents";
import { rowToEvent, type EventRow } from "../src/lib/eventRows";
import { serverReadKey } from "../src/lib/supabaseServer";
import type { EventApiResponse, SyncRun } from "../src/types/events";

type VercelRequest = {
  method?: string;
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function seedResponse(): EventApiResponse {
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
  const syncSupabase = createClient(supabaseUrl, serverReadKey(supabaseAnonKey, serviceRoleKey));
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
    syncSupabase
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
