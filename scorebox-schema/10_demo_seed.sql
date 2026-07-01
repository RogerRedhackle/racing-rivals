-- ============================================================================
-- 10_demo_seed.sql  —  Canonical repeatable DEMO seed  (Racing Rivals)
-- ----------------------------------------------------------------------------
-- Purpose: make every wired screen (Today / Results / League) come alive with
-- ONE idempotent script, using the SAME production write path the real
-- TheRacingAPI ingest uses (ingest_meeting / ingest_race / ingest_runners /
-- apply_result) and the SAME scoring engine (run_daily_scoring). No hand-faked
-- scores — daily_scores is produced by the engine, exactly as in production.
--
-- Data: the canonical demo dataset from racing-rivals-bible/12_demo_data.md —
-- Royal Hunt Cup, Royal Ascot, 17 Jun 2026 (Indalo 9/1 placed 3rd; favourite
-- Archivist 5/1 finished 9th). Extended to a 3-day loop (16/17/18 Jun) across
-- three courses so the leaderboard + Results week strip have real movement.
--
-- Runners (league members): a demo player + two rivals, so standings populate.
--   • demo_you  → Indalo 9/1 WIN on 17th (placed 3rd = 4.5), plus wins to build a streak
--   • priya     → the leader
--   • tom       → mid-table
--
-- SAFETY: idempotent. Re-running upserts meetings/races/runners and re-applies
-- results + re-scores. Demo profiles use FIXED uuids so re-runs are stable.
-- Run as service_role (RPCs are SECURITY DEFINER / service_role-gated).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. DEMO IDENTITIES  (fixed uuids → stable across re-runs)
-- ---------------------------------------------------------------------------
-- profiles.id references auth.users(id). In Supabase these rows are normally
-- created by the auth service; for a self-contained seed we insert matching
-- auth.users shells first, then profiles. Both upsert on the fixed uuid.
do $$
declare
  u_you   constant uuid := 'd3305eed-0001-4000-a000-000000000001';
  u_priya constant uuid := 'a1b2c3d4-0002-4000-a000-000000000002';
  u_tom   constant uuid := 'f9e8d7c6-0003-4000-a000-000000000003';
begin
  -- auth.users shells (email + metadata so any auth trigger is satisfied).
  insert into auth.users (id, email, raw_user_meta_data)
  values
    (u_you,   'you@demo.racingrivals',   '{"handle":"demo_you","display_name":"You"}'::jsonb),
    (u_priya, 'priya@demo.racingrivals', '{"handle":"priya_r","display_name":"Priya"}'::jsonb),
    (u_tom,   'tom@demo.racingrivals',   '{"handle":"tom_h","display_name":"Tom"}'::jsonb)
  on conflict (id) do nothing;

  -- profiles (upsert; handle/display_name kept stable).
  insert into public.profiles (id, handle, display_name, avatar_seed, country)
  values
    (u_you,   'demo_you', 'You',   'you',   'GB'),
    (u_priya, 'priya_r',  'Priya', 'priya', 'GB'),
    (u_tom,   'tom_h',    'Tom',   'tom',   'GB')
  on conflict (id) do update
    set handle = excluded.handle,
        display_name = excluded.display_name;
end $$;

-- ---------------------------------------------------------------------------
-- 1. THE LEAGUE  "The Paddock"  (season mode, LIVE)
--    Scoring history sits on 16-18 Jun 2026, but ends_on is kept in the future
--    (current_date + 60) so the league always "covers today" — the client
--    (getMyActiveLeague) only surfaces a league whose [starts_on, ends_on]
--    window contains today. A fixed past ends_on would make the demo show
--    "No live league yet" the moment the calendar moves past it.
-- ---------------------------------------------------------------------------
do $$
declare
  l_id     uuid;
  u_you   constant uuid := 'd3305eed-0001-4000-a000-000000000001';
  u_priya constant uuid := 'a1b2c3d4-0002-4000-a000-000000000002';
  u_tom   constant uuid := 'f9e8d7c6-0003-4000-a000-000000000003';
begin
  select id into l_id from public.leagues where invite_code = 'PADDOCK-01';
  if l_id is null then
    insert into public.leagues
      (name, mode, invite_code, starts_on, ends_on, max_runners, status, created_by)
    values
      ('The Paddock', 'season', 'PADDOCK-01',
       date '2026-06-16', current_date + 60, 10, 'live', u_you)
    returning id into l_id;
  else
    update public.leagues
       set status = 'live', starts_on = date '2026-06-16', ends_on = current_date + 60
     where id = l_id;
  end if;

  insert into public.league_members (league_id, profile_id, status) values
    (l_id, u_you,   'active'),
    (l_id, u_priya, 'active'),
    (l_id, u_tom,   'active')
  on conflict (league_id, profile_id) do update set status = 'active';

  -- stash the league id for later blocks
  perform set_config('demo.league_id', l_id::text, false);
end $$;

-- ---------------------------------------------------------------------------
-- 2. INGEST THE CARD  (production RPCs — meeting → race → runners)
-- ---------------------------------------------------------------------------
-- Helper pattern: ingest_meeting → ingest_race → ingest_runners for each day.
-- We use the canonical Royal Hunt Cup on the 17th, plus a race each on the
-- 16th (Brighton) and 18th (Carlisle) so the loop spans three days.
do $$
declare
  m_id uuid;
  r_id uuid;
begin
  -- ===== DAY 1 · 16 Jun · Brighton =====
  m_id := public.ingest_meeting('Brighton', date '2026-06-16', 'Good', null, 'demo-seed');
  r_id := public.ingest_race(m_id, 1::smallint, 'Brighton Handicap',
            timestamptz '2026-06-16 14:10:00+01', '5f', 'Class 4', 3::smallint, 'demo-seed');
  perform public.ingest_runners(r_id, $j$[
    {"cloth_no":1,"horse_name":"Kalooki","jockey":"J Doyle","trainer":"A King","odds_num":11,"odds_den":2},
    {"cloth_no":2,"horse_name":"Sea Fret","jockey":"T Marquand","trainer":"W Haggas","odds_num":3,"odds_den":1},
    {"cloth_no":3,"horse_name":"Night Owl","jockey":"R Moore","trainer":"J Gosden","odds_num":9,"odds_den":4},
    {"cloth_no":4,"horse_name":"Copper Beech","jockey":"O Murphy","trainer":"R Varian","odds_num":8,"odds_den":1}
  ]$j$::jsonb, 'demo-seed');
  perform set_config('demo.race_16', r_id::text, false);

  -- ===== DAY 2 · 17 Jun · Royal Ascot · ROYAL HUNT CUP (canonical) =====
  m_id := public.ingest_meeting('Royal Ascot', date '2026-06-17', 'Good To Firm', null, 'demo-seed');
  r_id := public.ingest_race(m_id, 4::smallint, 'Royal Hunt Cup',
            timestamptz '2026-06-17 14:30:00+01', '1m', 'Class 2', 3::smallint, 'demo-seed');
  -- Field incl. the recurring worked-example horses. Archivist is the favourite.
  perform public.ingest_runners(r_id, $j$[
    {"cloth_no":1,"horse_name":"Archivist","jockey":"W Buick","trainer":"C Appleby","odds_num":5,"odds_den":1},
    {"cloth_no":2,"horse_name":"Indalo","jockey":"O Murphy","trainer":"A Balding","odds_num":9,"odds_den":1},
    {"cloth_no":3,"horse_name":"Rogue Diplomat","jockey":"D Tudhope","trainer":"K Burke","odds_num":28,"odds_den":1},
    {"cloth_no":4,"horse_name":"Blue Rc","jockey":"J Watson","trainer":"M Johnston","odds_num":28,"odds_den":1},
    {"cloth_no":5,"horse_name":"Ebt's Guard","jockey":"S Levey","trainer":"R Hannon","odds_num":20,"odds_den":1},
    {"cloth_no":6,"horse_name":"Cerulean Bay","jockey":"R Kingscote","trainer":"T Easterby","odds_num":25,"odds_den":1},
    {"cloth_no":7,"horse_name":"Erzindjan","jockey":"H Doyle","trainer":"D Menuisier","odds_num":17,"odds_den":2}
  ]$j$::jsonb, 'demo-seed');
  perform set_config('demo.race_17', r_id::text, false);

  -- ===== DAY 3 · 18 Jun · Carlisle =====
  m_id := public.ingest_meeting('Carlisle', date '2026-06-18', 'Soft', null, 'demo-seed');
  r_id := public.ingest_race(m_id, 2::smallint, 'Carlisle Novice Stakes',
            timestamptz '2026-06-18 15:05:00+01', '7f', 'Class 5', 3::smallint, 'demo-seed');
  perform public.ingest_runners(r_id, $j$[
    {"cloth_no":1,"horse_name":"Tin Hat","jockey":"P Mulrennan","trainer":"M Dods","odds_num":9,"odds_den":1},
    {"cloth_no":2,"horse_name":"Fell Runner","jockey":"C Lee","trainer":"K Dalgleish","odds_num":2,"odds_den":1},
    {"cloth_no":3,"horse_name":"Border Reiver","jockey":"J Hart","trainer":"R Fahey","odds_num":7,"odds_den":2},
    {"cloth_no":4,"horse_name":"Solway Star","jockey":"B Robinson","trainer":"I Jardine","odds_num":6,"odds_den":1}
  ]$j$::jsonb, 'demo-seed');
  perform set_config('demo.race_18', r_id::text, false);
end $$;

-- ---------------------------------------------------------------------------
-- 3. PICKS  (insert directly as the engine's authoritative input)
-- ---------------------------------------------------------------------------
-- Picks are normally player-written pre-lock via RLS. For the seed we insert
-- them server-side (service_role bypasses RLS; the validate_pick trigger's
-- window/ownership checks are disabled for the seed and re-enabled after).
alter table public.picks disable trigger user;
do $$
declare
  l_id  uuid := current_setting('demo.league_id')::uuid;
  r16   uuid := current_setting('demo.race_16')::uuid;
  r17   uuid := current_setting('demo.race_17')::uuid;
  r18   uuid := current_setting('demo.race_18')::uuid;
  u_you   constant uuid := 'd3305eed-0001-4000-a000-000000000001';
  u_priya constant uuid := 'a1b2c3d4-0002-4000-a000-000000000002';
  u_tom   constant uuid := 'f9e8d7c6-0003-4000-a000-000000000003';
  function_get_runner text;
begin
  -- helper: resolve a runner id by race + horse name
  -- (inline via a CTE per insert)

  -- DAY 1 (16th) picks
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_you, date '2026-06-16', id, 'win'   from public.runners where race_id=r16 and horse_name='Kalooki'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_priya, date '2026-06-16', id, 'win' from public.runners where race_id=r16 and horse_name='Night Owl'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_tom, date '2026-06-16', id, 'win'   from public.runners where race_id=r16 and horse_name='Sea Fret'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;

  -- DAY 2 (17th · Royal Hunt Cup) picks
  --   you → Indalo (win bet, will place 3rd = 4.5)
  --   priya → Rogue Diplomat (win bet, WINS at 28/1 — big leader move)
  --   tom → Archivist the favourite (win bet, finishes 9th = 0)
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_you, date '2026-06-17', id, 'win'   from public.runners where race_id=r17 and horse_name='Indalo'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_priya, date '2026-06-17', id, 'win' from public.runners where race_id=r17 and horse_name='Rogue Diplomat'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_tom, date '2026-06-17', id, 'win'   from public.runners where race_id=r17 and horse_name='Archivist'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;

  -- DAY 3 (18th) picks — you back the favourite and win to extend a streak
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_you, date '2026-06-18', id, 'win'   from public.runners where race_id=r18 and horse_name='Fell Runner'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;
  insert into public.picks (league_id, profile_id, pick_date, runner_id, kind)
  select l_id, u_priya, date '2026-06-18', id, 'win' from public.runners where race_id=r18 and horse_name='Border Reiver'
  on conflict (league_id, profile_id, pick_date) do update set runner_id=excluded.runner_id, kind=excluded.kind;
  -- tom makes NO pick on the 18th → tests the no_pick path
end $$;
alter table public.picks enable trigger user;

-- ---------------------------------------------------------------------------
-- 4. APPLY RESULTS  (production RPC — writes finishing order, flips resulted)
-- ---------------------------------------------------------------------------
do $$
declare
  r16 uuid := current_setting('demo.race_16')::uuid;
  r17 uuid := current_setting('demo.race_17')::uuid;
  r18 uuid := current_setting('demo.race_18')::uuid;
begin
  -- 16th · Brighton: Kalooki (you) WINS at 11/2; Night Owl (priya) 2nd; Sea Fret (tom) unplaced
  perform public.apply_result(r16, $p$[
    {"cloth_no":1,"finish_pos":1},
    {"cloth_no":3,"finish_pos":2},
    {"cloth_no":2,"finish_pos":4},
    {"cloth_no":4,"finish_pos":3}
  ]$p$::jsonb, false, null, 'demo-seed');

  -- 17th · Royal Hunt Cup (real result): Rogue Diplomat 1st, Blue Rc 2nd,
  -- Indalo 3rd, Ebt's Guard 4th, Cerulean Bay 5th, Erzindjan 6th, Archivist 9th(unplaced)
  perform public.apply_result(r17, $p$[
    {"cloth_no":3,"finish_pos":1},
    {"cloth_no":4,"finish_pos":2},
    {"cloth_no":2,"finish_pos":3},
    {"cloth_no":5,"finish_pos":4},
    {"cloth_no":6,"finish_pos":5},
    {"cloth_no":7,"finish_pos":6},
    {"cloth_no":1,"finish_pos":9}
  ]$p$::jsonb, false, null, 'demo-seed');

  -- 18th · Carlisle: Fell Runner (you) WINS at 2/1; Border Reiver (priya) 3rd; Tin Hat unplaced
  perform public.apply_result(r18, $p$[
    {"cloth_no":2,"finish_pos":1},
    {"cloth_no":3,"finish_pos":3},
    {"cloth_no":4,"finish_pos":2},
    {"cloth_no":1,"finish_pos":5}
  ]$p$::jsonb, false, null, 'demo-seed');
end $$;

-- ---------------------------------------------------------------------------
-- 5. SCORE  (engine — produces daily_scores per day, in date order)
-- ---------------------------------------------------------------------------
do $$
declare
  l_id uuid := current_setting('demo.league_id')::uuid;
begin
  perform public.run_daily_scoring(l_id, date '2026-06-16');
  perform public.run_daily_scoring(l_id, date '2026-06-17');
  perform public.run_daily_scoring(l_id, date '2026-06-18');
end $$;

commit;

-- ---------------------------------------------------------------------------
-- 6. VERIFY  (read-back; run manually to confirm the loop reconciles)
-- ---------------------------------------------------------------------------
-- select p.display_name, ds.score_date, ds.outcome, ds.total_pts
--   from public.daily_scores ds join public.profiles p on p.id = ds.profile_id
--  where ds.league_id = (select id from public.leagues where invite_code='PADDOCK-01')
--  order by ds.score_date, p.display_name;
