import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export const migrationFiles = [
  "20260504163000_create_events.sql",
  "20260504172000_create_sync_runs.sql",
  "20260504194000_create_event_candidates.sql",
  "20260504195500_create_event_alerts.sql",
  "20260504204500_extend_event_alerts_delivery.sql",
  "20260505024500_add_alert_contact_email.sql",
  "20260505091000_add_resale_sale_type.sql",
  "20260505141000_add_alert_lead_time.sql",
];

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const connectionString = requireEnv("SUPABASE_DB_URL", process.env.SUPABASE_DB_URL);
  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  await client.connect();
  try {
    for (const migration of migrationFiles) {
      const sql = await readFile(join("supabase", "migrations", migration), "utf8");
      await client.query(sql);
      console.log(`Applied ${migration}`);
    }
  } finally {
    await client.end();
  }
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
