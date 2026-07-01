-- ============================================================================
-- 08_realtime_publication.sql  —  Realtime publication for the leaderboard  🟩 CORE
-- ----------------------------------------------------------------------------
-- Adds the two ENGINE-written, member-gated tables the League screen renders
-- live from — public.standings and public.daily_scores — to the Supabase
-- Realtime publication so clients get postgres_changes payloads the moment the
-- scoring engine writes a new day.
--
-- Design rules:
--   • IDEMPOTENT — safe to run on a fresh DB (create the publication) AND on a
--     Supabase project where `supabase_realtime` already exists (add tables
--     only if not already members). Re-running is a no-op.
--   • READ-ONLY DELIVERY — being in the publication does not grant any write
--     path. RLS still gates every row the client sees: standings_read /
--     scores_read both `using (public.is_member(league_id))` (03_rls_policies).
--     A non-member's channel simply receives nothing for that league.
--   • FULL UPDATE PAYLOADS — standings rows are UPDATEd in place every scoring
--     run (same PK (league_id, profile_id), new total_pts/rank). Default
--     REPLICA IDENTITY (the primary key) is sufficient to identify the changed
--     row, so the client's postgres_changes filter `league_id=eq.<id>` matches
--     on both INSERT and UPDATE. We leave replica identity at the PK default;
--     we do NOT set FULL (it would bloat WAL for no client benefit here — the
--     client refetches the authoritative ordered slice on any change anyway).
--
-- Depends on: 01_schema.sql (tables), 03_rls_policies.sql (RLS + is_member).
-- ============================================================================

-- 1. Ensure the publication exists (Supabase ships it; a bare Postgres does not).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Empty publication; tables are added explicitly below. `publish` defaults
    -- to insert,update,delete,truncate which is what Realtime expects.
    create publication supabase_realtime;
  end if;
end
$$;

-- 2. Add public.standings to the publication if not already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'standings'
  ) then
    alter publication supabase_realtime add table public.standings;
  end if;
end
$$;

-- 3. Add public.daily_scores to the publication if not already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'daily_scores'
  ) then
    alter publication supabase_realtime add table public.daily_scores;
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- Verification (run manually; not part of the migration effect):
--   select schemaname, tablename
--   from pg_publication_tables
--   where pubname = 'supabase_realtime' and schemaname = 'public'
--   order by tablename;
-- Expect: daily_scores, standings (plus any others already published).
-- ----------------------------------------------------------------------------
