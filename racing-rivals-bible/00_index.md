# Racing Rivals — Game Bible

**The canonical reference for Racing Rivals and the reusable ScoreBox Pick Engine.**
This is the single source of truth. When a decision changes, it changes here first; specs, prototypes and schema follow.

_Owner: Roger Marris / ScoreBox · Last updated: 2026-06-30_

---

## How to read this Bible

Every section is tagged so a future sport (Football, NFL, Formula One) can be built by cloning the **ENGINE** parts and only re-authoring the **PACK** parts:

- 🟦 **ENGINE** — sport-agnostic. Shared infrastructure that every sport pack inherits unchanged (scoring shape, leagues, durations, rivalry, brand, integrity model).
- 🟥 **PACK** — racing-specific. The "Racing Rivals" sport pack: the field, the pick, the price source, the result grading, racing demo data.
- ⬜ **MIXED** — mostly engine, with clearly-marked racing specifics inside.

A new sport pack = fill in the four adapter slots (Field / Pick / Price / Result) and re-skin the accent imagery. Nothing else should need rewriting. See `09_multisport_engine.md`.

---

## Section map

| # | File | Tag | What it covers |
|---|------|-----|----------------|
| 0 | `00_index.md` | — | This index + glossary + change log |
| 1 | `01_vision_and_principles.md` | 🟦 ENGINE | What the game is, who it's for, design principles, working method |
| 2 | `02_core_game_model.md` | ⬜ MIXED | The daily-pick loop, leagues, runners, cumulative standings |
| 3 | `03_scoring_model.md` | ⬜ MIXED | **Locked scoring v2** — base, each-way, beat-the-favourite, streak, with worked examples |
| 4 | `04_tiebreaks.md` | 🟦 ENGINE | The standings tie-break ladder (always a strict winner) |
| 5 | `05_duration_modes.md` | 🟦 ENGINE | Day / Festival / Season modes |
| 6 | `06_rivalry_and_social.md` | 🟦 ENGINE | Pride-only H2H, season arc, chat, win cards, reactions |
| 7 | `07_app_structure_and_screens.md` | ⬜ MIXED | 4-tab shell, pick timing, screen-by-screen behaviour |
| 8 | `08_data_and_integrity.md` | ⬜ MIXED | Supabase schema, 4-layer integrity, scoring engine, RLS |
| 9 | `09_multisport_engine.md` | 🟦 ENGINE | The four adapter slots + Football / NFL / F1 mappings |
| 10 | `10_brand_and_visual_system.md` | 🟦 ENGINE | Editorial brand, colour tokens, type, motion philosophy |
| 11 | `11_compliance_and_open_items.md` | ⬜ MIXED | UKGC readiness, open questions, roadmap of remaining phases |
| 12 | `12_demo_data.md` | 🟥 PACK | The real Royal Ascot demo data used across all prototypes |

---

## Glossary (canonical terms — use these exactly)

| Term | Meaning |
|------|---------|
| **Runner** | A *player* in a league (NOT a horse). A league holds 20 runners. |
| **League** | A competition instance of up to 20 runners over a bounded run. |
| **Field** | The set of options a runner picks ONE from each round (in racing: every horse running that day). |
| **Pick** | A runner's single daily selection, of kind `win` or `place`. |
| **Win base** | The fractional-odds number itself (9/1 → 9, 7/2 → 3.5, evens → 1). |
| **Place base** | Half the win base (×0.5). |
| **Beat-the-favourite** | +2 flat bonus, **win only**, when the pick was not the market favourite. |
| **Win streak** | +1 per consecutive winning day from day 2; wins only; no cap. |
| **Mode** | The run length: `day` / `festival` / `season`. |
| **Standing** | A runner's cumulative points + rank within a league. |
| **H2H** | Head-to-head rivalry record between two runners — **pride only, no stake**. |
| **Sport pack** | A set of four adapter slots (Field/Pick/Price/Result) that re-skins the engine for a sport. |
| **ENGINE / PACK** | Sport-agnostic shared layer / sport-specific layer (see tagging above). |

---

## Source artifacts this Bible consolidates

- `racing-rivals-decision-log.md` — the living Q&A decision log (the primary source).
- `racing-rivals-phase1/2/4/5-spec.md`, `racing-rivals-phase-modes-spec.md` — phase specs.
- `scorebox-multisport-engine-strategy.md` — the multi-sport memo.
- `scorebox-schema/` — `01_schema.sql`, `02_functions_triggers.sql`, `03_rls_policies.sql`, `04_tiebreaks.sql`, `README.md`.
- Prototypes in `racing-rivals/` — `today/results/leaderboard/racecard/result-reveal/rivalry/modes/demo.html`.

---

## Change log

| Date | Change | Where |
|------|--------|-------|
| 2026-06-30 | Bible created — consolidates all phases 0–5, scoring v2, modes, multi-sport, schema, tie-breaks | all sections |
| 2026-06-30 | Scoring v2 locked (fractional base + each-way consolation + win-only fav-beater + flat streak) | `03_scoring_model.md` |
| 2026-06-30 | Tie-break ladder locked + verified in Postgres | `04_tiebreaks.md` |
| 2026-06-30 | Duration modes locked (Festival default, Day = coming soon) | `05_duration_modes.md` |
| 2026-06-30 | Production Supabase schema + 4-layer integrity model verified | `08_data_and_integrity.md` |

> **Maintenance rule:** add a row here every time a decision changes, and update the affected section. The decision log records *why*; the Bible records *what is true now*.
