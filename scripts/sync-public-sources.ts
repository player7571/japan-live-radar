import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { publicEventSources, type PublicEventSource } from "../src/lib/publicSources";

type PublicSyncStep = PublicEventSource;

export const publicSyncSteps: PublicSyncStep[] = publicEventSources;

function normalizeToken(value: string) {
  return value.trim().toLowerCase();
}

export function normalizePublicSyncSelection(value: string | undefined) {
  const tokens = (value ?? "")
    .split(/[\n,]+/)
    .map(normalizeToken)
    .filter(Boolean);

  if (tokens.length === 0 || tokens.includes("all")) return publicSyncSteps;

  const selected = new Map<string, PublicSyncStep>();
  for (const token of tokens) {
    const step = publicSyncSteps.find(
      (candidate) => candidate.key === token || candidate.script === token || candidate.aliases.map(normalizeToken).includes(token),
    );
    if (!step) {
      throw new Error(
        `Unknown sync source "${token}". Use one of: all, ${publicSyncSteps
          .flatMap((candidate) => [candidate.key, candidate.script])
          .join(", ")}`,
      );
    }
    selected.set(step.key, step);
  }

  return [...selected.values()];
}

export function publicSyncPlanSummary(steps: PublicSyncStep[]) {
  return steps.map((step) => `${step.label} (${step.script})`).join(", ");
}

function runNpmScript(script: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn("npm", ["run", script], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function main() {
  const steps = normalizePublicSyncSelection(process.env.SYNC_PUBLIC_SOURCES);
  const continueOnError = /^(1|true|yes)$/i.test(process.env.SYNC_CONTINUE_ON_ERROR ?? "");
  const failures: Array<{ step: PublicSyncStep; code: number }> = [];

  console.log(`Running public event sync: ${publicSyncPlanSummary(steps)}`);
  for (const step of steps) {
    console.log(`\n==> ${step.label}: npm run ${step.script}`);
    const code = await runNpmScript(step.script);
    if (code === 0) continue;

    failures.push({ step, code });
    if (!continueOnError) {
      throw new Error(`${step.label} sync failed with exit code ${code}`);
    }
  }

  if (failures.length > 0) {
    const summary = failures.map(({ step, code }) => `${step.label} exited ${code}`).join("; ");
    throw new Error(`Public event sync completed with failures: ${summary}`);
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
