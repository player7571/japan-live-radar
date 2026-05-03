import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

const migrations = ["20260504163000_create_events.sql", "20260504172000_create_sync_runs.sql"];

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
    for (const migration of migrations) {
      const sql = await readFile(join("supabase", "migrations", migration), "utf8");
      await client.query(sql);
      console.log(`Applied ${migration}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
