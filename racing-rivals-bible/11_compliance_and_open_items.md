# 11 · Compliance & Open Items  ⬜ MIXED

## Compliance posture (UKGC readiness)  🟦 ENGINE

- **Pride only, no stake — today.** There is **no stake column anywhere** in the schema. H2H and leagues are bragging-rights only. This is the deliberate choice that keeps the current product clean of real-money gambling regulation.
- **Designed RG-ready.** The product carries responsible-gambling slots (age-gate, RG messaging) so a UKGC real-money model can drop in **without a rebuild**.
- **Compliance flags exist but are server-only.** `profiles` carries `age_verified`, `kyc_status`, `country`, written only by trusted server functions — a client can never self-elevate these.
- **When monetisation lands**, real-money tables (licensing, KYC gating, payment records) attach there and must be `service_role`-write only, same discipline as scores.

> ⚠️ **P0 LIVE RISK — the real launch gate:** the **final regulatory model is UNDETERMINED** (free-to-play vs UKGC real-money vs skill-game). This materially affects onboarding and pick screens. Designing RG-ready mitigates it, but it must be resolved before a real-money launch. **This is the single biggest open item.**

> Per-sport note: each sport's "pick + odds" framing must clear the same UKGC line. Pride-only/no-stake keeps it clean, but odds-derived scoring needs the same legal read for every new sport pack.

## "Is it ready to go live?" — current status

The **design and data foundations are complete and verified**: scoring v2, tie-breaks, duration modes, rivalry/social, the 4-tab shell, and a production-ready Supabase schema with a verified 4-layer integrity model. **The gating blocker is regulatory (above), plus the build-phase items below.** It is not yet a shipped product — it's an engineering-ready blueprint plus visual prototypes.

## Build-phase items (engineering, post-design)

- **Data ingest service** — writes `runners` (SP + favourite flag) and `race_results` from a chosen racing feed. The production feed today is **form + odds only**; richer racecard fields (jockey/trainer, course/dist stats, suitability, written insight) are placeholder/SRC? until a richer feed is licensed.
- **Scheduling** — a cron/edge function calls `run_daily_scoring` per league once races are resulted, and `settle_challenge` when a challenge window closes.
- **Realtime** — enable Supabase Realtime on `daily_scores`, `standings`, `chat_messages` for live leaderboards/chat.
- **Profanity filter** — app/edge-function layer (DB stores `is_hidden` + `message_reports` for soft-moderation).
- **Port prototype scoring** — the prototypes' client-side `score()` used a simpler win-or-place model; if that JS is ever ported, apply the each-way rule from `03_scoring_model.md`.

## Remaining design phases (deferred)

| Phase | Scope | Status |
|-------|-------|--------|
| Phase 6 — Scoring transparency | The "maths is always open" surfaces | Largely **done** via the Results explainer |
| Phase 7 — Auto-Pick AI | Opt-in auto-pick; personality/confidence/trust | **Minimal** for now; revisit later |
| Phase 9 — Monetisation | Multiple price points (e.g. £2 / £5 / £25 tables) | Deferred; gated on compliance |
| Phase 10 — Mobile + notifications | Native/PWA polish, push | Deferred |
| Value Flag | A value indicator on the racecard/Today screen | **Deferred** — reserved slot, define later |

## Open questions carried forward

- Exact regulatory model (the P0 gate above).
- Racing data feed decision (determines which SRC? fields go live).
- League formation/membership rules (how runners are grouped into leagues).
- Whether to add friends/global leaderboard tabs beyond per-league.
- Multi-sport open questions (player vs team pick default, umbrella vs per-sport brand, cross-sport leagues, per-sport odds licensing) — see `09_multisport_engine.md`.
