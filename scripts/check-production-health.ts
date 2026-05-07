import { pathToFileURL } from "node:url";

type HealthResponse = {
  ok?: boolean;
  database?: string;
  eventCount?: number;
  syncRunsAvailable?: boolean;
  lastSync?: {
    source?: string;
    status?: string;
    fetchedCount?: number;
    upsertedCount?: number;
    skippedCount?: number;
    finishedAt?: string | null;
  } | null;
  latestSyncBySource?: Array<{
    source?: string;
    status?: string;
    fetchedCount?: number;
    upsertedCount?: number;
    skippedCount?: number;
    finishedAt?: string | null;
  }>;
  message?: string;
};

type AdminStatsResponse = {
  alertQueue?: {
    activeDue?: number;
    activeScheduled?: number;
    activeNext24h?: number;
    error?: number;
    sent?: number;
    nextReminderAt?: string | null;
    lastErrorAt?: string | null;
  } | null;
  syncHealth?: {
    status?: "healthy" | "stale" | "error" | "missing" | "empty";
    lastFinishedAt?: string | null;
    staleAfterHours?: number;
    errorSources?: string[];
    staleSources?: string[];
    emptySources?: string[];
    missingSources?: string[];
  } | null;
};

type EventsResponse = {
  events?: Array<{
    artist?: string;
    title?: string;
    city?: string;
    venue?: string;
    date?: string;
    source?: string;
    ticketAccess?: string;
    saleType?: string;
    saleWindow?: string;
    phoneRequired?: boolean;
    foreignerNote?: string;
    link?: string;
  }>;
  source?: string;
  meta?: {
    latestSyncBySource?: HealthResponse["latestSyncBySource"];
  };
};

const appBaseUrl = (process.env.APP_BASE_URL ?? "https://japan-live-radar.vercel.app").replace(/\/$/, "");
const adminApiToken = process.env.ADMIN_API_TOKEN;

async function getJson<T>(path: string, headers?: Record<string, string>) {
  const response = await fetch(`${appBaseUrl}${path}`, { headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(`${path} failed with ${response.status}: ${text}`);
  }

  return body;
}

export function validateProductionHealth(health: HealthResponse) {
  if (!health.ok) {
    throw new Error(`Health check failed: ${health.message ?? "unknown error"}`);
  }
  if (health.database !== "reachable") {
    throw new Error(`Database is ${health.database ?? "unknown"}`);
  }
  if (typeof health.eventCount !== "number" || health.eventCount < 1) {
    throw new Error("Production has no events");
  }
  if (health.syncRunsAvailable === false) {
    throw new Error("Sync run history is unavailable");
  }
  if (health.lastSync !== undefined && health.lastSync !== null) {
    if (!health.lastSync.source || !health.lastSync.status) {
      throw new Error("Production health last sync row is invalid");
    }
  }
  if (health.latestSyncBySource !== undefined) {
    if (!Array.isArray(health.latestSyncBySource)) {
      throw new Error("Production health sync summary is invalid");
    }
    for (const row of health.latestSyncBySource) {
      if (!row.source || !row.status) {
        throw new Error("Production health sync summary contains an invalid source row");
      }
    }
  }
}

export function validateProductionEvents(response: EventsResponse) {
  if (response.source !== "supabase") {
    throw new Error(`Production events API is using ${response.source ?? "unknown"} data`);
  }
  if (!Array.isArray(response.events) || response.events.length < 1) {
    throw new Error("Production events API returned no events");
  }

  for (const event of response.events.slice(0, 10)) {
    if (!event.artist || !event.title || !event.city || !event.venue || !event.date || !event.source) {
      throw new Error("Production events API contains an event with missing display fields");
    }
    if (!event.ticketAccess || !event.saleType || !event.saleWindow || typeof event.phoneRequired !== "boolean") {
      throw new Error("Production events API contains an event with missing ticket fields");
    }
    if (!event.foreignerNote) {
      throw new Error("Production events API contains an event with missing foreigner guidance");
    }
    if (!event.link) {
      throw new Error("Production events API contains an event with no source link");
    }
    try {
      new URL(event.link);
    } catch {
      throw new Error("Production events API contains an event with an invalid source link");
    }
  }

  const latestSyncBySource = response.meta?.latestSyncBySource;
  if (latestSyncBySource !== undefined && !Array.isArray(latestSyncBySource)) {
    throw new Error("Production events API sync summary is invalid");
  }
}

export function validateAdminAlertsHealth(alerts: { configured?: boolean; alerts?: unknown[] }) {
  if (alerts.configured === false) {
    throw new Error("Admin alerts API is not configured");
  }
  if (!Array.isArray(alerts.alerts)) {
    throw new Error("Admin alerts API did not return an alert list");
  }
}

export function validateAdminStatsHealth(stats: AdminStatsResponse) {
  if (stats.alertQueue === null || stats.alertQueue === undefined) {
    throw new Error("Admin stats alert queue is not configured");
  }
  if ((stats.alertQueue.error ?? 0) > 0) {
    throw new Error(`Alert queue has ${stats.alertQueue.error} errored alert(s)`);
  }

  const syncHealth = stats.syncHealth;
  if (syncHealth === null || syncHealth === undefined) {
    throw new Error("Admin stats sync health is not configured");
  }
  if (syncHealth.status === "missing") {
    throw new Error("Sync health has no run history");
  }
  if (syncHealth.status === "error") {
    throw new Error(`Sync health reports errors: ${syncHealth.errorSources?.join(", ") || "source unknown"}`);
  }
  if (syncHealth.status === "stale") {
    throw new Error(`Sync health is stale: ${syncHealth.staleSources?.join(", ") || "source unknown"}`);
  }
  if (syncHealth.status === "empty") {
    console.warn(`Sync health produced no usable rows: ${syncHealth.emptySources?.join(", ") || "source unknown"}`);
    return;
  }
  if ((syncHealth.missingSources?.length ?? 0) > 0) {
    console.warn(`Sync health has sources without run history: ${syncHealth.missingSources?.join(", ")}`);
  }
  if (syncHealth.status !== "healthy") {
    throw new Error(`Sync health status is ${syncHealth.status ?? "unknown"}`);
  }
}

async function main() {
  const health = await getJson<HealthResponse>("/api/health");
  validateProductionHealth(health);

  const events = await getJson<EventsResponse>("/api/events");
  validateProductionEvents(events);

  if (adminApiToken) {
    const adminHeaders = {
      "x-admin-token": adminApiToken,
    };
    const alerts = await getJson<{ configured?: boolean; alerts?: unknown[] }>("/api/admin-alerts", adminHeaders);
    validateAdminAlertsHealth(alerts);

    const stats = await getJson<AdminStatsResponse>("/api/admin-stats", adminHeaders);
    validateAdminStatsHealth(stats);
  }

  console.log(`Production healthy: ${health.eventCount} health event(s), ${events.events?.length ?? 0} API event(s), database ${health.database}.`);
}

function isDirectRun() {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

export {};
