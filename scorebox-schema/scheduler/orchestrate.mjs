#!/usr/bin/env node
// =============================================================================
// ScoreBox / Racing Rivals — Orchestration runner (Node fallback)
// -----------------------------------------------------------------------------
// A thin, dependency-free Node script that advances the game ENGINE by calling
// the same idempotent RPC the Edge Function uses:  public.orchestrate_tick().
//
// Use this when you'd rather schedule from Render Cron Jobs / a local crontab /
// GitHub Actions than from Supabase pg_cron. It's the *fallback* — pg_cron in
// Supabase is the primary path (see ../README in the scheduler folder).
//
// Two modes (auto-detected from env):
//   A) EDGE   — POST the deployed Edge Function. Set:
//                 ORCHESTRATE_URL=https://<ref>.functions.supabase.co/orchestrate
//                 ORCHESTRATE_SECRET=<same secret set on the function>
//   B) DIRECT — call the RPC over PostgREST with the service-role key. Set:
//                 SUPABASE_URL=https://<ref>.supabase.co
//                 SUPABASE_SERVICE_ROLE_KEY=<service role key>
//
// If both are present, EDGE wins (keeps the service-role key off this host).
//
// Optional tunables:
//   LOOKBACK_DAYS  (default 3)        — days back to re-check for resulted races
//   ORCHESTRATE_TODAY (YYYY-MM-DD)    — pin "today" for backfills (else UTC now)
//
// Run:        node scheduler/orchestrate.mjs
// Render:     add as a Cron Job, command `node scheduler/orchestrate.mjs`,
//             schedule e.g. `*/30 14-23 * * *` (UTC). Requires Node >= 18.
// Exit codes: 0 = clean, 1 = config error, 2 = ran but a unit errored, 3 = call failed.
// =============================================================================

const lookback = Number(process.env.LOOKBACK_DAYS ?? "3");
const today = process.env.ORCHESTRATE_TODAY || null;

const EDGE_URL = process.env.ORCHESTRATE_URL;
const EDGE_SECRET = process.env.ORCHESTRATE_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(msg, code = 1) {
  console.error(`[orchestrate] ${msg}`);
  process.exit(code);
}

function logSummary(summary) {
  const errored =
    (summary?.days_errored ?? 0) > 0 || (summary?.challenges_errored ?? 0) > 0;
  console.log(
    JSON.stringify({ event: "orchestrate_tick", lookback_days: lookback, today, ...summary }),
  );
  if (errored) {
    console.error(
      "[orchestrate] some units errored — inspect public.scoring_runs (status='error').",
    );
    process.exit(2);
  }
  process.exit(0);
}

async function viaEdge() {
  const res = await fetch(EDGE_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(EDGE_SECRET ? { authorization: `Bearer ${EDGE_SECRET}` } : {}),
    },
    body: JSON.stringify({ lookback_days: lookback, today }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 207) {
    die(`edge call failed (${res.status}): ${JSON.stringify(body)}`, 3);
  }
  logSummary(body.summary ?? body);
}

async function viaDirect() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/orchestrate_tick`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: SERVICE_ROLE,
      authorization: `Bearer ${SERVICE_ROLE}`,
    },
    body: JSON.stringify({ p_lookback_days: lookback, p_today: today }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    die(`rpc call failed (${res.status}): ${JSON.stringify(body)}`, 3);
  }
  logSummary(body); // RPC returns the jsonb summary directly
}

(async () => {
  if (!Number.isFinite(lookback) || lookback < 0) die("LOOKBACK_DAYS invalid");

  if (EDGE_URL) {
    await viaEdge();
  } else if (SUPABASE_URL && SERVICE_ROLE) {
    await viaDirect();
  } else {
    die(
      "no config: set ORCHESTRATE_URL (+ORCHESTRATE_SECRET) for EDGE mode, " +
        "or SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for DIRECT mode.",
    );
  }
})().catch((e) => die(`unexpected: ${e?.message ?? e}`, 3));
