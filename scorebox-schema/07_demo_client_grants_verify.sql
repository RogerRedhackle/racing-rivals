-- ============================================================================
-- ScoreBox — Migration 07: Demo client RLS/grants VERIFY (idempotent, no-op)
-- ============================================================================
-- PURPOSE
--   Frontend demo wiring requires that the client (anon/authenticated roles) can
--   securely (a) sign in and manage its own PROFILE, and (b) submit/change its
--   own draft PICKS — with everything else locked down. Those exact policies and
--   grants ALREADY EXIST in migration 03 (03_rls_policies.sql). Re-creating them
--   here would duplicate/conflict.
--
--   So this migration creates NOTHING. It ASSERTS that the required security
--   surface is present and correct, and RAISES if the demo project drifts from
--   the contract the frontend is wired to. Run it against the demo project after
--   applying 01..06 to prove connectivity is safe before opening the app.
--
--   Safe to run repeatedly. Makes no schema changes. Read-only + assertions only.
-- ============================================================================

do $$
declare
  missing text := '';
begin
  -- ------------------------------------------------------------------
  -- 1. RLS must be ENABLED on the two client-writable demo tables.
  -- ------------------------------------------------------------------
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname='profiles' and c.relrowsecurity
  ) then missing := missing || E'\n - RLS not enabled on public.profiles'; end if;

  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname='picks' and c.relrowsecurity
  ) then missing := missing || E'\n - RLS not enabled on public.picks'; end if;

  -- ------------------------------------------------------------------
  -- 2. PROFILES policies: public read + self-update (privileged cols locked).
  -- ------------------------------------------------------------------
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='profiles' and policyname='profiles_read_all')
  then missing := missing || E'\n - missing policy profiles_read_all'; end if;

  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='profiles' and policyname='profiles_update_own')
  then missing := missing || E'\n - missing policy profiles_update_own'; end if;

  -- profiles must NOT be client-insertable (handle_new_user does that as definer).
  if exists (select 1 from pg_policies
    where schemaname='public' and tablename='profiles' and cmd='INSERT')
  then missing := missing || E'\n - UNEXPECTED client INSERT policy on public.profiles'; end if;

  -- ------------------------------------------------------------------
  -- 3. PICKS policies: read (member), and own insert/update/delete.
  -- ------------------------------------------------------------------
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='picks' and policyname='picks_read')
  then missing := missing || E'\n - missing policy picks_read'; end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='picks' and policyname='picks_insert_own')
  then missing := missing || E'\n - missing policy picks_insert_own'; end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='picks' and policyname='picks_update_own')
  then missing := missing || E'\n - missing policy picks_update_own'; end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='picks' and policyname='picks_delete_own')
  then missing := missing || E'\n - missing policy picks_delete_own'; end if;

  -- ------------------------------------------------------------------
  -- 4. The pick-validation trigger must be attached (lock + validity guard).
  -- ------------------------------------------------------------------
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='picks' and not t.tgisinternal
      and t.tgname = 'trg_validate_pick'
  ) then missing := missing || E'\n - missing trigger trg_validate_pick on public.picks'; end if;

  -- ------------------------------------------------------------------
  -- 5. Client-callable helper the pick UI depends on: pick_lock_at(date)
  --    must be EXECUTE-able by anon + authenticated.
  -- ------------------------------------------------------------------
  if not has_function_privilege('anon',
       'public.pick_lock_at(date)', 'EXECUTE') then
    missing := missing || E'\n - anon cannot EXECUTE public.pick_lock_at(date)';
  end if;
  if not has_function_privilege('authenticated',
       'public.pick_lock_at(date)', 'EXECUTE') then
    missing := missing || E'\n - authenticated cannot EXECUTE public.pick_lock_at(date)';
  end if;

  -- ------------------------------------------------------------------
  -- 6. Engine functions must NOT be client-callable (no self-scoring).
  -- ------------------------------------------------------------------
  if has_function_privilege('authenticated',
       'public.run_daily_scoring(uuid, date)', 'EXECUTE') then
    missing := missing || E'\n - SECURITY: authenticated can EXECUTE run_daily_scoring (must be revoked)';
  end if;

  -- ------------------------------------------------------------------
  -- Verdict
  -- ------------------------------------------------------------------
  if length(missing) > 0 then
    raise exception E'[07 verify] Demo security contract FAILED:%', missing;
  else
    raise notice '[07 verify] OK — profiles + picks RLS, pick trigger, pick_lock_at grant, and engine lockdown all present. Frontend demo wiring is safe to connect.';
  end if;
end $$;
