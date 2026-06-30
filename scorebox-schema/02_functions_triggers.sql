-- ============================================================================
-- ScoreBox — Integrity Functions & Triggers
-- ============================================================================
-- These enforce the rules that make scoring tamper-proof:
--   * picks can only be written by their owner, BEFORE the lock time
--   * a pick must reference a runner racing on that competition day
--   * league size is capped at max_runners
--   * scores are recomputed from authoritative data by the engine only
-- All scoring/aggregation functions are SECURITY DEFINER and owned by a trusted
-- role; clients cannot invoke them to forge data (RLS blocks direct writes).
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 0. updated_at touch trigger (generic)
-- ----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger trg_picks_touch before update on public.picks
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------------
-- 1. PICK LOCK DEADLINE
-- ----------------------------------------------------------------------------
-- Rule (locked with Roger): the pick window opens 07:30 local each morning; a
-- player can change their pick until 12:30 OR 30 minutes before the first race
-- of the day, WHICHEVER IS EARLIER. We compute the deadline from authoritative
-- race off_times for that competition day's universe.
--
-- "Universe" = all races whose off_time falls on pick_date (server timezone is
-- assumed Europe/London; store off_time as timestamptz and compare in that tz).

create or replace function public.pick_lock_at(p_pick_date date)
returns timestamptz
language sql stable as $$
  with first_off as (
    select min(r.off_time) as first_race
    from public.races r
    where (r.off_time at time zone 'Europe/London')::date = p_pick_date
      and r.status <> 'void'
  )
  select least(
           -- 12:30 local on the pick date
           (p_pick_date::timestamp + time '12:30') at time zone 'Europe/London',
           -- 30 minutes before the first race (null-safe: if no race, far future)
           coalesce((select first_race from first_off), 'infinity'::timestamptz)
             - interval '30 minutes'
         );
$$;
comment on function public.pick_lock_at is
  'Authoritative pick deadline for a competition day: earlier of 12:30 local or 30 min before the first race. Used by the pick-write trigger; the client cannot override it.';

-- ----------------------------------------------------------------------------
-- 2. PICK VALIDATION TRIGGER  (the core integrity gate)
-- ----------------------------------------------------------------------------
create or replace function public.validate_pick()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lock        timestamptz;
  v_runner_date date;
  v_runner_status runner_status;
  v_is_member   boolean;
begin
  -- (a) caller must be the pick owner (defence-in-depth alongside RLS)
  if auth.uid() is distinct from new.profile_id then
    raise exception 'pick.profile_id must equal the authenticated user';
  end if;

  -- (b) caller must be an ACTIVE member of the league
  select exists(
    select 1 from public.league_members m
    where m.league_id = new.league_id
      and m.profile_id = new.profile_id
      and m.status = 'active'
  ) into v_is_member;
  if not v_is_member then
    raise exception 'not an active member of this league';
  end if;

  -- (c) the runner must be a real runner racing ON pick_date, and not a non-runner
  select (ra.off_time at time zone 'Europe/London')::date, ru.status
    into v_runner_date, v_runner_status
  from public.runners ru
  join public.races   ra on ra.id = ru.race_id
  where ru.id = new.runner_id;

  if v_runner_date is null then
    raise exception 'runner % does not exist', new.runner_id;
  end if;
  if v_runner_date <> new.pick_date then
    raise exception 'runner races on %, not on pick_date %', v_runner_date, new.pick_date;
  end if;
  if v_runner_status in ('non_runner','withdrawn') then
    raise exception 'runner is a non-runner / withdrawn';
  end if;

  -- (d) the lock must not have passed (applies to INSERT and UPDATE alike)
  v_lock := public.pick_lock_at(new.pick_date);
  if now() >= v_lock then
    raise exception 'pick window is locked for % (closed at %)', new.pick_date, v_lock;
  end if;

  return new;
end $$;

create trigger trg_validate_pick
  before insert or update on public.picks
  for each row execute function public.validate_pick();

-- Block deletes after lock too (so a player can't delete a pick to dodge a 0).
create or replace function public.block_locked_pick_delete()
returns trigger language plpgsql as $$
begin
  if now() >= public.pick_lock_at(old.pick_date) then
    raise exception 'cannot delete a pick after lock';
  end if;
  return old;
end $$;
create trigger trg_block_pick_delete
  before delete on public.picks
  for each row execute function public.block_locked_pick_delete();

-- ----------------------------------------------------------------------------
-- 3. LEAGUE SIZE CAP
-- ----------------------------------------------------------------------------
create or replace function public.enforce_league_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max   smallint;
  v_count integer;
begin
  if new.status <> 'active' then
    return new;
  end if;
  select max_runners into v_max from public.leagues where id = new.league_id;
  select count(*) into v_count
    from public.league_members
    where league_id = new.league_id and status = 'active'
      and profile_id <> new.profile_id;
  if v_count + 1 > v_max then
    raise exception 'league is full (% of % runners)', v_count, v_max;
  end if;
  return new;
end $$;

create trigger trg_league_cap
  before insert or update on public.league_members
  for each row execute function public.enforce_league_cap();

-- ----------------------------------------------------------------------------
-- 4. SCORING ENGINE (v2)  — the authoritative points calculator
-- ----------------------------------------------------------------------------
-- Recomputes ONE day's score for ONE pick from authoritative odds + result.
-- Never trusts client input. Mirrors the prototype's score() exactly:
--   base   : win  -> fractional-odds number (odds_num/odds_den)
--            place-> half of that, IF the runner placed (finish within places_paid)
--   fav    : +2 FLAT, WIN ONLY, only if the runner was NOT the favourite
--   streak : +1 per day from the 2nd consecutive winning day (computed by caller)
-- Returns the breakdown so the row can be written atomically.
--
-- Constants
create or replace function public.v2_constants()
returns table(place_frac numeric, fav_flat numeric, streak_flat numeric)
language sql immutable as $$ select 0.5::numeric, 2::numeric, 1::numeric $$;

create or replace function public.score_pick(p_pick_id uuid, p_streak_day smallint)
returns table(
  outcome          result_outcome,
  base_pts         numeric,
  fav_bonus_pts    numeric,
  streak_bonus_pts numeric,
  total_pts        numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  c            record;
  v_num        integer;
  v_den        integer;
  v_is_fav     boolean;
  v_kind       pick_kind;
  v_finish     smallint;
  v_void       boolean;
  v_places     smallint;
  v_win_base   numeric;
  v_base       numeric := 0;
  v_fav        numeric := 0;
  v_streak     numeric := 0;
  v_outcome    result_outcome;
begin
  select place_frac, fav_flat, streak_flat into c from public.v2_constants();

  -- pull authoritative odds + favourite flag + result for this pick's runner
  select ru.odds_num, ru.odds_den, ru.is_favourite, p.kind,
         rr.finish_pos, coalesce(rr.is_void,false), rc.places_paid
    into v_num, v_den, v_is_fav, v_kind, v_finish, v_void, v_places
  from public.picks p
  join public.runners ru on ru.id = p.runner_id
  join public.races   rc on rc.id = ru.race_id
  left join public.race_results rr on rr.runner_id = ru.id and rr.race_id = rc.id
  where p.id = p_pick_id;

  if v_void then
    return query select 'void'::result_outcome, 0::numeric,0::numeric,0::numeric,0::numeric;
    return;
  end if;

  v_win_base := v_num::numeric / v_den;     -- fractional-odds number (9/1 -> 9, 7/2 -> 3.5)

  -- The player's selection KIND decides how a finishing position pays
  -- (EACH-WAY style — a win bet earns a place consolation):
  --   kind='win'   : 1st  -> full win-base + fav-beater + streak (all win-only);
  --                  placed (2nd..Nth) -> HALF base consolation, NO bonuses;
  --                  unplaced -> 0.
  --   kind='place' : placed (1st..Nth) -> HALF base, no bonuses; else 0.
  -- Bonuses (fav-beater, streak) remain strictly WIN-ONLY in both cases.
  if v_kind = 'win' and v_finish = 1 then
    -- WIN selection, horse won -> full payout + bonuses
    v_outcome := 'win';
    v_base := round(v_win_base, 1);
    if not v_is_fav then                    -- +2 FLAT, WIN ONLY, non-favourite
      v_fav := c.fav_flat;
    end if;
    if p_streak_day >= 2 then               -- streak from day 2
      v_streak := c.streak_flat * (p_streak_day - 1);
    end if;
  elsif v_kind = 'win' and v_finish is not null and v_finish <= v_places then
    -- WIN selection, horse only PLACED -> half-base consolation, no bonuses
    v_outcome := 'place';
    v_base := round(v_win_base * c.place_frac, 1);
  elsif v_kind = 'place' and v_finish is not null and v_finish <= v_places then
    -- PLACE selection, horse placed (1st-Nth). Half base, no bonuses.
    v_outcome := 'place';
    v_base := round(v_win_base * c.place_frac, 1);
  else
    -- unplaced / DNF -> miss
    v_outcome := 'unplaced';
    v_base := 0;
  end if;

  return query
    select v_outcome,
           v_base,
           v_fav,
           round(v_streak,1),
           round(v_base + v_fav + round(v_streak,1), 1);
end $$;
comment on function public.score_pick is
  'Authoritative v2 scorer. Reads odds/favourite/result from the canonical tables only — never any client value. Beat-the-favourite is +2 flat, WIN ONLY (stress-tested decision).';

-- ----------------------------------------------------------------------------
-- 5. DAILY SCORING PASS  — resolves a whole league-day, sets streaks + standings
-- ----------------------------------------------------------------------------
-- Call this once a competition day's races are all resulted. It:
--   * computes each member's streak_day from their prior consecutive wins,
--   * scores every pick (and writes a no_pick 0 row for members who didn't pick),
--   * upserts daily_scores, then refreshes standings.
create or replace function public.run_daily_scoring(p_league_id uuid, p_date date)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m            record;
  s            record;
  v_prev_streak smallint;
  v_streak_day  smallint;
  v_pick_id    uuid;
begin
  for m in
    select profile_id from public.league_members
    where league_id = p_league_id and status = 'active'
  loop
    -- prior consecutive winning days up to (but not including) p_date
    select current_streak into v_prev_streak
      from public.standings
      where league_id = p_league_id and profile_id = m.profile_id;
    v_prev_streak := coalesce(v_prev_streak, 0);

    select id into v_pick_id from public.picks
      where league_id = p_league_id and profile_id = m.profile_id and pick_date = p_date;

    if v_pick_id is null then
      -- NO PICK: 0 points, streak resets (Roger's "no pick = no score" rule)
      insert into public.daily_scores
        (league_id, profile_id, pick_id, score_date, outcome,
         base_pts, fav_bonus_pts, streak_day, streak_bonus_pts, total_pts)
      values (p_league_id, m.profile_id, null, p_date, 'no_pick', 0,0,0,0,0)
      on conflict (league_id, profile_id, score_date) do update
        set outcome='no_pick', base_pts=0, fav_bonus_pts=0, streak_day=0,
            streak_bonus_pts=0, total_pts=0, computed_at=now();
      update public.standings set current_streak = 0
        where league_id = p_league_id and profile_id = m.profile_id;
      continue;
    end if;

    -- provisional streak_day if this turns out to be a win
    v_streak_day := v_prev_streak + 1;

    select * into s from public.score_pick(v_pick_id, v_streak_day);

    -- if it wasn't a win, streak_day is meaningless -> store 0
    if s.outcome <> 'win' then v_streak_day := 0; end if;

    insert into public.daily_scores
      (league_id, profile_id, pick_id, score_date, outcome,
       base_pts, fav_bonus_pts, streak_day, streak_bonus_pts, total_pts)
    values (p_league_id, m.profile_id, v_pick_id, p_date, s.outcome,
            s.base_pts, s.fav_bonus_pts, v_streak_day, s.streak_bonus_pts, s.total_pts)
    on conflict (league_id, profile_id, score_date) do update
      set outcome=excluded.outcome, base_pts=excluded.base_pts,
          fav_bonus_pts=excluded.fav_bonus_pts, streak_day=excluded.streak_day,
          streak_bonus_pts=excluded.streak_bonus_pts, total_pts=excluded.total_pts,
          computed_at=now();

    -- update running streak: win -> +1, anything else -> 0
    update public.standings
      set current_streak = case when s.outcome = 'win' then v_streak_day else 0 end
      where league_id = p_league_id and profile_id = m.profile_id;
  end loop;

  perform public.refresh_standings(p_league_id);
end $$;

-- ----------------------------------------------------------------------------
-- 6. REFRESH STANDINGS  (recompute totals + ranks from daily_scores)
-- ----------------------------------------------------------------------------
create or replace function public.refresh_standings(p_league_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.standings (league_id, profile_id, total_pts, days_played, wins, current_streak, updated_at)
  select d.league_id, d.profile_id,
         round(sum(d.total_pts),1),
         count(*) filter (where d.outcome <> 'no_pick'),
         count(*) filter (where d.outcome = 'win'),
         coalesce(max(st.current_streak),0),
         now()
  from public.daily_scores d
  left join public.standings st
    on st.league_id = d.league_id and st.profile_id = d.profile_id
  where d.league_id = p_league_id
  group by d.league_id, d.profile_id
  on conflict (league_id, profile_id) do update
    set total_pts = excluded.total_pts,
        days_played = excluded.days_played,
        wins = excluded.wins,
        updated_at = now();

  -- rank by total desc (ties share read-order; refine with tie-breaks later)
  with ranked as (
    select profile_id,
           rank() over (order by total_pts desc) as rnk
    from public.standings where league_id = p_league_id
  )
  update public.standings s set rank = r.rnk
  from ranked r
  where s.league_id = p_league_id and s.profile_id = r.profile_id;
end $$;

-- ----------------------------------------------------------------------------
-- 7. SETTLE A H2H CHALLENGE  (engine-written outcome + record update)
-- ----------------------------------------------------------------------------
create or replace function public.settle_challenge(p_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  ch          record;
  v_cp        numeric;
  v_op        numeric;
  v_winner    uuid;
  v_margin    numeric;
  v_a         uuid;
  v_b         uuid;
begin
  select * into ch from public.h2h_challenges where id = p_challenge_id;
  if ch.status not in ('active','pending') then
    raise exception 'challenge already settled';
  end if;

  select coalesce(sum(total_pts),0) into v_cp from public.daily_scores
    where league_id = ch.league_id and profile_id = ch.challenger_id
      and score_date between ch.starts_on and ch.ends_on;
  select coalesce(sum(total_pts),0) into v_op from public.daily_scores
    where league_id = ch.league_id and profile_id = ch.opponent_id
      and score_date between ch.starts_on and ch.ends_on;

  v_margin := abs(v_cp - v_op);
  if v_cp > v_op then v_winner := ch.challenger_id;
  elsif v_op > v_cp then v_winner := ch.opponent_id;
  else v_winner := null; end if;   -- draw

  update public.h2h_challenges
    set challenger_pts = v_cp, opponent_pts = v_op, winner_id = v_winner,
        status = (case when v_winner is null then 'drawn'
                       when v_winner = ch.challenger_id then 'won' else 'lost' end)::challenge_status,
        settled_at = now()
    where id = p_challenge_id;

  -- update the canonical season record (profile_a < profile_b)
  v_a := least(ch.challenger_id, ch.opponent_id);
  v_b := greatest(ch.challenger_id, ch.opponent_id);
  insert into public.h2h_records (league_id, profile_a, profile_b, a_wins, b_wins, draws, biggest_margin)
  values (ch.league_id, v_a, v_b,
          case when v_winner = v_a then 1 else 0 end,
          case when v_winner = v_b then 1 else 0 end,
          case when v_winner is null then 1 else 0 end,
          v_margin)
  on conflict (league_id, profile_a, profile_b) do update
    set a_wins = public.h2h_records.a_wins + case when v_winner = v_a then 1 else 0 end,
        b_wins = public.h2h_records.b_wins + case when v_winner = v_b then 1 else 0 end,
        draws  = public.h2h_records.draws  + case when v_winner is null then 1 else 0 end,
        biggest_margin = greatest(public.h2h_records.biggest_margin, v_margin),
        updated_at = now();
end $$;

-- ----------------------------------------------------------------------------
-- 8. NEW USER HOOK  (create a profile row when an auth user signs up)
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    'user_' || substr(replace(new.id::text,'-',''),1,12),
    coalesce(new.raw_user_meta_data->>'display_name', 'New Runner')
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

commit;
