-- ============================================================================
-- ScoreBox — Row-Level Security (RLS) Policies
-- ============================================================================
-- The fourth and strongest integrity wall. Supabase exposes the DB to clients
-- via the `authenticated` and `anon` roles (PostgREST). RLS decides what those
-- roles may read/write. The `service_role` key (used only by your backend /
-- edge functions / data-ingest jobs) BYPASSES RLS — that is the ONLY path that
-- may write racing data, results, scores, standings and H2H outcomes.
--
-- SUMMARY OF WHO CAN WRITE WHAT
--   profiles         : owner may update own non-privileged columns
--   festivals/meetings/races/runners/race_results : service_role ONLY (clients read)
--   leagues          : creator can create; members read; service_role manages status
--   league_members   : self-join / self-leave; read within own leagues
--   picks            : owner INSERT/UPDATE own row (trigger also enforces lock)
--   daily_scores     : service_role ONLY (clients read own + leaguemates')
--   standings        : service_role ONLY (clients read)
--   h2h_*            : challengers create; service_role settles
--   chat/reactions   : members write own; soft-moderation by service_role
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- BASE GRANTS (Supabase normally applies these; included so the model is
-- self-contained and RLS — not missing grants — is what enforces access).
-- The client roles get table-level DML; RLS policies below then filter rows.
-- service_role bypasses RLS entirely (your backend / ingest / engine path).
-- ----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- CRITICAL: functions default to EXECUTE for PUBLIC. Revoke that first, so the
-- scoring/settlement engine is NOT callable by clients via the PUBLIC grant.
alter default privileges in schema public revoke execute on functions from public;
revoke execute on all functions in schema public from public;

-- Enable RLS on every public table (deny-by-default once enabled).
alter table public.profiles        enable row level security;
alter table public.festivals       enable row level security;
alter table public.meetings        enable row level security;
alter table public.races           enable row level security;
alter table public.runners         enable row level security;
alter table public.leagues         enable row level security;
alter table public.league_members  enable row level security;
alter table public.picks           enable row level security;
alter table public.race_results    enable row level security;
alter table public.daily_scores    enable row level security;
alter table public.standings       enable row level security;
alter table public.h2h_challenges  enable row level security;
alter table public.h2h_records     enable row level security;
alter table public.chat_messages   enable row level security;
alter table public.message_reports enable row level security;
alter table public.user_mutes      enable row level security;
alter table public.pick_reactions  enable row level security;

-- Helper: is the current user an active member of a league?
create or replace function public.is_member(p_league uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.league_members
    where league_id = p_league and profile_id = auth.uid() and status = 'active'
  );
$$;

-- ----------------------------------------------------------------------------
-- PROFILES
-- ----------------------------------------------------------------------------
create policy profiles_read_all on public.profiles
  for select using (true);                 -- profiles are public (handle/name/avatar)

create policy profiles_update_own on public.profiles
  for update using (id = auth.uid())
  with check (
    id = auth.uid()
    -- prevent self-elevation: privileged columns must keep their stored value.
    and is_admin = (select is_admin from public.profiles where id = auth.uid())
    and kyc_status = (select kyc_status from public.profiles where id = auth.uid())
    and age_verified = (select age_verified from public.profiles where id = auth.uid())
  );
-- NOTE: profiles INSERT is done by handle_new_user() (SECURITY DEFINER) only.

-- ----------------------------------------------------------------------------
-- RACING DATA  — read-only to clients; writes via service_role only
-- ----------------------------------------------------------------------------
create policy festivals_read on public.festivals for select using (true);
create policy meetings_read  on public.meetings  for select using (true);
create policy races_read     on public.races     for select using (true);
-- Runners: visible, BUT do not leak the result before it happens — the racecard
-- is public; results live in race_results which is gated below.
create policy runners_read   on public.runners   for select using (true);
-- (No INSERT/UPDATE/DELETE policies => clients cannot write. service_role bypasses RLS.)

-- ----------------------------------------------------------------------------
-- RACE RESULTS  — readable only AFTER the race is resulted (no early peeking)
-- ----------------------------------------------------------------------------
create policy results_read_after_off on public.race_results
  for select using (
    exists (select 1 from public.races r
            where r.id = race_results.race_id and r.status = 'resulted')
  );
-- writes: service_role only (no client write policy).

-- ----------------------------------------------------------------------------
-- LEAGUES & MEMBERSHIP
-- ----------------------------------------------------------------------------
create policy leagues_read on public.leagues
  for select using (public.is_member(id) or status = 'forming');
create policy leagues_create on public.leagues
  for insert with check (created_by = auth.uid());
-- league status transitions (forming->live->settled) are service_role only.

create policy members_read on public.league_members
  for select using (public.is_member(league_id));
create policy members_join on public.league_members
  for insert with check (profile_id = auth.uid());     -- self-join (cap trigger applies)
create policy members_leave on public.league_members
  for update using (profile_id = auth.uid())
  with check (profile_id = auth.uid() and status in ('left'));  -- can only mark self 'left'

-- ----------------------------------------------------------------------------
-- PICKS  — the only freely client-writable game table (trigger enforces lock)
-- ----------------------------------------------------------------------------
create policy picks_read on public.picks
  for select using (public.is_member(league_id));        -- leaguemates can see picks...
-- (UI hides others' picks pre-deadline; the post-deadline reveal is an app concern.
--  If you want DB-level hiding too, add a view that nulls runner_id before lock.)

create policy picks_insert_own on public.picks
  for insert with check (profile_id = auth.uid());
create policy picks_update_own on public.picks
  for update using (profile_id = auth.uid())
  with check (profile_id = auth.uid());
create policy picks_delete_own on public.picks
  for delete using (profile_id = auth.uid());
-- (validate_pick + block_locked_pick_delete triggers enforce lock-time + validity.)

-- ----------------------------------------------------------------------------
-- SCORES & STANDINGS  — READ-ONLY to clients. No write policy = no client write.
-- ----------------------------------------------------------------------------
create policy scores_read on public.daily_scores
  for select using (public.is_member(league_id));
create policy standings_read on public.standings
  for select using (public.is_member(league_id));
-- ALL writes to daily_scores / standings happen only via the scoring engine
-- (SECURITY DEFINER functions invoked by service_role). This is what guarantees
-- a player can never set their own points.

-- ----------------------------------------------------------------------------
-- HEAD-TO-HEAD
-- ----------------------------------------------------------------------------
create policy h2h_read on public.h2h_challenges
  for select using (public.is_member(league_id));
create policy h2h_create on public.h2h_challenges
  for insert with check (
    challenger_id = auth.uid()
    and public.is_member(league_id)
    and status = 'pending'
    -- challenger may only create with neutral/unset outcome columns
    and challenger_pts is null and opponent_pts is null and winner_id is null
  );
-- accept/decline could be an opponent UPDATE restricted to status only; settle &
-- outcome columns are service_role only (settle_challenge()).
create policy h2h_respond on public.h2h_challenges
  for update using (opponent_id = auth.uid())
  with check (opponent_id = auth.uid() and status in ('active','cancelled'));

create policy h2h_records_read on public.h2h_records
  for select using (public.is_member(league_id));
-- h2h_records writes: service_role only (settle_challenge()).

-- ----------------------------------------------------------------------------
-- SOCIAL
-- ----------------------------------------------------------------------------
create policy chat_read on public.chat_messages
  for select using (public.is_member(league_id) and not is_hidden);
create policy chat_post on public.chat_messages
  for insert with check (profile_id = auth.uid() and public.is_member(league_id));
-- is_hidden flips only via service_role (moderation). Author may delete own:
create policy chat_delete_own on public.chat_messages
  for delete using (profile_id = auth.uid());

create policy reports_create on public.message_reports
  for insert with check (reporter_id = auth.uid());
create policy reports_read_own on public.message_reports
  for select using (reporter_id = auth.uid());

create policy mutes_all on public.user_mutes
  for all using (muter_id = auth.uid()) with check (muter_id = auth.uid());

create policy reactions_read on public.pick_reactions
  for select using (true);
create policy reactions_write on public.pick_reactions
  for all using (profile_id = auth.uid()) with check (profile_id = auth.uid());

-- ----------------------------------------------------------------------------
-- LOCK DOWN FUNCTION EXECUTION
-- ----------------------------------------------------------------------------
-- The scoring/settlement engine must NOT be callable by clients (only by your
-- backend via service_role). Revoke EXECUTE from anon/authenticated.
-- (PUBLIC execute was already revoked at the top of this file, which closes the
--  inheritance hole. We re-state per-engine revokes explicitly for clarity and
--  grant execute ONLY to service_role.)
revoke execute on function public.run_daily_scoring(uuid, date)  from anon, authenticated, public;
revoke execute on function public.refresh_standings(uuid)        from anon, authenticated, public;
revoke execute on function public.settle_challenge(uuid)         from anon, authenticated, public;
revoke execute on function public.score_pick(uuid, smallint)     from anon, authenticated, public;
grant  execute on function public.run_daily_scoring(uuid, date)  to service_role;
grant  execute on function public.refresh_standings(uuid)        to service_role;
grant  execute on function public.settle_challenge(uuid)         to service_role;
grant  execute on function public.score_pick(uuid, smallint)     to service_role;
-- pick_lock_at + is_member are safe read-only helpers — expose to clients.
grant  execute on function public.pick_lock_at(date)             to anon, authenticated, service_role;
grant  execute on function public.is_member(uuid)                to authenticated, service_role;
grant  execute on function public.v2_constants()                 to authenticated, service_role;

commit;
