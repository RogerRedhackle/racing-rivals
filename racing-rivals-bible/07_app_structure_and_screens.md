# 07 · App Structure & Screens  ⬜ MIXED

The 4-tab shell and screen behaviour. The shell is 🟦 ENGINE; racing copy/data is 🟥 PACK.

## The shell — 4 bottom-nav tabs

Decided to resolve "too much information on one page." Bottom-nav app, **four tabs**:

| Tab | Purpose |
|-----|---------|
| **Today** | Countdown to next pick + today's selection + change-until deadline. The home base. |
| **Results** | Day-by-day scoring breakdown — the "maths is always open" surface. **Built first** (it locks the points visual language). |
| **League** | The decluttered leaderboard (points-only, gap-to-leader nudge). Rivalry is a sub-view here. |
| **Chat** | League chat among the runners (10 by default, partner-configurable). |

## Today screen — pick submission

- **Flow:** *pick on Today, confirm in place.* Today shows your current pick or an empty slot. Tapping the empty slot opens the racecard to choose; the chosen runner then lives on Today with a **Change** action. Fewest screens.
- **Two states:** *pre-open* (before 7:30am, locked, counting to open) and *open* (window live, counting to the change-deadline — 12:30pm or first-race-minus-30, whichever is earlier).
- **Deadline treatment (minimal):** the countdown **changes colour only** as the deadline nears — no sticky bars, no motion, no drama. High-stakes but calm.
- **No-pick:** deadline passes with no pick → 0 for the day + streak resets, surfaced as a one-line warning. No random auto-pick.
- **Value Flag:** a reserved slot exists but it is **deferred** (define later) — no live Value Flag yet.

## Results screen — scoring transparency

- The day-by-day breakdown: each day shows base + fav-beater + streak = day total, plus the cumulative running total.
- Result states: **WIN** (1st), **PLACE** (paid place, not 1st), **MISS** (unplaced / no pick — clean zero with "streak resets").
- This screen's visual language is reused by the **result reveal** so history and live reveal look identical.

## League screen — leaderboard

- **Points only** — never reveals picks.
- **Row:** rank (number + medal for top 3) · runner · cumulative points · today's gain (+X, live as races settle).
- **Gap-to-leader nudge:** shows position, points off the lead, points behind the runner directly ahead, and a strategy hint ("a 5/1 winner overtakes them; an 18/1 winner tops the table"). Odds-to-close derived from the locked scoring model. Adapts when you're leading.
- **Floating "You" bar:** pinned summary of your row, shown only when your row scrolls out of view (IntersectionObserver); tap to jump back.
- **League switcher:** multiple leagues; a switcher shows the structure.

## Racecard screen  🟥 PACK

- **Compact list rows**, one per runner, built to scale to a 28-runner handicap. Collapsed row = silk · name (+country) · J/T · last-5 form dots · trend arrow · odds · points potential (win + place). Tap to expand a rich panel.
- **Form dots:** gold = win, silver/amber = place (top 3), grey = unplaced.
- **Trend arrow:** ↗/→/↘ from avg finishing position of last 3 runs vs prior 3 (threshold ±0.7; unplaced = 8th for the average). Derived — no new feed.
- **Provenance tagging** on every field: **LIVE** (feed: name/odds/form), **DERIVED** (computed: dots/trend/points/fav), **SRC?** (needs a source: jockey/trainer, course/dist stats, suitability, written insight). Production feed today is **form + odds only**; richer fields show placeholder/unverified (SRC?) until a feed is licensed — a data-sourcing decision, not a design one.
- **Silks:** placeholder two-tone swatch per runner (real silks need a source).
- **Rival picks:** revealed only **post-deadline** as an avatar badge on the row.
- **3-state demo toggle:** pre-deadline (pick + change) / picks locked / rivals revealed.

## Live race / result reveal  🟥 PACK

- **Feel: fast result reveal** — no animated lane-by-lane playback. Straight to a clean result card: finishing order, your horse's position, points with full bonus breakdown.
- At most a brief win/place celebration (confetti). The earlier "simulated playback over race duration" idea is superseded by the fast-reveal preference.

## Mobile shell  🟦

Viewport locked (`maximum-scale=1.0`), bottom-nav app shell, centred 430px mobile frame, light default + dark toggle.

## Onboarding  🟦 shape / 🟥 demo

- Spectator-first: short modal intro (2–3 cards, skippable after the first), then free-roam explore as a spectator.
- Demo uses a real historical run; conversion pitch fires after the full demo cycle completes.
