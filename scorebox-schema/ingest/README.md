# ScoreBox / Racing Rivals — Racing-Data Ingest Runbook

How raw racing data becomes the rows the game scores: **meetings → races →
runners (odds + favourite) → results**, written through a trusted, idempotent,
service-role-only path — then picked up automatically by the scoring engine.

> **Design shape.** The DB owns all integrity; the worker is thin and
> provider-swappable. You never write raw SQL against racing tables — you call
> five RPCs (migration `06_ingest.sql`), and any feed can drive them through a
> small adapter. This is the racing realisation of the multi-sport "sport pack".

---

## The pipeline in one picture

```
                 ┌─────────────────┐     fetchCards(date)     ┌──────────────┐
   The Racing    │  Provider       │ ───────────────────────▶ │              │
   API  ────────▶│  adapter        │     fetchResults(date)   │  Ingest      │
  (or any feed)  │ (normalises)    │ ───────────────────────▶ │  worker      │
                 └─────────────────┘                          │ (TS, thin)   │
                                                               └──────┬───────┘
                                    service-role RPCs (idempotent)    │
                                    ingest_meeting / ingest_race /     ▼
                                    ingest_runners / set_race_status / ┌──────────┐
                                    apply_result                       │ Postgres │
                                                                       │ (Supabase)│
                                                                       └────┬─────┘
                             apply_result flips races to 'resulted' ─────────┘
                                                                            │
                                       orchestrate_tick() gates on          ▼
                                       resulted races → scores the day  ┌──────────┐
                                                                        │ ENGINE   │
                                                                        └──────────┘
```

The ingest layer's **only** job is to get correct rows in and flip races to
`resulted`. It never scores anything. The moment a day's races are all
`resulted`/`void`, the **orchestrator** (see `../scheduler/README.md`) scores it.

---

## The five RPCs (all in `06_ingest.sql`, all `service_role` only)

| RPC | What it does | Idempotency |
| --- | --- | --- |
| `ingest_meeting(course, date, going, festival_slug, provider)` | Upserts a meeting on `(course, meeting_date)`. Links a festival if the slug already exists. Returns `meeting_id`. | Re-run → same row updated in place. |
| `ingest_race(meeting_id, race_no, name, off_time, distance, class, places_paid, provider)` | Upserts a race on `(meeting_id, race_no)`. **Never** moves status backwards. Returns `race_id`. | Re-run → fields updated; status untouched. |
| `ingest_runners(race_id, runners_jsonb, provider)` | Reconciles the **whole field** in one call: upserts each runner by `cloth_no`, marks anyone now absent as `non_runner` (**never deletes** — protects picks), and sets **exactly one favourite** (explicit flag wins, else shortest price, deterministic tie-break). | Re-run → converges; favourite recomputed. |
| `set_race_status(race_id, status, provider)` | The **only** way status moves. Forward-only: `scheduled → open → locked → resulted`; any → `void`; plus a `resulted → void` correction path. | Re-asserting current status = no-op. |
| `apply_result(race_id, placings_jsonb, void_race, final_odds_jsonb, provider)` | Optionally locks closing SP, writes finishing order to `race_results` (delete-then-insert), and flips the race to `resulted` (or `void`). | Re-apply → cleanly replaces the prior result. |

Every call writes one audit row to `public.ingest_runs` (`kind`, `provider`,
`status` = `ok`/`noop`/`error`, `detail`, `ran_at`) — the write-side mirror of
`scoring_runs`.

### JSON shapes

`ingest_runners` — one element per declared runner:

```json
{ "cloth_no": 7, "horse_name": "Archivist", "jockey": "…", "trainer": "…",
  "odds_num": 5, "odds_den": 1, "is_favourite": false, "status": "runner" }
```

`apply_result` — one element per finisher (`finish_pos: null` = unplaced/DNF):

```json
{ "cloth_no": 3, "finish_pos": 1, "is_void": false }
```

Optional `final_odds` (closing SP, so the v2 base uses real SP not the morning price):

```json
{ "cloth_no": 3, "odds_num": 10, "odds_den": 1 }
```

---

## The worker (`ingest/`)

Provider-agnostic. Runs under Deno or Node 18+. Zero DB coupling beyond the RPCs.

| File | Role |
| --- | --- |
| `types.ts` | The **normalised shape** every adapter targets (`NormalisedMeeting/Race/Runner/Placing/Result`) + the `RacingProvider` interface + `parseFractional()`. |
| `adapters/theracingapi.ts` | First adapter — converts The Racing API's racecards + results JSON into the normalised shape. **All field-name mapping lives in one place** (`mapCards`/`mapResults`) so plan/version renames are a one-line change. |
| `worker.ts` | `IngestWorker` — calls the RPCs over PostgREST with the service-role key. Two ops: `ingestCards(date)` and `ingestResults(date)`. Issues no raw SQL. |
| `run.ts` | CLI entrypoint: `run.ts <cards|results> [YYYY-MM-DD]`. |

### Adding a second provider

1. Create `adapters/<provider>.ts` implementing `RacingProvider`
   (`name`, `fetchCards`, `fetchResults`) — return the **normalised** types.
2. Swap it in `run.ts` (or make the provider selectable by env).
   Nothing in `worker.ts`, the RPCs, or the schema changes.

---

## Running it

Set env (Render Cron / crontab / GitHub Actions / a Supabase Edge Function):

```bash
RACING_API_USER=...            # The Racing API basic-auth user
RACING_API_PASS=...            # The Racing API basic-auth pass
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...  # service role — bypasses RLS, drives the RPCs
```

```bash
# Deno
deno run -A ingest/run.ts cards            # today's cards (UTC)
deno run -A ingest/run.ts results 2026-06-17

# Node 18+ (strips TS types on the fly on recent Node; else compile first)
node --experimental-strip-types ingest/run.ts results 2026-06-17
```

Exit codes: `0` ok, `1` config/usage error, `3` run failed.

### Suggested schedule (UTC — UK is UTC+1 in summer)

| Job | Cadence | Why |
| --- | --- | --- |
| `cards` | Morning, then every ~30 min through racing (e.g. `*/30 7-22 * * *`) | Picks up declarations, odds drift, and non-runners before races lock. |
| `results` | Every ~10–15 min during/after racing (e.g. `*/15 13-23 * * *`) | Flips races to `resulted` promptly so the engine scores the day. |

Both are idempotent — running them more often is harmless. Pair with the
orchestrator schedule in `../scheduler/README.md`; the natural order each cycle is
**ingest results → orchestrate tick**.

---

## Favourite & SP resolution (the two subtle bits)

- **Favourite** — exactly one per race is enforced by a partial unique index.
  `ingest_runners` clears all favourites, then sets one: an explicit
  `is_favourite:true` from the feed wins; otherwise it derives the favourite as
  the runner with the shortest `decimal_odds` (generated column), tie-broken by
  lowest `cloth_no` for determinism. Non-runners can never be the favourite.
- **SP** — cards carry the morning/board price. `apply_result`'s optional
  `final_odds` locks the **closing SP** onto runners *before* the race is scored,
  so the v2 base (fractional-odds number) reflects real SP. Omit it and scoring
  uses whatever price was last ingested.

---

## Integrity guarantees (why this is safe to run unattended)

- **Idempotent everywhere** — upserts on natural keys; results are
  delete-then-insert; a re-poll or a duplicated webhook converges, never doubles.
- **Never destructive to picks** — a runner that drops out becomes `non_runner`,
  not deleted, so a pick on it is preserved and voids/scores correctly.
- **Forward-only status** — a stale re-poll can't knock a `resulted` race back to
  `scheduled`; only `set_race_status` moves status, and only forwards.
- **service_role only** — execute is revoked from `public`/`anon`/`authenticated`
  and granted solely to `service_role`; players have **no** write path into
  racing data. Same lockdown as the scoring engine.
- **Auditable** — every write leaves a row in `public.ingest_runs`.

---

## Validated

On PostgreSQL 18 (clean apply `01→06`) with the **real Royal Hunt Cup** card
(Royal Ascot, 17 Jun 2026): meeting/race/runner ingest; favourite auto-derived to
Archivist (5/1, shortest price); `decimal_odds` generated correctly (9/1→10.0,
17/2→9.5); re-ingest with drifted odds stays 7 runners / 1 favourite; explicit
favourite flag overrides the price-derived one; 5 absent runners correctly
marked `non_runner` (rows + picks preserved); result applied (Indalo 3rd = placed
→ 4.5 each-way consolation for a win bet), race flips to `resulted`, engine then
scores the day; a result correction re-applies cleanly (no duplicate
`race_results` rows); the status machine rejects `resulted → scheduled`. Zero
errors across the run.

---

## Files

| Path | Role |
| --- | --- |
| `../06_ingest.sql` | The five ingest RPCs + `ingest_runs` audit table + service_role lockdown. |
| `ingest/types.ts` | Normalised shape + `RacingProvider` interface. |
| `ingest/adapters/theracingapi.ts` | The Racing API adapter (first provider). |
| `ingest/worker.ts` | Provider-agnostic worker (calls the RPCs). |
| `ingest/run.ts` | CLI entrypoint (`cards` / `results`). |
| `ingest/README.md` | This runbook. |
