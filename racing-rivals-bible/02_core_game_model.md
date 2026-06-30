# 02 · Core Game Model  ⬜ MIXED

The fundamental loop. The *shape* is ENGINE; the racing nouns are PACK.

## The daily-pick loop  🟦 ENGINE shape / 🟥 PACK nouns

- **One pick per runner per round.** In racing, a round = a **day**, and the field = **every horse running that day** across all the day's meetings (a flat list; pick one). The pick is of kind `win` or `place`.
- **A pick every round.** Miss the deadline → score **0** for that round and **the streak resets** (see "No-pick rule").
- **Standing = cumulative total** across the run. Highest total at the end wins. (See `04_tiebreaks.md` for ties.)

> 🟥 **Racing specifics:** the field is drawn from all races across all meetings that day, not a single race. Royal Hunt Cup, for example, is *one race within one day*, not the whole game.

## Leagues & runners  🟦 ENGINE

- A **league** holds up to **20 runners** ("runner" = a *player*, never a horse).
- Multiple leagues can exist; a runner can be in several at once (e.g. a festival league *and* a season league simultaneously — the same daily pick can feed multiple leagues, one pick row per league per day).
- Standings are **per league**, ranked by cumulative points.

## Pick visibility  🟦 ENGINE

Two surfaces, two rules — both retained:

- **Leaderboard / League tab:** **points only.** It never reveals what anyone picked. (Tactical tension comes from the gap-to-leader nudge, not from seeing picks.)
- **Racecard (post-deadline):** rivals' picks **are** revealed as an avatar badge on the chosen runner ("Priya picked this") — this is the head-to-head drama surface.

## No-pick rule  🟦 ENGINE

- There is **no random auto-pick.** (An earlier random auto-assignment was explicitly removed.)
- If the deadline passes with no pick: that round **scores 0** and **any active streak resets**. Surfaced as a one-line warning on the unpicked screen.
- Optional **Auto-Pick AI** is a separate, opt-in feature (minimal for now; see `11_compliance_and_open_items.md`).

## Pick timing  🟦 ENGINE shape / 🟥 PACK times

- **Pick window opens:** 7:30am each morning (countdown to open shown before that).
- **Change-until deadline:** **12:30pm local OR 30 minutes before the first race, whichever is earlier.** A runner may freely change their pick until then.
- **Two daily states:** (1) *pre-open* — before 7:30am, locked, counting down to open; (2) *open* — window live, counting down to the change-deadline.

> 🟦 In the engine these are just `window_open` and `lock_at` timestamps. The racing values (7:30am open, 12:30pm / first-race-minus-30 lock) are the racing pack's configuration. Other sports set their own (e.g. NFL: lock at kickoff of the first game).

## Run length  🟦 ENGINE

- The run length is **variable** and set by the **mode** (`day` / `festival` / `season`). Nothing in the engine assumes a fixed number of days. (The original "7 days" was one example length; see `05_duration_modes.md`.)
- The streak bonus (+1/day, no cap) works for any length.
