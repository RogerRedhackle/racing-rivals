# 05 · Duration Modes  🟦 ENGINE

A league runs in one of three modes. The mode sets the competition window; the daily-pick mechanic is identical in all three.

| Mode | Status | Window | Notes |
|------|--------|--------|-------|
| **Festival** | **Live (default)** | The real meeting / event length (variable) | The default. Every league gets a real-world event hook. |
| **Season** | **Live** | The whole campaign | A meta-layer; holds the H2H season record + biggest-margin stats. |
| **Day** | **Coming soon** | A single date | Locked/teaser tile with a "Notify me" ghost affordance. |

## Festival = real meeting length (variable) — important

A festival is **not** a fixed 7 days. Festival mode runs the **real length of the event**:
- Royal Ascot → **5** days
- Cheltenham → **4** days
- Grand National meeting → **3** days

> ⚠️ **Resolved conflict:** the original core mechanic said "runs for 7 days." That was wrong as a hard rule. The v2 scoring already supports any length (streak +1/day, no cap), so nothing in the engine assumed exactly 7. The "7-day demo" is retained as *one example length*, not the only shape. **Copy must be mode-aware** — "{N} days, one running total," never a hardcoded "Seven days."

## Festival + Season run in parallel

The same daily pick can feed both a **festival** league and a **season** league at once (one pick row per league per day). A runner can compete in a Royal Ascot festival league and a season-long league simultaneously.

## Schema backing  ⬜

`leagues.mode` is the enum `('day','festival','season')`, with `starts_on` / `ends_on` the window and CHECK constraints:
- `day` → enforced single date (`starts_on = ends_on`).
- `festival` → requires a `festival_id` link (the meeting drives the dates).
- `season` → the campaign window.

## 🟦 Sport-pack generalisation

Day / Festival(Event) / Season apply to **every** sport — "Festival" just means *a bounded real-world event*:

| Mode | Racing | Football | NFL | F1 |
|------|--------|----------|-----|-----|
| Day | a single race day | a single matchday | (n/a — weekly) | (n/a — weekend) |
| Festival/Event | a meeting (Ascot, Cheltenham) | a tournament (World Cup, Euros) | a playoff run | a Grand Prix weekend / triple-header |
| Season | the campaign | a league season | the full campaign + playoffs | the championship |

## Deliverable

`racing-rivals-phase-modes-spec.md` + `modes.html` prototype ("Choose your competition" surface, tested light + dark).
