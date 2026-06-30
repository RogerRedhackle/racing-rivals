-- ============================================================================
-- ScoreBox — Standings Tie-Break Rules  (migration 04)
-- ============================================================================
-- Adds the tie-break stats to `standings` and replaces refresh_standings()
-- with a deterministic, H2H-aware ranking.
--
-- TIE-BREAK LADDER (most -> least meaningful). When total_pts are equal:
--   1. total_pts           (primary)
--   2. wins                (most actual wins)
--   3. head-to-head        (if the two tied players have a SETTLED H2H, the
--                           H2H winner ranks higher — applied pairwise)
--   4. best_day_pts        (highest single-day score in the run)
--   5. longest_streak      (longest run of consecutive winning days)
--   6. days_played desc / no_picks asc  (showed up every day)
--   7. reached_total_at    (earliest to reach their total = FINAL decider;
--                           always unique, so ranks are strictly 1,2,3,4...)
--
-- The earned tiers (2,4,5,6) and the unique final decider (7) keep the order a
-- TOTAL order, so H2H (3) can never create a contradictory cycle: it only
-- nudges two otherwise-equal players, and any residual ambiguity is resolved
-- by the strictly-unique "earliest to the total" timestamp.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. New tie-break columns on standings
-- ----------------------------------------------------------------------------
alter table public.standings
  add column if not exists best_day_pts     numeric(8,1) not null default 0,
  add column if not exists longest_streak    smallint     not null default 0,
  add column if not exists no_picks          integer      not null default 0,
  -- the timestamp at which the player's *current cumulative total* was first
  -- reached (the computed_at of their most recent points-adding day). Used as
  -- the final, always-unique decider.
  add column if not exists reached_total_at  timestamptz;

-- ----------------------------------------------------------------------------
-- 2. Helper: pairwise H2H comparison for the leaderboard tier
-- ----------------------------------------------------------------------------
-- Returns  1 if A is ranked above B by their settled head-to-head,
--         -1 if B is above A, 0 if no settled H2H decides it.
-- Uses the canonical h2h_records (profile_a < profile_b) win counts.
create or replace function public.h2h_edge(p_league uuid, p_a uuid, p_b uuid)
returns integer
language sql stable
as $$
  with rec as (
    select a_wins, b_wins
    from public.h2h_records
    where league_id = p_league
      and profile_a = least(p_a, p_b)
      and profile_b = greatest(p_a, p_b)
  )
  select case
    when not exists (select 1 from rec) then 0
    else (
      select case
        -- normalise: a_wins belongs to least(p_a,p_b)
        when (least(p_a,p_b) = p_a) then sign(a_wins - b_wins)
        else sign(b_wins - a_wins)
      end
      from rec
    )
  end;
$$;
comment on function public.h2h_edge is
  'Pairwise leaderboard tie-break: +1 if A outranks B on their settled H2H record, -1 if B outranks A, 0 if undecided. Read-only helper.';

-- ----------------------------------------------------------------------------
-- 3. Replace refresh_standings with the full tie-break ranking
-- ----------------------------------------------------------------------------
create or replace function public.refresh_standings(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- (a) recompute the aggregate stats per player from daily_scores
  with agg as (
    select
      d.league_id,
      d.profile_id,
      round(sum(d.total_pts),1)                                   as total_pts,
      count(*) filter (where d.outcome <> 'no_pick')              as days_played,
      count(*) filter (where d.outcome = 'win')                   as wins,
      count(*) filter (where d.outcome = 'no_pick')               as no_picks,
      coalesce(max(d.total_pts),0)                                as best_day_pts,
      -- longest run of consecutive WIN days (gaps-and-islands on score_date)
      coalesce((
        select max(streak_len) from (
          select count(*) as streak_len
          from (
            select d2.score_date,
                   (d2.score_date
                     - (row_number() over (order by d2.score_date))::int) as grp
            from public.daily_scores d2
            where d2.league_id = d.league_id
              and d2.profile_id = d.profile_id
              and d2.outcome = 'win'
          ) g
          group by grp
        ) s
      ),0)                                                        as longest_streak,
      -- earliest moment the FINAL cumulative total was reached: the computed_at
      -- of the player's last points-adding day (latest day that changed total).
      max(d.computed_at) filter (where d.total_pts > 0)           as reached_total_at
    from public.daily_scores d
    where d.league_id = p_league_id
    group by d.league_id, d.profile_id
  )
  insert into public.standings as st
    (league_id, profile_id, total_pts, days_played, wins, no_picks,
     best_day_pts, longest_streak, reached_total_at, updated_at)
  select league_id, profile_id, total_pts, days_played, wins, no_picks,
         best_day_pts, longest_streak,
         coalesce(reached_total_at, now()), now()
  from agg
  on conflict (league_id, profile_id) do update
    set total_pts        = excluded.total_pts,
        days_played      = excluded.days_played,
        wins             = excluded.wins,
        no_picks         = excluded.no_picks,
        best_day_pts     = excluded.best_day_pts,
        longest_streak   = excluded.longest_streak,
        reached_total_at = excluded.reached_total_at,
        -- keep the live current_streak (managed by run_daily_scoring)
        updated_at       = now();

  -- (b) rank with the full ladder. We first build a provisional strict order
  -- using the EARNED tiers + the unique final decider (this is already a total
  -- order). Then we apply the pairwise H2H nudge between players who are equal
  -- on every earned tier, using h2h_edge as an additional sort key slotted at
  -- its proper priority. Because reached_total_at is unique, the final ORDER BY
  -- is always strict -> ranks are 1,2,3,4,... with no unresolved ties.
  with ordered as (
    select
      s.profile_id,
      row_number() over (
        order by
          s.total_pts        desc,   -- 1 points
          s.wins             desc,   -- 2 most wins
          -- 3 H2H is handled below as a correlated nudge; see note. We expose a
          --   per-row H2H "score" = net edge vs all players tied with them on
          --   (total_pts, wins). This keeps a single ORDER BY total + acyclic.
          (
            select coalesce(sum(public.h2h_edge(p_league_id, s.profile_id, t.profile_id)),0)
            from public.standings t
            where t.league_id = p_league_id
              and t.profile_id <> s.profile_id
              and t.total_pts = s.total_pts
              and t.wins      = s.wins
          )                  desc,   -- 3 head-to-head (net edge among co-tied)
          s.best_day_pts     desc,   -- 4 best single day
          s.longest_streak   desc,   -- 5 longest win streak
          s.days_played      desc,   -- 6 showed up most (fewest no-picks)
          s.reached_total_at asc,    -- 7 earliest to the total (unique decider)
          s.profile_id       asc     -- absolute last resort (stable, never hit in practice)
      ) as rnk
    from public.standings s
    where s.league_id = p_league_id
  )
  update public.standings s
    set rank = o.rnk
  from ordered o
  where s.league_id = p_league_id and s.profile_id = o.profile_id;
end $$;
comment on function public.refresh_standings is
  'Recomputes standings + ranks with the full tie-break ladder: points, wins, head-to-head, best day, longest streak, fewest no-picks, earliest-to-total (unique final decider). Produces a strict 1..N order.';

grant execute on function public.h2h_edge(uuid, uuid, uuid) to authenticated, service_role;
revoke execute on function public.refresh_standings(uuid) from public, anon, authenticated;
grant  execute on function public.refresh_standings(uuid) to service_role;

commit;
