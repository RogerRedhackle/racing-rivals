-- ============================================================================
-- 06_ingest.sql  —  Racing-data ingest layer  🟥 PACK (racing)
-- ----------------------------------------------------------------------------
-- The trusted write path that turns a racing feed into the rows the ENGINE
-- scores: meetings → races → runners (with SP + favourite) → race_results.
--
-- Design rules (all enforced here, none trusted to the worker):
--   • IDEMPOTENT — re-running the same feed pull never duplicates or corrupts.
--     Every RPC upserts on the schema's natural keys, so a card polled every
--     5 min and a result posted twice both converge to one state.
--   • SERVICE_ROLE ONLY — execute revoked from public/anon/authenticated and
--     granted only to service_role (same discipline as the scoring engine).
--   • CONSTRAINT-SAFE — respects one-favourite-per-race, one-runner-per-finish,
--     the generated decimal_odds column, and the event_status state machine.
--   • NON-DESTRUCTIVE TO PICKS — re-ingesting a card never deletes runners that
--     players may have picked; a runner that drops out is marked 'non_runner',
--     not removed (a delete would orphan a pick / dodge a void).
--
-- The worker (TS) only ever calls these RPCs with a normalised payload; it
-- never issues raw INSERT/UPDATE. Integrity logic stays in one place (the DB)
-- and any provider adapter can feed the same contract.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. INGEST AUDIT LOG  (mirror of scoring_runs, for the write side)
-- ----------------------------------------------------------------------------
create table if not exists public.ingest_runs (
  id          bigint generated always as identity primary key,
  kind        text not null,   -- 'meeting'|'race_card'|'favourite'|'result'|'race_status'
  provider    text,
  ref         text,
  race_id     uuid,
  status      text not null,   -- 'ok'|'noop'|'error'
  detail      text,
  ran_at      timestamptz not null default now()
);
create index if not exists idx_ingest_runs_ran  on public.ingest_runs (ran_at desc);
create index if not exists idx_ingest_runs_race on public.ingest_runs (race_id);
alter table public.ingest_runs enable row level security;
-- (no client policies: service_role only)

-- ----------------------------------------------------------------------------
-- 1. UPSERT A MEETING  (natural key: course + meeting_date)
-- ----------------------------------------------------------------------------
create or replace function public.ingest_meeting(
  p_course        text,
  p_meeting_date  date,
  p_going         text default null,
  p_festival_slug text default null,
  p_provider      text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meeting_id uuid;
  v_fest_id    uuid;
begin
  if p_festival_slug is not null then
    select id into v_fest_id from public.festivals where slug = p_festival_slug;
  end if;

  insert into public.meetings (course, meeting_date, going, festival_id)
  values (p_course, p_meeting_date, p_going, v_fest_id)
  on conflict (course, meeting_date) do update
    set going       = coalesce(excluded.going, public.meetings.going),
        festival_id = coalesce(excluded.festival_id, public.meetings.festival_id)
  returning id into v_meeting_id;

  insert into public.ingest_runs(kind, provider, ref, status, detail)
  values ('meeting', p_provider, p_course||' '||p_meeting_date, 'ok', 'upserted');
  return v_meeting_id;
end $$;

-- ----------------------------------------------------------------------------
-- 2. UPSERT A RACE  (natural key: meeting_id + race_no; status NOT touched here)
-- ----------------------------------------------------------------------------
create or replace function public.ingest_race(
  p_meeting_id  uuid,
  p_race_no     smallint,
  p_name        text,
  p_off_time    timestamptz,
  p_distance    text default null,
  p_race_class  text default null,
  p_places_paid smallint default null,
  p_provider    text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_race_id uuid;
begin
  insert into public.races (meeting_id, race_no, name, off_time, distance, race_class, places_paid)
  values (p_meeting_id, p_race_no, p_name, p_off_time, p_distance, p_race_class,
          coalesce(p_places_paid, 3))
  on conflict (meeting_id, race_no) do update
    set name        = excluded.name,
        off_time    = excluded.off_time,
        distance    = coalesce(excluded.distance, public.races.distance),
        race_class  = coalesce(excluded.race_class, public.races.race_class),
        places_paid = case when p_places_paid is not null then p_places_paid
                           else public.races.places_paid end
    -- status intentionally NOT touched here; use set_race_status().
  returning id into v_race_id;

  insert into public.ingest_runs(kind, provider, ref, race_id, status, detail)
  values ('race_card', p_provider, p_name, v_race_id, 'ok', 'race upserted');
  return v_race_id;
end $$;

-- ----------------------------------------------------------------------------
-- 3. RECONCILE THE FULL RUNNER FIELD  (upsert + NRs + exactly one favourite)
-- ----------------------------------------------------------------------------
-- Each element: { cloth_no, horse_name, jockey, trainer,
--                 odds_num, odds_den, is_favourite, status }
create or replace function public.ingest_runners(
  p_race_id  uuid,
  p_runners  jsonb,
  p_provider text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r           jsonb;
  v_seen      smallint[] := '{}';
  v_count     int := 0;
  v_fav_cloth smallint;
  v_min_dec   numeric;
begin
  if jsonb_typeof(p_runners) <> 'array' then
    raise exception 'p_runners must be a jsonb array';
  end if;

  -- (a) upsert every runner in the payload
  for r in select * from jsonb_array_elements(p_runners) loop
    insert into public.runners (
      race_id, cloth_no, horse_name, jockey, trainer, odds_num, odds_den, status
    )
    values (
      p_race_id,
      (r->>'cloth_no')::smallint,
      r->>'horse_name',
      r->>'jockey',
      r->>'trainer',
      nullif(r->>'odds_num','')::int,
      nullif(r->>'odds_den','')::int,
      coalesce((r->>'status')::runner_status, 'runner')
    )
    on conflict (race_id, cloth_no) do update
      set horse_name = excluded.horse_name,
          jockey     = coalesce(excluded.jockey, public.runners.jockey),
          trainer    = coalesce(excluded.trainer, public.runners.trainer),
          odds_num   = excluded.odds_num,
          odds_den   = excluded.odds_den,
          status     = excluded.status;

    v_seen  := v_seen || (r->>'cloth_no')::smallint;
    v_count := v_count + 1;
  end loop;

  -- (b) runners previously present but absent now → non_runner (never delete)
  update public.runners
     set status = 'non_runner'
   where race_id = p_race_id
     and cloth_no <> all (v_seen)
     and status <> 'non_runner';

  -- (c) favourite: clear all first (satisfies partial unique index), then set one
  update public.runners set is_favourite = false
   where race_id = p_race_id and is_favourite;

  -- explicit flag from the feed wins (first flagged active runner)
  select cloth_no into v_fav_cloth
    from public.runners ru
   where ru.race_id = p_race_id
     and ru.status in ('declared','runner')
     and exists (
       select 1 from jsonb_array_elements(p_runners) e
       where (e->>'cloth_no')::smallint = ru.cloth_no
         and coalesce((e->>'is_favourite')::boolean, false)
     )
   order by ru.cloth_no
   limit 1;

  -- else derive: shortest decimal odds among active runners
  if v_fav_cloth is null then
    select min(decimal_odds) into v_min_dec
      from public.runners
     where race_id = p_race_id
       and status in ('declared','runner')
       and decimal_odds is not null;
    if v_min_dec is not null then
      select cloth_no into v_fav_cloth
        from public.runners
       where race_id = p_race_id
         and status in ('declared','runner')
         and decimal_odds = v_min_dec
       order by cloth_no
       limit 1;   -- ties: lowest cloth_no, deterministic
    end if;
  end if;

  if v_fav_cloth is not null then
    update public.runners set is_favourite = true
     where race_id = p_race_id and cloth_no = v_fav_cloth;
  end if;

  insert into public.ingest_runs(kind, provider, race_id, status, detail)
  values ('race_card', p_provider, p_race_id, 'ok',
          v_count||' runners; fav cloth '||coalesce(v_fav_cloth::text,'none'));
  return v_count;
end $$;

-- ----------------------------------------------------------------------------
-- 4. ADVANCE A RACE'S STATUS  (forward-only state machine)
-- ----------------------------------------------------------------------------
-- scheduled → open → locked → resulted ; (any) → void ; resulted→void allowed.
create or replace function public.set_race_status(
  p_race_id  uuid,
  p_status   event_status,
  p_provider text default null
)
returns event_status
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cur  event_status;
  v_rank int;
  v_new  int;
  rk     constant jsonb := '{"scheduled":0,"open":1,"locked":2,"resulted":3,"void":3}';
begin
  select status into v_cur from public.races where id = p_race_id;
  if v_cur is null then raise exception 'race % not found', p_race_id; end if;

  if v_cur = p_status then
    return v_cur;  -- idempotent no-op
  end if;

  v_rank := (rk->>(v_cur::text))::int;
  v_new  := (rk->>(p_status::text))::int;

  if v_new < v_rank and not (v_cur = 'resulted' and p_status = 'void') then
    raise exception 'illegal status transition % -> %', v_cur, p_status;
  end if;

  update public.races set status = p_status where id = p_race_id;

  insert into public.ingest_runs(kind, provider, race_id, status, detail)
  values ('race_status', p_provider, p_race_id, 'ok', v_cur||' -> '||p_status);
  return p_status;
end $$;

-- ----------------------------------------------------------------------------
-- 5. APPLY THE RESULT  (finishing order + optional closing SP) and RESULT it
-- ----------------------------------------------------------------------------
-- Each placing: { cloth_no, finish_pos (null=unplaced/DNF), is_void }
-- p_void_race=true voids the whole race. p_final_odds optionally locks closing
-- SP per cloth_no so the v2 base uses real SP, not the morning price.
create or replace function public.apply_result(
  p_race_id    uuid,
  p_placings   jsonb,
  p_void_race  boolean default false,
  p_final_odds jsonb default null,   -- [{cloth_no,odds_num,odds_den}]
  p_provider   text default null
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  e        jsonb;
  o        jsonb;
  v_runner uuid;
  v_count  int := 0;
begin
  if jsonb_typeof(p_placings) <> 'array' then
    raise exception 'p_placings must be a jsonb array';
  end if;

  -- (a) lock closing SP first, if provided
  if p_final_odds is not null then
    for o in select * from jsonb_array_elements(p_final_odds) loop
      update public.runners
         set odds_num = nullif(o->>'odds_num','')::int,
             odds_den = nullif(o->>'odds_den','')::int
       where race_id = p_race_id
         and cloth_no = (o->>'cloth_no')::smallint;
    end loop;
  end if;

  -- (b) clear any prior result (idempotent re-apply / correction)
  delete from public.race_results where race_id = p_race_id;

  if p_void_race then
    insert into public.race_results (race_id, runner_id, finish_pos, is_void)
    select p_race_id, id, null, true
      from public.runners
     where race_id = p_race_id and status in ('runner','declared');
    update public.races set status = 'void' where id = p_race_id;
    insert into public.ingest_runs(kind, provider, race_id, status, detail)
    values ('result', p_provider, p_race_id, 'ok', 'race voided');
    return 0;
  end if;

  -- (c) write each placing, resolving cloth_no → runner_id
  for e in select * from jsonb_array_elements(p_placings) loop
    select id into v_runner
      from public.runners
     where race_id = p_race_id and cloth_no = (e->>'cloth_no')::smallint;
    if v_runner is null then
      raise exception 'result references unknown cloth_no % in race %',
        e->>'cloth_no', p_race_id;
    end if;

    insert into public.race_results (race_id, runner_id, finish_pos, is_void)
    values (p_race_id, v_runner,
            nullif(e->>'finish_pos','')::smallint,
            coalesce((e->>'is_void')::boolean, false));
    v_count := v_count + 1;
  end loop;

  -- (d) flip the race to resulted — the readiness signal the ENGINE gates on
  update public.races set status = 'resulted' where id = p_race_id;

  insert into public.ingest_runs(kind, provider, race_id, status, detail)
  values ('result', p_provider, p_race_id, 'ok', v_count||' placings; resulted');
  return v_count;
end $$;

-- ----------------------------------------------------------------------------
-- 6. PERMISSIONS  (service_role only — same lockdown as the scoring engine)
-- ----------------------------------------------------------------------------
revoke all on function public.ingest_meeting(text,date,text,text,text)            from public;
revoke all on function public.ingest_race(uuid,smallint,text,timestamptz,text,text,smallint,text) from public;
revoke all on function public.ingest_runners(uuid,jsonb,text)                     from public;
revoke all on function public.set_race_status(uuid,event_status,text)             from public;
revoke all on function public.apply_result(uuid,jsonb,boolean,jsonb,text)         from public;

grant execute on function public.ingest_meeting(text,date,text,text,text)            to service_role;
grant execute on function public.ingest_race(uuid,smallint,text,timestamptz,text,text,smallint,text) to service_role;
grant execute on function public.ingest_runners(uuid,jsonb,text)                     to service_role;
grant execute on function public.set_race_status(uuid,event_status,text)             to service_role;
grant execute on function public.apply_result(uuid,jsonb,boolean,jsonb,text)         to service_role;

comment on function public.ingest_meeting  is 'Ingest: idempotent upsert of a meeting by (course, meeting_date). service_role only.';
comment on function public.ingest_race     is 'Ingest: idempotent upsert of a race by (meeting_id, race_no); never moves status backwards. service_role only.';
comment on function public.ingest_runners  is 'Ingest: reconcile the whole runner field for a race (upsert, mark NRs, set exactly one favourite). service_role only.';
comment on function public.set_race_status is 'Ingest: forward-only race status machine (scheduled->open->locked->resulted; ->void). service_role only.';
comment on function public.apply_result    is 'Ingest: write finishing order + optional closing SP and set race resulted (or void). Idempotent. service_role only.';

-- ============================================================================
-- END 06_ingest.sql
-- ============================================================================
