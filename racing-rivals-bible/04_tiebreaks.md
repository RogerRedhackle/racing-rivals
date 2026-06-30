# 04 · Standings Tie-Break Ladder  🟦 ENGINE

Locked & verified 30 Jun 2026. Produces a **strict 1..N order** — there is always a single winner, never a shared rank.

## The ladder

When `total_pts` are equal, resolve in this order (most → least meaningful):

| # | Tier | Rationale |
|---|------|-----------|
| 1 | **total_pts** | the primary score |
| 2 | **most wins** | actual winners beat accumulated places |
| 3 | **head-to-head** | if the tied runners have a *settled* H2H, the H2H winner ranks higher (applied as a net edge among co-tied runners) |
| 4 | **best single day** (`best_day_pts`) | highest one-day score in the run |
| 5 | **longest win streak** (`longest_streak`) | rewards form |
| 6 | **fewest no-picks / most days played** | rewards showing up |
| 7 | **earliest to reach the total** (`reached_total_at`) | unique timestamp — the **final decider** |
| — | profile_id | absolute last resort; never hit in practice |

## Why it always resolves (the "always a winner" guarantee)

Tier 7, `reached_total_at`, is a **strictly-unique timestamp** (the moment a runner's cumulative total was last changed by a points-adding day). Because no two runners share it, the full ORDER BY is always a **total order** → ranks come out a clean 1, 2, 3, 4… even in a genuine dead-heat on every earned metric. This satisfies the "find me a tiebreaker rule / there must always be a winner" requirement.

## Why head-to-head can't break it (acyclicity)

H2H sits at tier 3 as a **net edge** among the runners a player is tied with on (points, wins) — not as a fragile pairwise sort. A 3-way rock-paper-scissors H2H (A beat B, B beat C, C beat A) cancels to a net edge of **0** for everyone and harmlessly falls through to the unique decider. No contradictory cycle, no instability. **Verified** with a constructed 3-way cycle → still produced distinct ranks.

## Schema backing  ⬜ (engine concept, Postgres implementation)

Migration `04_tiebreaks.sql`:
- Adds `standings` columns: `best_day_pts`, `longest_streak`, `no_picks`, `reached_total_at`.
- Adds `h2h_edge(league, a, b)` — a read-only helper returning +1 / −1 / 0 for the pairwise H2H tier.
- Rewrites `refresh_standings(league)` to compute all stats and rank with the full ladder.
- Execute on `refresh_standings` stays **service_role-only** (revoked from public/anon/authenticated); `h2h_edge` is a harmless read-only helper granted to authenticated + service_role.

## Verification (Postgres)

Applied clean on top of migrations 01–03. Constructed tie scenarios for every tier — a wins break, an equal-points-and-wins break decided by H2H, the earliest-to-total final decider, a strict 4-way, and a 3-way H2H cycle — **all resolved to distinct ranks 1..N.** The live scoring pass populates every new column, and the 7 integrity tamper tests still pass with no regression.

## 🟦 Sport-pack note

This ladder is fully engine-level and inherited unchanged by every sport. The only sport-specific input is what counts as a "win" (tier 2) — defined by the pack's Result adapter (see `09_multisport_engine.md`).
