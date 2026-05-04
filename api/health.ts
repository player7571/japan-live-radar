import { createClient } from "@supabase/supabase-js";
import { serverReadKey } from "../src/lib/supabaseServer";

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

  if (req.method && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    res.status(200).json({
      ok: true,
      database: "not_configured",
      eventCount: 0,
      lastSync: null,
    });
    return;
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const syncSupabase = createClient(supabaseUrl, serverReadKey(supabaseAnonKey, serviceRoleKey));
  const [eventsResult, syncResult] = await Promise.all([
    supabase.from("events").select("id", { count: "exact", head: true }),
    syncSupabase
      .from("sync_runs")
      .select("source,status,fetched_count,upserted_count,skipped_count,message,finished_at")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (eventsResult.error) {
    res.status(200).json({
      ok: false,
      database: "error",
      eventCount: 0,
      lastSync: null,
      message: eventsResult.error.message,
    });
    return;
  }

  res.status(200).json({
    ok: true,
    database: "reachable",
    eventCount: eventsResult.count ?? 0,
    lastSync: syncResult.error ? null : (syncResult.data ?? null),
    syncRunsAvailable: !syncResult.error,
  });
}
