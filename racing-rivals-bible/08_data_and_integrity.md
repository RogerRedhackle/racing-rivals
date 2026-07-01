# 08 · Data & Integrity  ⬜ MIXED

The production data layer. The **integrity model is 🟦 ENGINE** (every sport inherits the same four walls); the racing tables are 🟥 PACK.

Full source: `scorebox-schema/` — `01_schema.sql`, `02_functions_triggers.sql`, `03_rls_policies.sql`, `04_tiebreaks.sql`, `README.md`. Verified against PostgreSQL 18.

## The non-negotiable

> A player can **never** set their own points, change a pick after lock, pick a horse that isn't in the card, or peek at a result early.

## The four-layer integrity model  🟦 ENGINE

Scores are protected by four independent walls. An attacker must beat **all four**, and the inner walls don't depend on app code being correct.

1. **Constraints** — data cannot be malformed.
   - `daily_scores` has `CHECK (total_pts = base_pts + fav_bonus_pts + streak_bonus_pts)` — a forged/partial score row won't commit.
   - `picks.runner_id` FK to `runners` — a pick is always a declared horse.
   - One favourite per race (partial unique index); one runner per finishing position; one pick per player per day.
2. **Triggers** — `validate_pick()` runs on every pick insert/update and rejects it unless: the writer is the pick owner, an active league member, the runner races on that `pick_date`, the runner isn't a non-runner, and `now() < pick_lock_at(date)`. A second trigger blocks deleting a pick after lock (no dodging a 0).
3. **The engine recomputes everything** — `score_pick()` reads odds, favourite flag and finishing position **only from authoritative tables**, never trusting the client or the pick's odds snapshot (that's audit-only). Implements the locked v2 model.
4. **Row-Level Security** — clients (`authenticated`) may write **only** their own picks, chat, reactions, mutes/reports, and league self-join/leave. They have **no write path** to `daily_scores`, `standings`, `race_results`, `runners`, `races` or H2H outcomes. Scoring/settlement functions have `EXECUTE` revoked from `PUBLIC`/clients and granted only to `service_role`. A critical extra step revokes the PUBLIC function-inheritance hole (`alter default privileges … revoke execute on functions from public`).

### Who writes what

| Data | Client (`authenticated`) | Backend (`service_role`) |
|---|---|---|
| Own pick (before lock) | ✅ insert/update | ✅ |
| Chat / reactions / reports / mutes | ✅ own rows | ✅ |
| Join/leave a league | ✅ self | ✅ |
| Racing data (festivals, meetings, races, runners) | ❌ read-only | ✅ ingest |
| Race results | ❌ (read only after `status='resulted'`) | ✅ ingest |
| Scores, standings | ❌ read-only | ✅ engine only |
| H2H outcome / season record | ❌ (create/respond only) | ✅ `settle_challenge()` |

### Verified: 7 tamper tests, all BLOCKED

forge a score · set own standings/rank · forge a race result · call the scoring engine directly · pick a horse running on a different day · pick after lock · pick as another user — **all rejected** (RLS, execute-revoke, or the validate_pick trigger). Re-verified after the tie-break migration with no regression.

## Schema map  🟥 PACK tables / 🟦 engine tables noted

- **profiles** 🟦 — extends `auth.users`; UKGC compliance flags (`age_verified`, `kyc_status`, `country`) written only by trusted server functions.
- **festivals → meetings → races → runners** 🟥 — racing data; fractional SP (num/den) with a generated decimal-odds column; one-favourite-per-race index.
- **leagues** 🟦 — `mode` enum (day/festival/season) with window CHECKs; `name` (required); `max_runners` default 10, partner-configurable (CHECK 2–100, see migration 09). Each league has its own per-league leaderboard (`standings` keyed by `league_id`).
- **league_members** 🟦, **picks** 🟦 (unique league/profile/pick_date, FK to runner).
- **race_results** 🟥 (unique race/finish_pos).
- **daily_scores** 🟦 — the v2 breakdown with the total = base+fav+streak CHECK.
- **standings** 🟦 — totals, rank + tie-break columns (`best_day_pts`, `longest_streak`, `no_picks`, `reached_total_at`).
- **h2h_challenges** 🟦 (NO stake column — pride only), **h2h_records** 🟦 (canonical profile_a < profile_b).
- **chat_messages / message_reports / user_mutes / pick_reactions** 🟦 — social.

## Key engine functions  ⬜

- `pick_lock_at(date)` — least of 12:30 local / 30-min-before-first-race. 🟥 (racing times) — other packs override.
- `validate_pick()` / `block_locked_pick_delete` / `enforce_league_cap` 🟦.
- `score_pick(pick_id, streak_day)` — the v2 each-way scorer. 🟦 shape, 🟥 racing field reads.
- `run_daily_scoring(league_id, date)` — daily batch: computes streak day, scores or writes a `no_pick` zero, upserts `daily_scores`, refreshes standings. 🟦.
- `refresh_standings(league_id)` — totals + the full tie-break ranking (see `04_tiebreaks.md`). 🟦.
- `settle_challenge()` — writes H2H outcomes. 🟦.
- `orchestrate_tick(lookback_days, today)` — the **single scheduled entry point** (see Scheduling below). 🟦.
- `handle_new_user()` — auth.users trigger creating a profile. 🟦.

## Scheduling & orchestration  🟦

The game advances itself, but **never on a wall clock** — it gates on resulted racing. Migration `05_orchestration.sql` adds:

- **Readiness gates** — `day_is_resulted(date)` and `league_day_is_resulted(league, date)` are TRUE only when every relevant race is `resulted`/`void` (festival leagues gate on their festival's meetings; day/season gate globally). `day_is_scored(league, date)` is TRUE once every active member has a score row.
- **Three orchestrator RPCs** — `score_ready_days(lookback, today)` scores each live (league, day) whose racing is resulted and isn't already scored; `settle_due_challenges(today)` settles every closed-and-resulted H2H challenge; and **`orchestrate_tick(lookback_days, today)`** runs both and returns a JSON summary `{days_scored, days_errored, challenges_settled, challenges_errored}`.
- **`scoring_runs` audit log** — one row per unit (`status` = `ok`/`skipped`/`error`), service_role-only.

`orchestrate_tick` is **idempotent** — it skips already-scored days and already-settled challenges — so it's safe to call as often as you like. **You schedule frequently; the engine decides what's actually ready.** That removes both the "scored too early" risk and any double-scoring risk.

**Pick one scheduler** (runbook: `scorebox-schema/scheduler/README.md`):

| Option | When | How |
|---|---|---|
| Supabase **pg_cron** (recommended) | Default — service-role key stays in Postgres, no extra host | `cron.schedule('scorebox-orchestrate-pm','*/30 14-23 * * *', $$ select public.orchestrate_tick(3,null); $$)` |
| **Edge Function** + external cron | Want HTTP visibility/alerting | `supabase/functions/orchestrate/index.ts`, protected by `ORCHESTRATE_SECRET` |
| **Node** fallback (Render/local) | Prefer Render Cron / crontab / Actions | `scheduler/orchestrate.mjs` (zero deps, EDGE or DIRECT mode) |

Tunables: `lookback_days` (default 3 — re-checks for late result corrections) and `today` (default UTC now — pin for backfills). Schedules are UTC; UK is UTC+1 in summer.

## Validation pattern (for engineering)

Apply `01 → 02 → 03 → 04 → 05` to a clean Postgres 18 instance (with the local `auth` stub for standalone testing; in Supabase the `auth` schema and the roles already exist). Seed the real Ascot demo data, run the scoring engine across win/place/fav/miss/no-pick + streak scenarios, then run the 7 tamper tests and the tie-break scenarios. For orchestration, verify the readiness gates (resulted day = ready, day with a scheduled race = not ready, no-racing day = not ready), that a tick scores the ready day and settles the closed challenge, that a second tick is a clean no-op, and that a day scores only once its last race is resulted. All must pass.

## 🟦 Sport-pack note

For a new sport, only the **PACK** tables change: `festivals→meetings→races→runners` becomes the sport's field/fixtures structure, `race_results` becomes that sport's result table, and `pick_lock_at` + `score_pick`'s field reads adapt. The four-layer integrity model, `daily_scores`/`standings`, tie-breaks, H2H, chat, **the entire scheduling/orchestration layer** (it gates on "are this day's events resulted?", not on racing specifics) and the service_role-only write discipline are inherited unchanged.
