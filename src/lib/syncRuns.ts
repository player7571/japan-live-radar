import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventApiResponse } from "../types/events";

export type SyncRunRow = {
  source: string | null;
  status: "success" | "error" | string | null;
  fetched_count: number | null;
  upserted_count: number | null;
  skipped_count: number | null;
  message: string | null;
  finished_at: string | null;
};

export type SyncRunSummary = {
  source: string;
  status: "success" | "error" | "unknown";
  fetchedCount: number;
  upsertedCount: number;
  skippedCount: number;
  message: string | null;
  finishedAt: string | null;
};

export type SyncRunInput = {
  source: string;
  status: "success" | "error";
  fetchedCount?: number;
  upsertedCount?: number;
  skippedCount?: number;
  message?: string;
  startedAt: Date;
};

export function rowToSyncRun(row: SyncRunRow): SyncRunSummary {
  const status = row.status === "success" || row.status === "error" ? row.status : "unknown";
  return {
    source: row.source?.trim() ?? "",
    status,
    fetchedCount: row.fetched_count ?? 0,
    upsertedCount: row.upserted_count ?? 0,
    skippedCount: row.skipped_count ?? 0,
    message: row.message,
    finishedAt: row.finished_at,
  };
}

export function summarizeLatestSyncRuns(rows: SyncRunRow[], maxSources = 8) {
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const source = row.source?.trim();
      if (!source || seen.has(source)) return false;
      seen.add(source);
      return true;
    })
    .map(rowToSyncRun)
    .slice(0, maxSources);
}

export function formatEventSyncLabel(meta: EventApiResponse["meta"], source: EventApiResponse["source"]) {
  const latestBySource = meta?.latestSyncBySource?.filter((item) => item.source) ?? [];
  if (latestBySource.length > 1) {
    const sourceNames = latestBySource.slice(0, 3).map((item) => item.source);
    const suffix = latestBySource.length > sourceNames.length ? ` 외 ${latestBySource.length - sourceNames.length}개` : "";
    return `${latestBySource.length}개 출처 동기화 · ${sourceNames.join(", ")}${suffix}`;
  }
  if (meta?.lastSync) {
    return `${meta.lastSync.source} ${meta.lastSync.upsertedCount}건 동기화`;
  }
  return source === "supabase" ? "DB 데이터" : "샘플 데이터";
}

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
