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

## 🔌 Frontend → Supabase wiring (demo)

Segment 1 of the [demo integration checklist](./racing-rivals-demo-integration-checklist.md) is scaffolded under [`lib/`](./lib):

- **`lib/config.js`** — single source of truth for the demo connection (Supabase URL + PUBLIC anon key, table/RPC names, protected-route list). `isConfigured()` gates whether the app connects.
- **`lib/supabase.js`** — the shared `supabase-js` v2 client singleton (session persistence + auto-refresh). Imported by every page. The `service_role` key is backend-only and never appears here.
- **`lib/session.js`** — the auth-state observer + route guard. `guardRoute()` redirects an unauthenticated visitor to `signin.html`; `onAuth()` keeps header/UI in sync across sign-in / sign-out / token refresh. Every RLS policy keys off `auth.uid()`, so a live session is required before the pick UI is usable.
- **`lib/profile.js`** — read/update-own helpers. `handle_new_user()` auto-creates the profile on signup, so the client only reads + updates display fields (privileged columns are rejected by RLS).
- **`signin.html`** — magic-link sign-in (redirect target of the guard) with a reserved 18+/RG age-gate slot.
- **`today.html`** — the first pick-submission route, now guarded (guard stands down when Supabase is unconfigured so the static demo still renders offline).

### Configure the demo connection

Copy [`.env.example`](./.env.example) and set your demo project URL + anon key. Because the prototypes are static HTML (no build step), `lib/config.js` reads `window.__RR_SUPABASE_URL__` / `window.__RR_SUPABASE_ANON_KEY__`; set them via an inline `<script>` or an untracked `lib/env.local.js` (git-ignored). See `.env.example` for the snippet.

### Verify the security contract

The profile + pick RLS policies already ship in [`scorebox-schema/03_rls_policies.sql`](./scorebox-schema/03_rls_policies.sql) — they are **not** re-created. Instead, run the idempotent verifier after applying `01..06` to prove the demo project matches the contract the frontend is wired to:

```bash
psql "$DEMO_DB_URL" -f scorebox-schema/07_demo_client_grants_verify.sql
# NOTICE: [07 verify] OK — ... Frontend demo wiring is safe to connect.
```

It asserts: RLS enabled on `profiles`+`picks`; the `profiles_read_all`/`profiles_update_own` and `picks_read`/`picks_insert_own`/`picks_update_own`/`picks_delete_own` policies; no client INSERT on `profiles`; the `trg_validate_pick` trigger; `pick_lock_at(date)` executable by `anon`+`authenticated`; and that the scoring engine is NOT client-callable. It raises (fails the run) on any drift.
