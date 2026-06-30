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
- **leagues** 🟦 — `mode` enum (day/festival/season) with window CHECKs; `max_runners` default 20.
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
- `handle_new_user()` — auth.users trigger creating a profile. 🟦.

## Validation pattern (for engineering)

Apply `01 → 02 → 03 → 04` to a clean Postgres 18 instance (with the local `auth` stub for standalone testing; in Supabase the `auth` schema and the roles already exist). Seed the real Ascot demo data, run the scoring engine across win/place/fav/miss/no-pick + streak scenarios, then run the 7 tamper tests and the tie-break scenarios. All must pass.

## 🟦 Sport-pack note

For a new sport, only the **PACK** tables change: `festivals→meetings→races→runners` becomes the sport's field/fixtures structure, `race_results` becomes that sport's result table, and `pick_lock_at` + `score_pick`'s field reads adapt. The four-layer integrity model, `daily_scores`/`standings`, tie-breaks, H2H, chat and the service_role-only write discipline are inherited unchanged.
