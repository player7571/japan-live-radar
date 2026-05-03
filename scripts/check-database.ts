import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function requireEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const supabase = createClient(
    requireEnv("VITE_SUPABASE_URL", supabaseUrl),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey),
  );

  const { count, error } = await supabase
    .from("events")
    .select("id", { count: "exact", head: true });

  if (error) {
    throw new Error(`Events table check failed: ${error.message}`);
  }

  console.log(`Events table is reachable. Current rows: ${count ?? 0}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
