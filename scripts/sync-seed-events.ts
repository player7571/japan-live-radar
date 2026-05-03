import { createClient } from "@supabase/supabase-js";
import { seedEvents } from "../src/data/seedEvents";
import { eventToSeedRow } from "../src/lib/eventRows";
import { recordSyncRun } from "../src/lib/syncRuns";

const supabaseUrl = process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const startedAt = new Date();
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL or SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const rows = seedEvents.map(eventToSeedRow);
  const { error } = await supabase.from("events").upsert(rows, {
    onConflict: "source,source_event_id",
  });

  if (error) {
    await recordSyncRun(supabase, {
      source: "Seed",
      status: "error",
      fetchedCount: seedEvents.length,
      skippedCount: seedEvents.length,
      message: error.message,
      startedAt,
    });
    throw new Error(`Seed upsert failed: ${error.message}`);
  }

  await recordSyncRun(supabase, {
    source: "Seed",
    status: "success",
    fetchedCount: seedEvents.length,
    upsertedCount: rows.length,
    message: "Seed events are available as the stable fallback dataset.",
    startedAt,
  });

  console.log(`Synced ${rows.length} seed events.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
