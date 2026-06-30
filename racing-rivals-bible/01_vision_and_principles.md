# 01 · Vision & Principles  🟦 ENGINE

## What the game is (one paragraph, sport-agnostic)

> Each round, every player makes **one pick** from a **priced field**. Picks are scored on an **odds-weighted value curve**, with a **beat-the-favourite** bonus and a **consecutive-success streak** bonus. Players compete in fixed-size leagues (**20 runners**) over a bounded run — a **Day**, a **Festival/Event**, or a whole **Season** — for points, standings, **pride-only** head-to-head rivalry and bragging rights.

Every word of that is sport-agnostic. Racing Rivals is the first skin on this engine. (See `09_multisport_engine.md`.)

## Who it's for  🟥 PACK detail inside

- **Audience:** a deliberate blend — accessible enough for casual fans, deep enough for experienced punters. Design **tiered complexity**: a beginner can pick on vibes; an expert can read form, odds and value.
- **First-session goal:** *spectator-first*. A new user should be able to **browse and be convinced** before committing — free demo experience, then a conversion pitch once hooked.
- **Conversion moment:** after the full demo cycle completes → pitch joining the real run.

## Design principles (the non-negotiables)

1. **The maths is always open.** Every score on screen shows an itemised breakdown — base + each bonus + day total. No hidden multipliers. This was a direct response to "where do the bonus points come from?" — never leave that unanswered.
2. **No dominant strategy.** The scoring must be stress-tested so no single approach (e.g. always backing second-favourites) dominates. Beat-the-favourite is **success-only** to keep it from becoming regressive/gameable. This is a *standing requirement*, re-run for every sport pack.
3. **High-stakes but calm.** Urgency comes from clear copy and a countdown, not alarmist animation. Deadlines change colour; they don't shout. "Minimal" beats "dramatic."
4. **Server is the source of truth.** Scores, results and standings are computed server-side from authoritative data and can never be set by a client. (See `08_data_and_integrity.md`.)
5. **Editorial, not neon.** The brand is newspaper/print editorial — paper, ink, a single stamp-red accent — NOT a neon sportsbook. Energy comes from typography and the red stamp, not gradients. (See `10_brand_and_visual_system.md`.)
6. **Pride, not stake (for now).** H2H and leagues are pride-only; there is no stake anywhere in the model until a deliberate, compliant monetisation phase. (See `11_compliance_and_open_items.md`.)
7. **Reuse before rebuild.** Use existing code and the shared engine wherever possible; a new sport is a config + feed, not a rewrite.

## Working method (how decisions get made & recorded)

- **Specs + visual prototypes first**, reviewed before production code.
- **Batched Q&A** is fine (not strict one-at-a-time), but: ask before acting on anything ambiguous, confirm understanding of the existing product before changing it, and **flag conflicts immediately** against the decision log.
- **One phase at a time**, phase-gated — each phase ends by asking whether to revisit before moving on.
- **No aesthetic defaults** — visual choices are deliberate and brand-driven, never arbitrary.
- **The decision log** (`racing-rivals-decision-log.md`) records every Q&A and *why*; **this Bible** records *what is true now*.

## Tech posture (current)  🟥 PACK

- Prototypes: self-contained HTML/CSS/vanilla JS, no framework/build step, deployed on Vercel; custom domain `racing-rivals.scorebox.games`.
- Production data layer: **Supabase (Postgres + RLS)**. Server-side scoring engine in PL/pgSQL. (See `08_data_and_integrity.md`.)
- Repo: `RogerRedhackle/racing-rivals` (public), PRs with Vercel preview deploys. Cursor reserved for optional local review.
