# 09 · Multi-Sport Engine  🟦 ENGINE

This is the heart of why the Bible exists: Racing Rivals is the **first skin on a reusable ScoreBox Pick Engine.** A new sport = fill four adapter slots + re-skin. Everything else is inherited.

Full memo: `scorebox-multisport-engine-strategy.md`.

## The four adapter slots

The engine stays fixed. A "sport pack" fills in four slots:

| Slot | Definition | Racing | Football | NFL | Formula One |
|------|------------|--------|----------|-----|-------------|
| **1. FIELD** | The set a player picks ONE from, per round | Horses running that day (all meetings) | Players/teams in the matchday | Teams/players in the week's games | Drivers in the race weekend (~20) |
| **2. PICK** | The single selection + the event it resolves on | One horse to win/place | One outcome (player to score, team to win) | One outcome (team ATS, player TD) | One driver to out-perform |
| **3. PRICE** | The odds/probability driving the value curve | SP fractional odds | Match / scorer odds | Spread-implied or moneyline odds | Driver podium/win odds |
| **4. RESULT** | What "success" means + how it's graded | Win / Place | Scored / Won | Covered / TD / Won | Won / Podium |

**Everything else is shared infrastructure inherited unchanged:** scoring v2, streaks, beat-the-favourite, 20-runner leagues, Day/Festival/Season durations, tie-breaks, rivalry, chat, win cards, the editorial brand, and the four-layer integrity model.

## What every sport pack inherits (the ENGINE checklist)

- [ ] Scoring shape: base-from-price, ×0.5 partial credit, +2 win-only beat-the-favourite, +1/round streak, 0 on failure (`03_scoring_model.md`).
- [ ] 20-runner leagues + cumulative standings + the tie-break ladder (`04_tiebreaks.md`).
- [ ] Day / Event / Season duration modes (`05_duration_modes.md`).
- [ ] Pride-only H2H, chat, reactions, win cards (`06_rivalry_and_social.md`).
- [ ] The four-layer integrity model + service_role-only writes (`08_data_and_integrity.md`).
- [ ] The editorial brand system (`10_brand_and_visual_system.md`).

## What a sport pack must author (the PACK checklist)

- [ ] Define the four adapter slots (Field / Pick / Price / Result) above.
- [ ] Source the price/odds feed and the result feed.
- [ ] Set the pick window + lock rule (the sport's `pick_lock_at`).
- [ ] Define the partial-credit ("place") tier for the sport.
- [ ] Map PACK tables (fixtures, results) onto the schema.
- [ ] **Re-run the Monte-Carlo stress-test** (see guard below) and tune constants if needed.
- [ ] Re-skin accent imagery (NOT the design language).

## ⚠️ Standing requirement: the stress-test guard

Every new sport pack **must** be Monte-Carlo stress-tested the same way racing was: confirm **no single strategy dominates** and that **beat-the-favourite stays success-only** (never on partial credit) — otherwise it becomes regressive and gameable. This is a permanent gate, not a one-off. (The racing test ran 50,000 weeks and flattened the best/worst strategy spread from 2.89× to 1.89× by making the bonus win-only.)

## Sport mappings (summary)

### Football / Soccer — working name *Match Rivals*
- **Round** = matchday/gameweek (Festival ≈ a tournament). **Pick** = "one player to score today" (cleanest analogue to "one horse to win" — fat longshot tail). Alt: "one team to win." **Price** = anytime-scorer or match-result odds. **Result** = Scored (full) / assist-or-woodwork (optional ×0.5) / nothing = 0. **Fav-beater** = scorer who wasn't shortest-priced. **Watch-outs:** huge field needs curation; postponements/VAR grading.

### NFL — working name *Gridiron Rivals*
- **Round** = an NFL week. **Pick** = team to cover the spread (spread = built-in handicap) or player to score a TD. **Price** = spread-implied or anytime-TD odds. **Result** = Covered / TD (full); straight-up win as a possible bonus/partial; loss = 0. **Fav-beater** = the underdog / non-favourite scorer. **Watch-outs:** byes + short 18-week season change streak dynamics; spread data licensing.

### Formula One — working name *Grid Rivals*
- **Round** = a race weekend (~24/season; Festival ≈ one GP weekend). **Field** = ~20 drivers (mirrors the 20-runner league). **Pick** = driver to Win (full) / Podium (×0.5), or a "beat-your-driver vs expected position" variant. **Price** = driver win/podium odds. **Fav-beater** = a non-favourite driver. **Watch-outs:** only ~24 rounds → streaks rarer (may want a different streak constant); DNFs/grid penalties complicate "expected position" grading.

## Cross-sport product structure

- **One ScoreBox account, many sport packs** — run an Ascot festival league, a Premier League matchday league and an F1 season league in parallel, same identity.
- **Shared meta-layer** — Season arc, H2H record, win cards, chat work across every sport with zero rework.
- **Brand scales** — the editorial masthead/stamp/type kit is sport-neutral; each pack re-skins accent imagery only.

## Recommended sequencing (for discussion — not committed)

1. **Harden racing** (current) so the abstraction is proven on real data and the stress-test methodology is repeatable.
2. **Extract the four adapter slots** into a documented sport-pack interface.
3. **Formula One first** — smallest field, ~20 drivers already, clean win/podium grading, lowest data-curation cost.
4. **NFL second** — weekly cadence + existing pick'em culture; spread = built-in handicap.
5. **Football last of these three** — biggest audience but heaviest curation/grading.

## Open questions (for a later session)

- Player-pick vs team-pick as the per-sport default (affects odds sourcing + "longshot" feel).
- One umbrella brand vs distinct app identities per sport.
- Whether cross-sport leagues (mixing sports week-to-week) are desirable or a distraction.
- Compliance: each sport's "pick + odds" framing must clear the same UKGC line — pride-only/no-stake keeps it clean, but odds-derived scoring needs the same legal read per sport.
- Data/odds licensing cost per sport (the real gating factor on sequencing).
