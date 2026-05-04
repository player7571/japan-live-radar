type HealthResponse = {
  ok?: boolean;
  database?: string;
  eventCount?: number;
  message?: string;
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

async function main() {
  const health = await getJson<HealthResponse>("/api/health");
  if (!health.ok) {
    throw new Error(`Health check failed: ${health.message ?? "unknown error"}`);
  }
  if (health.database !== "reachable") {
    throw new Error(`Database is ${health.database ?? "unknown"}`);
  }
  if (typeof health.eventCount !== "number" || health.eventCount < 1) {
    throw new Error("Production has no events");
  }

  if (adminApiToken) {
    const alerts = await getJson<{ configured?: boolean }>("/api/admin-alerts", {
      "x-admin-token": adminApiToken,
    });
    if (alerts.configured === false) {
      throw new Error("Admin alerts API is not configured");
    }
  }

  console.log(`Production healthy: ${health.eventCount} event(s), database ${health.database}.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

export {};
