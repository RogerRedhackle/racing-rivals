# 03 · Scoring Model (v2 — LOCKED)  ⬜ MIXED

This is the **authoritative scoring spec.** It supersedes all earlier scoring models (the Phase 1 `odds×10` model and the interim "secret sauce" `×10 + multiplicative bonuses` model are both **dead** — do not use them).

The *shape* of this model is 🟦 ENGINE (every sport inherits it). The fractional-odds source is 🟥 PACK.

---

## The model, in full

A pick has a **kind**: `win` or `place`. Scoring reads only authoritative server data.

### Bases
- **Win base** = the fractional-odds number itself ("to one" value): 9/1 = **9**, 8/1 = 8, 7/2 = **3.5**, 11/2 = 5.5, evens = **1**, 28/1 = 28.
- **Place base** = **half** the win base (`×0.5`). 9/1 placed = **4.5**.

### `kind = 'win'`
- Horse finishes **1st** → **full win base** + beat-the-favourite (if eligible) + streak (if eligible).
- Horse only **places** (in the paid places, not 1st) → **half-base consolation** — the each-way safety net. **No bonuses.** The streak **resets** (a consolation is not a win).
- Horse **unplaced** → **0**.

### `kind = 'place'`
- Horse finishes in the paid places (1st…Nth) → **half-base**. No bonuses.
- Otherwise → **0**.
- A place selection **never** builds or extends a streak (streak = wins only).

### Bonuses (win-only)
- **Beat-the-favourite** = **+2 flat**, **WIN ONLY**, and only if the pick was **not** the market favourite of its field. A place — including a `place` selection or a `win` selection that only placed — **never** earns it.
- **Win streak** = **+1 flat per consecutive winning day, from day 2** (day 2 = +1, day 3 = +2, …). **Wins only.** No cap. A place scores but does not build a streak; a miss or no-pick resets it to 0.

### Constants
```
PLACE_FRAC = 0.5     # place base = win base × 0.5
FAV_FLAT   = 2       # beat-the-favourite, win only, non-favourite
STREAK_FLAT = 1      # per consecutive winning day from day 2
```

### Failure & display
- Loss / no-pick = **0**, resets the streak.
- Numbers shown to **1 decimal place**, trailing `.0` trimmed.
- Every on-screen result shows an **itemised breakdown**: base + fav-beater + streak = day total.

---

## Paid places (places that count for a "place")  🟥 PACK

Field-size based (standard each-way terms):
- 5–7 runners → **2 places**
- 8–15 runners → **3 places**
- 16+ (handicap) → **4 places**

(Royal Hunt Cup demo = 3 places.)

---

## Verified worked examples (checked in Postgres / node)

| Selection | kind | Finish | Points | Why |
|---|---|---|---|---|
| Indalo 9/1, non-fav, **win**, streak day 2 | win | 1st | **12.0** | 9 base + 2 fav-beater + 1 streak |
| Indalo 9/1, non-fav, win bet but **only placed** | win | 3rd | **4.5** | each-way consolation: 9 × 0.5; **no bonuses; streak resets** |
| Indalo 9/1, non-fav, **place** bet | place | placed | **4.5** | 9 × 0.5; no fav/streak on a place |
| Archivist 5/1, **favourite**, win | win | 1st | **5.0** | base only — **no +2** (it was the favourite) |
| A horse that finishes unplaced | win | 9th | **0.0** | miss |
| No pick | — | — | **0.0** | `no_pick`; streak resets |

---

## Why the rules are shaped this way (do not "simplify" these away)

- **Each-way consolation on a win bet** (the half-base on a place) was a deliberate choice so a `win` selection that narrowly places isn't a brutal zero — it softens the downside while keeping wins clearly more valuable. A place is still *not* a win, so it earns no bonuses and breaks the streak.
- **Beat-the-favourite is WIN-ONLY** because a 50,000-week Monte-Carlo simulation found that firing it on a *place* made hammering short-priced **second-favourites** the dominant, regressive strategy (≈2.9× the value of genuine longshot value-picking). Making it win-only flattened the best/worst strategy spread to the tightest of all options tested (2.89× → 1.89×) and killed the place-farming exploit. **This is the standing stress-test guard for every sport pack** — never put a flat favourite-beating bonus on partial credit.
- **Fractional base** (not decimal×10) keeps the mental model honest: "9/1 = 9 points, plus the bonuses = your total." The earlier ×10 convention made an 8/1 winner read as 90 and looked unexplained/inflated.

---

## 🟦 ENGINE generalisation (for other sports)

- **Base** = a function of the pick's price — in racing the fractional-odds number; in other sports a normalised value-from-odds score so longshots pay more than favourites.
- **Partial credit (×0.5)** = the sport's near-miss tier (racing place; football "assisted/hit the woodwork"; F1 podium-not-win).
- **Beat-the-favourite** = +2 flat, success-only, non-favourite of the field.
- **Streak** = +1 per consecutive success from the 2nd, no cap. (Constant may be tuned where rounds are scarce, e.g. F1's ~24 rounds.)
- The **shape is identical across sports** — that is what makes cross-sport leaderboards and a single learnable mental model possible. Constants can be tuned per sport but must be re-stress-tested.
