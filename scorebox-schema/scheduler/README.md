# ScoreBox / Racing Rivals — Scheduling & Orchestration Runbook

How the game advances itself: scoring each day's picks and settling H2H challenges,
**automatically, when racing results land** — never on a blind wall clock.

> **ENGINE layer.** Nothing here is racing-specific. The same orchestrator drives
> any sport pack, because it gates on "are this day's events resulted?" not on
> "is it 7pm?". Swap the pack, keep the scheduler.

---

## The one idea: a tick

Everything runs through a single idempotent RPC:

```sql
select public.orchestrate_tick(p_lookback_days := 3, p_today := null);
```

`orchestrate_tick`:

1. **Scores ready days** — for every *live* league across the last `p_lookback_days`
   up to today, it checks `league_day_is_resulted(league, day)`. If every race that
   day is `resulted`/`void` (and there was racing), it runs `run_daily_scoring`. Days
   already scored are skipped.
2. **Settles due challenges** — for every `pending`/`active` H2H challenge whose
   `ends_on < today` **and** whose whole window is resulted, it runs `settle_challenge`.
3. Returns a compact JSON summary and writes one audit row per unit to
   `public.scoring_runs`.

Because step 1 and step 2 both **gate on resulted events** and **skip already-done
work**, the tick is safe to call as often as you want. Calling it 50 times in a row
produces the same state as calling it once. **That is the whole safety model** — you
schedule frequently, the engine decides what's actually ready.

```
days_scored / days_errored / challenges_settled / challenges_errored
```

If `*_errored > 0`, inspect the log:

```sql
select * from public.scoring_runs where status = 'error' order by ran_at desc;
```

---

## Pick ONE place to schedule

You only need one scheduler. In order of preference:

### 1. Supabase pg_cron (recommended — primary)

Runs inside Postgres. The service-role key never leaves the database; there is no
extra host to operate. Enable once in the Supabase SQL editor:

```sql
create extension if not exists pg_cron;

-- Afternoon/evening UK racing (results roll in ~14:00–22:30 UTC).
-- Every 30 min, 14:00–23:30 UTC. lookback 3 days catches late result corrections.
select cron.schedule(
  'scorebox-orchestrate-pm',
  '*/30 14-23 * * *',
  $$ select public.orchestrate_tick(3, null); $$
);

-- A morning catch-up for early/overnight fixtures and anything missed.
select cron.schedule(
  'scorebox-orchestrate-am',
  '15 7-13 * * *',
  $$ select public.orchestrate_tick(3, null); $$
);
```

Inspect / remove:

```sql
select * from cron.job;                              -- list schedules
select * from cron.job_run_details order by start_time desc limit 20;  -- history
select cron.unschedule('scorebox-orchestrate-pm');
select cron.unschedule('scorebox-orchestrate-am');
```

(The same block lives commented-out at the bottom of `05_orchestration.sql`.)

### 2. Supabase Edge Function + external cron

Use this if you want HTTP-level visibility/alerting, or to trigger from outside
Supabase. The function (`supabase/functions/orchestrate/index.ts`) wraps the same
RPC and authenticates to Postgres with the service-role key from its own env.

```bash
# deploy
supabase functions deploy orchestrate --no-verify-jwt

# protect it (so only your scheduler can fire it)
supabase secrets set ORCHESTRATE_SECRET="$(openssl rand -hex 24)"
#   SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

# manual test
curl -X POST "https://<project-ref>.functions.supabase.co/orchestrate" \
  -H "authorization: Bearer $ORCHESTRATE_SECRET" \
  -H "content-type: application/json" \
  -d '{"lookback_days":3}'
```

Response: `200` clean, `207` ran-but-a-unit-errored (check `scoring_runs`), `401`
bad secret, `5xx` call failed. Then point any external cron at that URL.

### 3. Node fallback on Render / local (the fallback)

`scheduler/orchestrate.mjs` — zero dependencies, Node ≥ 18. Use it if you'd rather
schedule from Render Cron Jobs, a local crontab, or GitHub Actions.

```bash
# EDGE mode (preferred — keeps the service-role key off this host)
ORCHESTRATE_URL="https://<ref>.functions.supabase.co/orchestrate" \
ORCHESTRATE_SECRET="..." \
node scheduler/orchestrate.mjs

# DIRECT mode (calls the RPC over PostgREST with the service-role key)
SUPABASE_URL="https://<ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
node scheduler/orchestrate.mjs
```

Render Cron Job: command `node scheduler/orchestrate.mjs`, schedule `*/30 14-23 * * *`
(UTC), env vars as above. Exit codes: `0` clean, `1` config error, `2` ran-but-errored,
`3` call failed — so Render marks errored runs as failed and you get an alert.

> Pick **one**. Running pg_cron *and* an external cron just means the tick runs
> more often — harmless (idempotent), but redundant.

---

## Tunables

| Knob | Default | Meaning |
| --- | --- | --- |
| `p_lookback_days` / `LOOKBACK_DAYS` | `3` | How many days back to re-check for newly-resulted racing. Raise during long festivals if a result correction can land more than 3 days late. |
| `p_today` / `ORCHESTRATE_TODAY` | `null` (UTC now) | Pin "today" for backfills/replays, e.g. `2026-06-17`. |

---

## Backfill / replay a day

Safe and repeatable — the engine re-scores idempotently:

```sql
-- score & settle everything as if today were 17 Jun 2026, looking back 7 days
select public.orchestrate_tick(7, '2026-06-17');
```

To force a single league/day re-score directly (e.g. after a result correction):

```sql
select public.run_daily_scoring('<league-uuid>', '2026-06-17');
```

---

## Time zones

- **pg_cron and Render schedules are UTC.** UK clocks are UTC+1 in summer (BST), so
  `*/30 14-23 * * *` ≈ 15:00–00:30 BST — i.e. afternoon/evening racing.
- The engine's "today" is `(now() at time zone 'UTC')::date`. Around midnight UTC the
  date boundary and the UK date can differ by an hour; `lookback_days = 3` absorbs this
  so nothing is missed.

---

## Files

| File | Role |
| --- | --- |
| `../05_orchestration.sql` | Gating helpers, the three orchestrator RPCs, `scoring_runs` audit table, commented pg_cron block. |
| `supabase/functions/orchestrate/index.ts` | Edge Function wrapping `orchestrate_tick` (service-role auth, caller secret). |
| `scheduler/orchestrate.mjs` | Dependency-free Node runner (EDGE or DIRECT mode) for Render/local. |
| `scheduler/README.md` | This runbook. |
