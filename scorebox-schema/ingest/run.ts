// =============================================================================
// Ingest CLI entrypoint  (Deno or Node 18+)
// -----------------------------------------------------------------------------
// Thin runner that wires The Racing API provider to the worker and runs one of
// two jobs. Schedule these (Render Cron / crontab / GitHub Actions / Supabase
// Edge) the same way you schedule the orchestrator — see scheduler/README.
//
//   cards    — pull racecards (declarations + odds) for a date and upsert them.
//              Run a few times through the morning/afternoon for odds drift +
//              non-runner changes.
//   results  — pull finishing order + closing SP and flip races to 'resulted',
//              which lets orchestrate_tick score the day.
//
// Usage:
//   deno run -A ingest/run.ts cards    [YYYY-MM-DD]
//   deno run -A ingest/run.ts results  [YYYY-MM-DD]
//   node  --experimental-strip-types ingest/run.ts results 2026-06-17
//   (date defaults to today, UTC)
//
// Env: RACING_API_USER, RACING_API_PASS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Exit codes: 0 ok, 1 config/usage error, 3 run failed.
// =============================================================================

import { IngestWorker } from "./worker.ts";
import { TheRacingApiProvider } from "./adapters/theracingapi.ts";

function today(): string {
  return new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

async function main() {
  const argv = getArgs();
  const job = argv[0];
  const date = argv[1] ?? today();

  if (job !== "cards" && job !== "results") {
    console.error("usage: run.ts <cards|results> [YYYY-MM-DD]");
    exit(1);
    return;
  }

  let worker: IngestWorker;
  try {
    worker = new IngestWorker(new TheRacingApiProvider());
  } catch (e) {
    console.error(`[ingest] config error: ${(e as Error).message}`);
    exit(1);
    return;
  }

  try {
    if (job === "cards") {
      const s = await worker.ingestCards(date);
      console.log(JSON.stringify({ event: "ingest_cards", date, ...s }));
    } else {
      const s = await worker.ingestResults(date);
      console.log(JSON.stringify({ event: "ingest_results", date, ...s }));
    }
    exit(0);
  } catch (e) {
    console.error(`[ingest] run failed: ${(e as Error).message}`);
    exit(3);
  }
}

function getArgs(): string[] {
  // @ts-ignore Deno
  if (typeof Deno !== "undefined") return Deno.args;
  // @ts-ignore Node
  return typeof process !== "undefined" ? process.argv.slice(2) : [];
}
function exit(code: number): void {
  // @ts-ignore Deno
  if (typeof Deno !== "undefined") Deno.exit(code);
  // @ts-ignore Node
  else if (typeof process !== "undefined") process.exit(code);
}

main();
