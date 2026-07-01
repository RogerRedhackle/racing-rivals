-- ============================================================================
-- 05_orchestration.sql  —  Scheduling layer for the scoring engine
-- ----------------------------------------------------------------------------
-- ScoreBox / Racing Rivals · ENGINE (sport-agnostic orchestration)
--
-- Migration 02 gave us the two work functions:
--   run_daily_scoring(league_id, date)  — score one league for one day
--   settle_challenge(challenge_id)       — settle one H2H challenge
--
-- This migration adds the layer that decides WHEN to call them, so a cron /
-- edge function only has to call ONE thing on a schedule. The decisions live in
-- SQL (next to the data) so the gating logic is testable and host-agnostic.
--
-- Design (per Roger): AUTO-GATE ON RESULTED RACES. We never score a day on a
-- fixed wall-clock time; we score a (league, date) the moment that day's races
-- are all resulted, and not before. The orchestrator is safe to run as often as
-- you like (idempotent): already-scored days are skipped, unready days wait.
--
-- Apply order: 01 -> 02 -> 03 -> 04 -> 05.
-- Verified against PostgreSQL 18.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. RUN LOG  (observability + idempotency audit for every orchestrated call)
-- ----------------------------------------------------------------------------
-- A durable record of every scoring / settlement action the orchestrator took.
-- This is what the edge function / cron reads back to report "what happened",
-- and what an operator inspects when a day looks wrong. Engine-written only.

create table if not exists public.scoring_runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('score_day','settle_challenge')),
  league_id     uuid references public.leagues(id) on delete cascade,
  score_date    date,                       -- for kind='score_day'
  challenge_id  uuid references public.h2h_challenges(id) on delete cascade, -- for settle
  status        text not null check (status in ('ok','skipped','error')),
  detail        text,                       -- human-readable note / error text
  ran_at        timestamptz not null default now()
);
comment on table public.scoring_runs is
  'Audit trail of every orchestrated scoring/settlement action. Engine-written (SECURITY DEFINER); clients have no write path (RLS).';

create index if not exists idx_scoring_runs_ran_at on public.scoring_runs (ran_at desc);
create index if not exists idx_scoring_runs_league on public.scoring_runs (league_id, score_date);

-- ----------------------------------------------------------------------------
-- 1. READINESS GATES  (is this day's racing finished?)
-- ----------------------------------------------------------------------------
-- A race "counts as done" when its status = 'resulted' OR 'void' (a void race
-- is settled — it simply produces no points). A day is ready when it has at
-- least one countable race AND every scheduled race that day is done.
--
-- We gate on the set of races whose off_time falls on the calendar date (UTC
-- date of off_time; racing days are single UK days so this is unambiguous for
-- the racing pack — other packs can override the date expression).

-- All races going off on p_date, across every meeting (the racing universe for
-- a "day"). Returns the readiness verdict for that whole day.
create or replace function public.day_is_resulted(p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) > 0                                              -- there is racing
    and count(*) filter (
          where status not in ('resulted','void')
        ) = 0                                                 -- none unfinished
  from public.races
  where (off_time at time zone 'UTC')::date = p_date;
$$;
comment on function public.day_is_resulted(date) is
  'TRUE when every race going off on p_date is resulted or void (and there is at least one). The auto-gate for scoring. ENGINE (racing date expression is the PACK part).';

-- Festival-aware variant: for a festival league we only care about the races
-- inside that festival's meetings; for non-festival (day/season) leagues we use
-- the global racing day. This keeps a season league from waiting on an
-- unrelated meeting elsewhere.
create or replace function public.league_day_is_resulted(p_league_id uuid, p_date date)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_fest uuid;
  v_total int;
  v_unfinished int;
begin
  select festival_id into v_fest from public.leagues where id = p_league_id;

  if v_fest is null then
    -- day / season leagues: gate on the whole racing day
    return public.day_is_resulted(p_date);
  end if;

  -- festival leagues: gate only on this festival's races on p_date
  select count(*),
         count(*) filter (where r.status not in ('resulted','void'))
    into v_total, v_unfinished
  from public.races r
  join public.meetings mt on mt.id = r.meeting_id
  where mt.festival_id = v_fest
    and (r.off_time at time zone 'UTC')::date = p_date;

  return v_total > 0 and v_unfinished = 0;
end $$;
comment on function public.league_day_is_resulted(uuid, date) is
  'Readiness gate scoped to a league: festival leagues gate on their own festival meetings; day/season leagues gate on the whole racing day.';

-- Has a (league, date) already been fully scored? We treat a day as scored if
-- every ACTIVE member already has a daily_scores row for that date. (New joiners
-- after a scoring pass would make it re-run for everyone, which is harmless and
-- idempotent.)
create or replace function public.day_is_scored(p_league_id uuid, p_date date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.league_members
       where league_id = p_league_id and status = 'active') > 0
    and not exists (
      select 1
      from public.league_members lm
      where lm.league_id = p_league_id and lm.status = 'active'
        and not exists (
          select 1 from public.daily_scores ds
          where ds.league_id = p_league_id
            and ds.profile_id = lm.profile_id
            and ds.score_date = p_date
        )
    );
$$;
comment on function public.day_is_scored(uuid, date) is
  'TRUE when every active member already has a daily_scores row for p_date (idempotency check for the orchestrator).';

-- ----------------------------------------------------------------------------
-- 2. ORCHESTRATOR: SCORE ALL READY DAYS
-- ----------------------------------------------------------------------------
-- Walks every live league and every competition day inside its window that is
-- (a) in the past or today, (b) within the lookback horizon, (c) resulted, and
-- (d) not already scored — and runs run_daily_scoring for it. Returns a summary
-- row count and writes one scoring_runs row per (league, date) acted on.
--
-- p_lookback_days: how far back to re-check (default 3) — catches a late result
-- correction or a day that wasn't ready last run. Safe because scoring is
-- idempotent (upsert). p_today: injectable "today" for testing.
create or replace function public.score_ready_days(
  p_lookback_days int default 3,
  p_today date default null
)
returns table (league_id uuid, score_date date, status text, detail text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'UTC')::date);
  L record;
  d date;
  v_floor date;
begin
  for L in
    select lg.id, lg.starts_on, lg.ends_on
    from public.leagues lg
    where lg.status = 'live'
  loop
    -- iterate days from max(window start, today - lookback) up to min(window end, today)
    v_floor := greatest(L.starts_on, v_today - p_lookback_days);
    d := v_floor;
    while d <= least(L.ends_on, v_today) loop
      if public.day_is_scored(L.id, d) then
        -- already done: report skipped only if it's the freshest day, to keep noise low
        league_id := L.id; score_date := d; status := 'skipped'; detail := 'already scored';
        -- (do not log skips to scoring_runs; they are the steady state)
        return next;
      elsif not public.league_day_is_resulted(L.id, d) then
        league_id := L.id; score_date := d; status := 'skipped'; detail := 'not yet resulted';
        return next;
      else
        begin
          perform public.run_daily_scoring(L.id, d);
          insert into public.scoring_runs(kind, league_id, score_date, status, detail)
          values ('score_day', L.id, d, 'ok', 'scored');
          league_id := L.id; score_date := d; status := 'ok'; detail := 'scored';
          return next;
        exception when others then
          insert into public.scoring_runs(kind, league_id, score_date, status, detail)
          values ('score_day', L.id, d, 'error', sqlerrm);
          league_id := L.id; score_date := d; status := 'error'; detail := sqlerrm;
          return next;
        end;
      end if;
      d := d + 1;
    end loop;
  end loop;
end $$;
comment on function public.score_ready_days(int, date) is
  'Orchestrator: scores every live-league competition day that is resulted and not yet scored, within the lookback horizon. Idempotent; safe to call frequently. The single entry point for the daily-scoring cron.';

-- ----------------------------------------------------------------------------
-- 3. ORCHESTRATOR: SETTLE ALL DUE CHALLENGES
-- ----------------------------------------------------------------------------
-- A challenge is DUE when its window has closed (ends_on < today) and every day
-- in its window is resulted for that league, and it is still pending/active.
-- We settle each one via settle_challenge() and log the result.
create or replace function public.settle_due_challenges(
  p_today date default null
)
returns table (challenge_id uuid, status text, detail text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'UTC')::date);
  C record;
  d date;
  v_all_resulted boolean;
begin
  for C in
    select hc.id, hc.league_id, hc.starts_on, hc.ends_on
    from public.h2h_challenges hc
    where hc.status in ('pending','active')
      and hc.ends_on < v_today
  loop
    -- confirm the whole window is resulted before settling (don't settle on
    -- a window with a still-pending result correction)
    v_all_resulted := true;
    d := C.starts_on;
    while d <= C.ends_on loop
      if not public.league_day_is_resulted(C.league_id, d) then
        v_all_resulted := false;
        exit;
      end if;
      d := d + 1;
    end loop;

    if not v_all_resulted then
      challenge_id := C.id; status := 'skipped'; detail := 'window not fully resulted';
      return next;
      continue;
    end if;

    begin
      perform public.settle_challenge(C.id);
      insert into public.scoring_runs(kind, challenge_id, league_id, status, detail)
      values ('settle_challenge', C.id, C.league_id, 'ok', 'settled');
      challenge_id := C.id; status := 'ok'; detail := 'settled';
      return next;
    exception when others then
      insert into public.scoring_runs(kind, challenge_id, league_id, status, detail)
      values ('settle_challenge', C.id, C.league_id, 'error', sqlerrm);
      challenge_id := C.id; status := 'error'; detail := sqlerrm;
      return next;
    end;
  end loop;
end $$;
comment on function public.settle_due_challenges(date) is
  'Orchestrator: settles every pending/active H2H challenge whose window has closed and is fully resulted. Idempotent (settled challenges are no longer pending/active). The single entry point for the settlement cron.';

-- ----------------------------------------------------------------------------
-- 4. ONE-CALL TICK  (what the edge function / cron actually invokes)
-- ----------------------------------------------------------------------------
-- Convenience wrapper: do a full orchestration tick (score then settle) and
-- return a compact JSON summary the caller can log / alert on.
create or replace function public.orchestrate_tick(
  p_lookback_days int default 3,
  p_today date default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scored int; v_score_err int; v_settled int; v_settle_err int;
begin
  select count(*) filter (where status='ok'),
         count(*) filter (where status='error')
    into v_scored, v_score_err
  from public.score_ready_days(p_lookback_days, p_today);

  select count(*) filter (where status='ok'),
         count(*) filter (where status='error')
    into v_settled, v_settle_err
  from public.settle_due_challenges(p_today);

  return jsonb_build_object(
    'ran_at', now(),
    'days_scored', v_scored,
    'days_errored', v_score_err,
    'challenges_settled', v_settled,
    'challenges_errored', v_settle_err
  );
end $$;
comment on function public.orchestrate_tick(int, date) is
  'Full orchestration tick: score ready days then settle due challenges; returns a JSON summary. This is the single RPC the cron/edge function calls.';

-- ----------------------------------------------------------------------------
-- 5. PERMISSIONS  (service_role only — same discipline as the work functions)
-- ----------------------------------------------------------------------------
-- The orchestrators are SECURITY DEFINER and must never be callable by clients.
revoke execute on function public.day_is_resulted(date)             from public, anon, authenticated;
revoke execute on function public.league_day_is_resulted(uuid,date) from public, anon, authenticated;
revoke execute on function public.day_is_scored(uuid,date)          from public, anon, authenticated;
revoke execute on function public.score_ready_days(int,date)        from public, anon, authenticated;
revoke execute on function public.settle_due_challenges(date)       from public, anon, authenticated;
revoke execute on function public.orchestrate_tick(int,date)        from public, anon, authenticated;

grant execute on function public.score_ready_days(int,date)   to service_role;
grant execute on function public.settle_due_challenges(date)  to service_role;
grant execute on function public.orchestrate_tick(int,date)   to service_role;

-- the read-only gate helpers are useful for ops/monitoring (e.g. "is this day
-- ready to score yet?") so the trusted backend may call them directly too.
grant execute on function public.day_is_resulted(date)             to service_role;
grant execute on function public.league_day_is_resulted(uuid,date) to service_role;
grant execute on function public.day_is_scored(uuid,date)          to service_role;

-- scoring_runs: readable by members? No — engine-only by default (no policy =
-- no client access under RLS). Enable RLS so it's locked like the rest.
alter table public.scoring_runs enable row level security;
-- (intentionally no client policies: only service_role, which bypasses RLS, may read/write)

-- ----------------------------------------------------------------------------
-- 6. OPTIONAL: pg_cron schedule (run inside Supabase)
-- ----------------------------------------------------------------------------
-- If you prefer Supabase-native scheduling over an external cron hitting the
-- edge function, enable pg_cron and schedule orchestrate_tick directly. This is
-- commented out so the migration stays portable; uncomment in Supabase.
--
--   create extension if not exists pg_cron;
--   -- every 30 min between 14:00–23:30 UTC (afternoon/evening UK racing results)
--   select cron.schedule(
--     'scorebox-orchestrate',
--     '*/30 14-23 * * *',
--     $$ select public.orchestrate_tick(3, null); $$
--   );
--
-- To remove:  select cron.unschedule('scorebox-orchestrate');

-- ============================================================================
-- END 05_orchestration.sql
-- ============================================================================
