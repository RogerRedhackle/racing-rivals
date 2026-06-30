# 12 · Demo Data  🟥 PACK (racing)

The single canonical demo dataset used across every prototype, the schema seed, and all verified scoring examples. Use this exact data so numbers reconcile everywhere.

## The race

**Royal Hunt Cup**, Royal Ascot, **17 June 2026** — Class 2 Heritage Handicap, 1 mile, Good To Firm.

Chosen because it's a **real, verifiable** race with a dramatic longshot result — better for authenticity than the synthetic repo card (whose runners differ entirely from reality).

- **Source:** Sporting Life results, 2026-06-17 — https://www.sportinglife.com/racing/results/2026-06-17 ; corroborated by Racing Post.

## Finishing order (real result)

| Pos | Horse | Odds (frac) | Odds (dec) |
|-----|-------|-------------|------------|
| 1 | Rogue Diplomat | 28/1 | 29.0 |
| 2 | Blue Rc | 28/1 | 29.0 |
| 3 | **Indalo** | 9/1 | 10.0 |
| 4 | Ebt's Guard | 20/1 | 21.0 |
| 5 | Cerulean Bay | 25/1 | 26.0 |
| 6 | Erzindjan | 17/2 | 9.5 |
| 9th | **Archivist** (favourite) | 5/1 | 6.0 |

- **Favourite:** Archivist 5/1 (finished 9th, unplaced).
- **Indalo 9/1** is the recurring worked-example pick (it placed 3rd).
- Places paid for the demo = **3** (8–15 runner band).

## Why these horses recur in examples

The verified scoring table (`03_scoring_model.md`) is built on this exact data:
- **Indalo 9/1** non-fav: win + streak day 2 = **12.0**; win-bet-only-placed = **4.5**; place-bet placed = **4.5**.
- **Archivist 5/1** favourite: win = **5.0** (no +2, because it was the favourite — the proof case for win-only fav-beater).
- Unplaced / no-pick = **0.0**.

## Wider demo context

- Phase 1 also wired **5 real meetings** for Wed 17 Jun 2026 (Royal Ascot, Hamilton, Worcester, Ripon, Ffos Las) with real runners/odds/results, to exercise the Meeting → Race → Horse drill-down.
- The result is wired as a single editable RESULT array per prototype; the full field can be extended with all runners.
- Enrichment (real jockey, trainer, OR rating, RP in-running comments) drives a realistic simulated replay where used — not random.

## 🟦 Sport-pack note

Each future sport pack needs its **own** canonical real demo dataset chosen on the same principle: a real, verifiable event with a clear longshot story (a surprise scorer, an underdog covering, a shock podium) so the "back a longshot and feel the roar" loop demos well.
