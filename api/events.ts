import { createClient } from "@supabase/supabase-js";
import { seedEvents } from "../src/data/seedEvents";
import { rowToEvent, type EventRow } from "../src/lib/eventRows";
import type { EventApiResponse } from "../src/types/events";

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

function seedResponse(): EventApiResponse {
  return {
    events: seedEvents,
    source: "seed",
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
  const { data, error } = await supabase
    .from("events")
    .select(
      "id,artist,title,city,venue,date,time,genre,source,ticket_access,sale_type,sale_window,price,phone_required,foreigner_note,link,image",
    )
    .eq("country_code", "JP")
    .gte("date", new Date().toISOString().slice(0, 10))
    .order("date", { ascending: true })
    .limit(100);

  if (error || !data || data.length === 0) {
    res.status(200).json(seedResponse());
    return;
  }

  res.status(200).json({
    events: (data as EventRow[]).map(rowToEvent),
    source: "supabase",
  } satisfies EventApiResponse);
}
