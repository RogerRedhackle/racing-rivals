// =============================================================================
// ScoreBox / Racing Rivals — Orchestration Edge Function
// -----------------------------------------------------------------------------
// Single entry point that the scheduler hits to advance the game ENGINE:
//   1. score every (league, day) whose races are all resulted    (run_daily_scoring)
//   2. settle every H2H challenge whose window has closed         (settle_challenge)
//
// It does NOT decide *when* to score on a wall clock. It calls one idempotent
// RPC — public.orchestrate_tick(lookback_days, today) — which internally gates
// on resulted races and skips anything already scored/settled. That means this
// function is safe to invoke as often as you like (every 15–30 min is typical);
// nothing double-scores.
//
// Auth model: the function authenticates to Postgres with the SERVICE ROLE key,
// which bypasses RLS, so the orchestrator RPCs (granted to service_role only)
// run with full privileges. The service-role key NEVER leaves Supabase — it is
// read from the function's own environment, not passed by the caller.
//
// Calling protection: set ORCHESTRATE_SECRET in the function env and pass it as
//   Authorization: Bearer <ORCHESTRATE_SECRET>   (or  ?key=<ORCHESTRATE_SECRET>)
// so random internet traffic can't trigger ticks. pg_cron / your Node fallback
// supplies the same secret.
//
// Deploy:   supabase functions deploy orchestrate --no-verify-jwt
// Secrets:  supabase secrets set ORCHESTRATE_SECRET=... \
//                                 (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are
//                                  injected automatically by the platform)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

interface TickSummary {
  ran_at: string;
  days_scored: number;
  days_errored: number;
  challenges_settled: number;
  challenges_errored: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  // -- 1. authenticate the *caller* (not the DB) --------------------------------
  const expected = Deno.env.get("ORCHESTRATE_SECRET");
  if (expected) {
    const url = new URL(req.url);
    const header = req.headers.get("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : "";
    const supplied = bearer || url.searchParams.get("key") || "";
    if (supplied !== expected) {
      return json({ error: "unauthorized" }, 401);
    }
  }

  // -- 2. read tunables (lookback window + optional pinned date) ----------------
  // lookback_days: how many days back to re-check for newly-resulted racing.
  //   3 is plenty for daily racing; raise during multi-day festivals only if a
  //   result correction can land >3 days late.
  // today: normally null (engine uses UTC now); accept an override for backfills.
  const url = new URL(req.url);
  let lookback = Number(url.searchParams.get("lookback_days") ?? "3");
  let today: string | null = url.searchParams.get("today");

  if (req.method === "POST") {
    try {
      const ct = req.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const b = await req.json();
        if (typeof b?.lookback_days === "number") lookback = b.lookback_days;
        if (typeof b?.today === "string") today = b.today;
      }
    } catch (_) {
      /* empty / non-JSON body is fine — fall back to defaults */
    }
  }
  if (!Number.isFinite(lookback) || lookback < 0 || lookback > 60) lookback = 3;

  // -- 3. connect with the service-role key (RLS bypass) ------------------------
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return json(
      { error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env" },
      500,
    );
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // -- 4. one idempotent tick ---------------------------------------------------
  const startedAt = new Date().toISOString();
  const { data, error } = await supabase.rpc("orchestrate_tick", {
    p_lookback_days: lookback,
    p_today: today, // null -> engine uses UTC today
  });

  if (error) {
    console.error("orchestrate_tick failed", error);
    return json(
      { ok: false, started_at: startedAt, lookback_days: lookback, error: error.message },
      500,
    );
  }

  const summary = data as TickSummary;
  const hadErrors =
    (summary?.days_errored ?? 0) > 0 || (summary?.challenges_errored ?? 0) > 0;

  // Log a single structured line so it shows up in `supabase functions logs`.
  console.log(
    JSON.stringify({ event: "orchestrate_tick", lookback_days: lookback, today, ...summary }),
  );

  return json(
    { ok: !hadErrors, lookback_days: lookback, today, summary },
    hadErrors ? 207 : 200, // 207 = ran but some unit errored (check scoring_runs)
  );
});
