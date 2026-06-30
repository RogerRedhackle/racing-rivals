# Racing Rivals

A multi-sport fan-engagement and prediction game by [ScoreBox](https://scorebox.games). Each round, every player makes one pick from a priced field, scored on an odds-weighted value curve. Players compete in 20-runner leagues over a Day, Festival or Season.

Live: https://racing-rivals.scorebox.games

## 📖 Game Bible

The canonical reference for the game lives in **[`racing-rivals-bible/`](./racing-rivals-bible/00_index.md)**. Start with the [index](./racing-rivals-bible/00_index.md).

Every section is tagged 🟦 **ENGINE** (sport-agnostic, reusable for Football / NFL / F1) or 🟥 **PACK** (racing-specific), so a new sport pack is a fill-in-the-blanks exercise. Key sections:

- [Scoring model (v2, locked)](./racing-rivals-bible/03_scoring_model.md)
- [Tie-break ladder](./racing-rivals-bible/04_tiebreaks.md)
- [Multi-sport engine + adapter slots](./racing-rivals-bible/09_multisport_engine.md)
- [Data & integrity model](./racing-rivals-bible/08_data_and_integrity.md)

The Bible is the source of truth. When a decision changes, it changes there first.
