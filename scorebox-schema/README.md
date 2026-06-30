# ScoreBox — Production Database Blueprint (Supabase / PostgreSQL)

**Version 1.0 · 30 Jun 2026 · verified against PostgreSQL 18**

This is the engineering-ready data model for ScoreBox / Racing Rivals. It implements the locked **v2 scoring model** and is built around one non-negotiable: **server-side scoring integrity** — a player can never set their own points, change a pick after lock, pick a horse that isn't in the card, or peek at a result early.

## Files (apply in order)
| # | File | What it does |
|---|---|---|
| 1 | `01_schema.sql` | All tables, enums, constraints, indexes |
| 2 | `02_functions_triggers.sql` | Pick-lock + validation triggers, the v2 scoring engine, daily scoring pass, H2H settlement, new-user hook |
| 3 | `03_rls_policies.sql` | Base grants + Row-Level Security + function-execute lockdown |
| 4 | `04_tiebreaks.sql` | Strict tie-break ladder + `h2h_edge()` + extra `standings` columns |
| 5 | `05_orchestration.sql` | Readiness-gating helpers, the three orchestrator RPCs (`score_ready_days`, `settle_due_challenges`, `orchestrate_tick`), the `scoring_runs` audit log, and the optional pg_cron schedule |

The scheduling layer that drives migration 05 lives in `scheduler/` (Edge Function, Node fallback, and full runbook) — see **Scheduling & orchestration** below.

In a fresh Supabase project: paste each file into the SQL editor in order (the `auth` schema and roles `anon` / `authenticated` / `service_role` already exist there — the local stub in this folder is only for standalone testing).

---

## The four-layer integrity model

Scores are protected by four independent walls. An attacker has to beat **all four**, and the inner walls don't depend on app code being correct.

1. **Constraints** — data simply cannot be malformed. Examples:
   - `daily_scores` has `CHECK (total_pts = base_pts + fav_bonus_pts + streak_bonus_pts)` — a forged or partial score row won't commit.
   - `picks.runner_id` is a foreign key to `runners`, so a pick is *always* a declared horse.
   - One favourite per race (partial unique index); one runner per finishing position (`unique (race_id, finish_pos)`); one pick per player per day (`unique (league_id, profile_id, pick_date)`).
2. **Triggers** — `validate_pick()` runs on every pick insert/update and rejects it unless: the writer is the pick owner, an active league member, the runner races **on that pick_date**, the runner isn't a non-runner, and **`now() < pick_lock_at(date)`**. A second trigger blocks deleting a pick after lock (no dodging a 0).
3. **The scoring engine recomputes everything** — `score_pick()` reads odds, favourite flag and finishing position **only from the authoritative tables**. It never trusts the odds snapshot stored on the pick (that's audit-only). Beat-the-favourite is **+2 flat, WIN ONLY, non-favourite**; streak is **+1/day from day 2, wins only**; place pays **half**, no bonuses. No cap.
4. **Row-Level Security** — clients (`authenticated`) may write **only their own picks, chat, reactions, mutes/reports, and league self-join/leave**. They have **no write path at all** to `daily_scores`, `standings`, `race_results`, `runners`, `races` or H2H outcomes. The scoring/settlement functions have `EXECUTE` revoked from `PUBLIC`/clients and granted only to `service_role` (your backend). `service_role` bypasses RLS and is the single trusted writer for racing data + scores.

### Who writes what (summary)
| Data | Client (`authenticated`) | Backend (`service_role`) |
|---|---|---|
| Own pick (before lock) | ✅ insert/update | ✅ |
| Chat / reactions / reports / mutes | ✅ own rows | ✅ |
| Join/leave a league | ✅ self | ✅ |
| Racing data (festivals, meetings, races, runners) | ❌ read-only | ✅ ingest |
| Race results | ❌ (read only after `status='resulted'`) | ✅ ingest |
| Scores, standings | ❌ read-only | ✅ engine only |
| H2H challenge outcome / season record | ❌ (can create/respond only) | ✅ `settle_challenge()` |

---

## The v2 scoring engine (verified)

`run_daily_scoring(league_id, date)` is the daily batch the backend calls once a competition day's races are resulted. For each active member it computes the streak day, scores the pick (or writes a `no_pick` zero and resets the streak), upserts `daily_scores`, and refreshes `standings` (totals + ranks).

**Verified output** against the real Royal Hunt Cup (Ascot, 17 Jun 2026) data used across the prototypes:

| Player | Pick | Result | Points | Why |
|---|---|---|---|---|
| WIN on Indalo 9/1 (non-fav), streak day 2 | win | 1st | **12.0** | 9 base + 2 fav-beater + 1 streak |
| WIN on Indalo 9/1, only placed | win | 3rd | **4.5** | each-way consolation: 9 × 0.5, no bonuses, streak resets |
| PLACE on Indalo 9/1 | place | placed | **4.5** | 9 × 0.5; no fav/streak on a place |
| WIN on Archivist 5/1 (favourite) | win | 1st | **5.0** | base only — no +2 (it was the favourite) |
| WIN on a horse that finishes unplaced | win | 9th | **0.0** | miss |
| No pick | — | — | **0.0** | `no_pick`, streak resets |

These match the locked figures exactly. All seven tampering attempts (forge score, set standings, forge result, call engine directly, cross-day pick, post-lock pick, pick-as-another-user) were **blocked** in testing.

> **Pick-kind semantics (each-way model — confirmed 30 Jun 2026):** a `win` selection pays the **full** win-base + fav-beater + streak on a 1st, and a **half-base consolation** (no bonuses) if the horse only places — the streak still resets on a consolation because it is not a win. A `place` selection pays half-base on any placed finish, no bonuses. Bonuses (fav-beater, streak) are strictly **win-only** in both cases.

---

## Duration modes (Season / Festival / Day)

`leagues.mode` is the enum `('day','festival','season')`. The window is `starts_on`/`ends_on`:
- **day** — enforced single date (`CHECK starts_on = ends_on`).
- **festival** — requires a `festival_id`; runs the **real meeting length** (Ascot 5, Cheltenham 4, etc.) via the festival's dates. Nothing assumes 7 days.
- **season** — the campaign window; the H2H season record (`h2h_records`) and biggest-margin live here.

A player can be in a festival league **and** a season league at once — the same daily pick can feed multiple leagues (one `picks` row per league per day).

---

## Compliance hooks (UKGC readiness)
`profiles` carries `age_verified`, `kyc_status`, `country` — written only by trusted server functions, never the client (the `profiles_update_own` policy explicitly forbids self-elevating these). H2H is deliberately **pride-only**: there is **no stake column** anywhere. When the monetisation phase adds real-money tables, that's where licensing, KYC gating and payment records attach — and those tables must be `service_role`-write only, same pattern as scores.

---

## Standings tie-break ladder (migration 04 — confirmed 30 Jun 2026)

`refresh_standings` now produces a **strict 1..N order** with no unresolved ties. When `total_pts` are equal it walks this ladder (most → least meaningful):

| # | Tier | Rationale |
|---|------|-----------|
| 1 | **total_pts** | the primary score |
| 2 | **most wins** | actual winners beat accumulated places |
| 3 | **head-to-head** | if the tied players have a *settled* H2H, the H2H winner ranks higher (applied as a net edge among co-tied players via `h2h_edge()`) |
| 4 | **best single day** | highest one-day score in the run |
| 5 | **longest win streak** | longest run of consecutive winning days |
| 6 | **fewest no-picks / most days played** | rewards showing up |
| 7 | **earliest to reach the total** | `reached_total_at` — unique timestamp, the **final decider** that guarantees a strict order |

New `standings` columns back this: `best_day_pts`, `longest_streak`, `no_picks`, `reached_total_at`. Because tier 7 is always unique, the H2H tier (3) can never produce a contradictory cycle — a 3-way rock-paper-scissors H2H simply cancels to a net edge of 0 and falls through to the unique decider. **Verified** with constructed ties for every tier (wins break, H2H break, final-decider break, a strict 4-way, and a 3-way H2H cycle) — all resolved to distinct ranks 1..N.

## What's deliberately left for the build phase
- **Profanity filter** is an app/edge-function concern; the DB stores `is_hidden` for soft-moderation and `message_reports`.
- **Realtime**: enable Supabase Realtime on `daily_scores`, `standings`, `chat_messages` for live leaderboards/chat.
- **Scheduling**: ✅ **shipped** — see migration 05 + the `scheduler/` folder below. A single idempotent RPC, `orchestrate_tick`, scores days and settles challenges only once the racing is resulted; you point pg_cron (or an Edge Function / Node cron) at it.
- **Data ingest**: the service that writes `runners` (with SP + favourite flag) and `race_results` from your chosen racing feed.
- **Multi-sport**: the same engine generalises — a new sport pack swaps the "field / pick / price / result" tables; `score_pick` becomes the racing implementation of a shared interface (see the multi-sport strategy memo).

---

## Scheduling & orchestration (migration 05 + `scheduler/`)

The game advances itself through one idempotent RPC — **`orchestrate_tick(lookback_days, today)`** — which does two things every time it runs and is safe to call as often as you like:

1. **Score ready days.** For every *live* league across the last `lookback_days`, it checks `league_day_is_resulted(league, day)`. Only when that day's racing is fully `resulted`/`void` does it run `run_daily_scoring`. Days already scored are skipped.
2. **Settle due challenges.** For every `pending`/`active` H2H challenge whose window has closed *and* is fully resulted, it runs `settle_challenge`.

Every unit writes an audit row to `public.scoring_runs` (`status` = `ok`/`skipped`/`error`), and the tick returns a JSON summary `{days_scored, days_errored, challenges_settled, challenges_errored}`. **The engine never scores on a wall clock — it gates on resulted races.** This means there is no "too early" risk and no double-scoring: schedule frequently, the engine decides what's actually ready.

**Pick one scheduler** (full instructions in `scheduler/README.md`):

| Option | When to use | How |
|---|---|---|
| **Supabase pg_cron** (recommended) | Default. Service-role key never leaves Postgres; no extra host. | `cron.schedule('scorebox-orchestrate-pm', '*/30 14-23 * * *', $$ select public.orchestrate_tick(3, null); $$)` (block is in `05_orchestration.sql`). |
| **Edge Function + external cron** | You want HTTP-level visibility/alerting or to trigger from outside Supabase. | `supabase/functions/orchestrate/index.ts` wraps the RPC; protect with `ORCHESTRATE_SECRET`. |
| **Node fallback (Render/local)** | You'd rather schedule from Render Cron Jobs / crontab / GitHub Actions. | `scheduler/orchestrate.mjs` (zero deps, Node ≥ 18) in EDGE or DIRECT mode. |

Tunables: `lookback_days` (default 3 — days back to re-check for late result corrections) and `today` (default UTC now — pin for backfills). Schedules are **UTC**; UK is UTC+1 in summer.

**Verified** on PostgreSQL 18: gating returns correct ready/not-ready for a fully-resulted festival day, a day with a still-scheduled race, and a no-racing day; a tick scores the ready day and settles the closed H2H challenge (Alice 11 vs Bob 1 → Alice wins, season record updated, biggest_margin 10); a second tick is a clean no-op (idempotent); and once a previously-pending race is resulted, the next tick scores that day. Zero errors across the run.

---

## How this was validated
Applied all four migrations to a clean PostgreSQL 18 instance, seeded the real Ascot demo data, ran the scoring engine across multiple scenarios (win/place/fav/miss/no-pick + streak), and executed seven adversarial integrity tests simulating a malicious authenticated client. Migration 04 (tie-breaks) applies clean on top of 01–03; the tie-break ladder was verified against constructed tie scenarios (wins, head-to-head, the earliest-to-total final decider, a strict 4-way, and a 3-way H2H cycle), all producing distinct ranks; the seven integrity tests still pass with no regression. Schema applies clean; scoring matches the locked v2 numbers; every tampering vector is rejected.
