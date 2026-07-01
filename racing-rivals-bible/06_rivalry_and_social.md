# 06 · Rivalry & Social  🟦 ENGINE

All of this is engine-level and inherited by every sport with zero rework — a win card just swaps "Indalo 9/1" for "Haaland 6/4" or "Verstappen — podium from P5."

## Head-to-head (H2H) — pride only

- A **persistent rivalry record** between two runners: cumulative H2H, biggest winning margin, season-long arc.
- **Pride only. No stake.** There is **no stake column anywhere** in the schema. This is a deliberate compliance choice (see `11_compliance_and_open_items.md`).
- H2H records are **canonical** (`profile_a < profile_b`, one row per pair) and **engine-written** on challenge settlement — never set by a client.
- H2H feeds the standings tie-break (tier 3) — see `04_tiebreaks.md`.

## Rivalry features (confirmed scope)

1. **Reveal rival picks post-deadline** — an avatar badge on the chosen runner on the racecard ("Priya picked this"). This is the head-to-head drama surface. (The League leaderboard stays points-only — two different surfaces, both retained.)
2. **Invite a friend to your table** — shareable invite link / code.
3. **Season-long rivalry arc** — cumulative H2H, biggest margin, persistent stats living in Season mode.

## League chat

- **Scope:** league chat among the runners in a league (10 by default, partner-configurable).
- **Moderation:** profanity filter (app/edge-function concern; the DB stores `is_hidden` for soft-moderation), plus **report** and **mute**. `message_reports` and `user_mutes` tables exist.
- Chat is **not scoring-critical** — it's social colour.

## Reactions & win cards

- **Pick reactions** — runners can react to picks (`pick_reactions`).
- **Win card** — a shareable celebration card for a notable result (the win, the odds, the moment). Engine-level; sport-neutral.

## The 4-tab placement  🟦

In the app shell (see `07_app_structure_and_screens.md`), **Chat** is its own tab and **Rivalry** is a sub-view under **League**. The win card surfaces from the result reveal.

## Deliverables

`racing-rivals-phase5-spec.md` + `rivalry.html` (Rivals / Chat sub-tabs + win-card modal), tested light + dark.

## 🟦 Cross-sport note

One ScoreBox account runs many sport packs in parallel (a Royal Ascot festival league, a Premier League matchday league, an F1 season league) — same identity, same rivalry meta-layer, same win cards and chat, zero rework per sport.
