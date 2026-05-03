import type { SupabaseClient } from "@supabase/supabase-js";

export type SyncRunInput = {
  source: string;
  status: "success" | "error";
  fetchedCount?: number;
  upsertedCount?: number;
  skippedCount?: number;
  message?: string;
  startedAt: Date;
};

export async function recordSyncRun(supabase: SupabaseClient, input: SyncRunInput) {
  const { error } = await supabase.from("sync_runs").insert({
    source: input.source,
    status: input.status,
    fetched_count: input.fetchedCount ?? 0,
    upserted_count: input.upsertedCount ?? 0,
    skipped_count: input.skippedCount ?? 0,
    message: input.message ?? null,
    started_at: input.startedAt.toISOString(),
    finished_at: new Date().toISOString(),
  });

  if (error) {
    console.warn(`Could not record ${input.source} sync run: ${error.message}`);
  }
}
