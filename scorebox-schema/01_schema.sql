-- ============================================================================
-- ScoreBox / Racing Rivals — Production Database Schema (PostgreSQL / Supabase)
-- ============================================================================
-- Version:  1.0  (30 Jun 2026)
-- Engine:   PostgreSQL 15+ (Supabase)
-- Scoring:  v2  (Win = fractional-odds number; Place = half; beat-the-favourite
--                = +2 flat, WIN ONLY; win-streak = +1/day from day 2; no cap)
--
-- DESIGN PRINCIPLE — SERVER-SIDE SCORING INTEGRITY
-- ------------------------------------------------------------------------------
-- The database is the source of truth and the only thing that may write scores.
-- Clients (the app) may ONLY: read public data, and INSERT/UPDATE their own pick
-- BEFORE the lock time. Everything else — odds, results, scores, H2H records,
-- streaks — is written exclusively by SECURITY DEFINER functions / triggers that
-- the client cannot call to forge data. This is enforced four ways:
--   (1) CHECK / FK / UNIQUE / EXCLUSION constraints (data can't be malformed),
--   (2) triggers that reject pick writes after lock and validate the runner,
--   (3) the scoring function recomputes points from authoritative odds+result
--       (never trusts any client-supplied points),
--   (4) Row-Level Security: no client role can write to scoring tables at all.
-- ============================================================================

begin;

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "btree_gist";  -- EXCLUSION constraints

-- ============================================================================
-- 0. ENUMS
-- ============================================================================

create type competition_mode as enum ('day', 'festival', 'season');
create type league_status     as enum ('forming', 'live', 'settled', 'archived');
create type member_status     as enum ('active', 'left', 'removed');
create type event_status       as enum ('scheduled', 'open', 'locked', 'resulted', 'void');
create type runner_status      as enum ('declared', 'runner', 'non_runner', 'withdrawn');
create type pick_kind          as enum ('win', 'place');   -- the player's selection type
create type result_outcome     as enum ('win', 'place', 'unplaced', 'void', 'no_pick');
create type challenge_status    as enum ('pending', 'active', 'won', 'lost', 'drawn', 'cancelled');

-- ============================================================================
-- 1. IDENTITY  (extends Supabase auth.users)
-- ============================================================================
-- auth.users is managed by Supabase Auth (handles email/OAuth, and — when you
-- go real-money — links to your KYC/age-verification provider). We mirror only
-- profile data here. profiles.id == auth.users.id (1:1).

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text not null unique
                  check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name  text not null check (char_length(display_name) between 1 and 40),
  avatar_seed   text,                       -- drives the generated avatar tile
  -- Compliance flags (real-money readiness; UKGC). Defaults = not yet verified.
  age_verified  boolean not null default false,
  kyc_status    text not null default 'none'
                  check (kyc_status in ('none','pending','verified','failed')),
  country       char(2) not null default 'GB',
  is_admin      boolean not null default false,  -- staff only; never set from client
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.profiles is
  'Public-facing player profile, 1:1 with auth.users. Compliance flags are written only by trusted server functions, never the client.';

-- ============================================================================
-- 2. RACING DATA  (authoritative — written only by the ingest service role)
-- ============================================================================
-- Hierarchy: meeting (a fixture at a course on a date) -> race (an event/card)
--            -> runner (a horse declared in that race, with odds).
-- A "festival" groups meetings (Royal Ascot = 5 meetings). The pick universe for
-- a given competition-day is "any runner in any race that day".

create table public.festivals (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,                  -- 'royal-ascot-2026'
  name        text not null,                         -- 'Royal Ascot'
  starts_on   date not null,
  ends_on     date not null,
  day_count   smallint not null check (day_count between 1 and 14),
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on)
);

create table public.meetings (
  id          uuid primary key default gen_random_uuid(),
  festival_id uuid references public.festivals(id) on delete set null,
  course      text not null,                         -- 'Royal Ascot'
  meeting_date date not null,
  going        text,                                  -- 'Good to Firm'
  created_at  timestamptz not null default now(),
  unique (course, meeting_date)
);

create table public.races (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references public.meetings(id) on delete cascade,
  race_no       smallint not null check (race_no between 1 and 20),
  name          text not null,                       -- 'Royal Hunt Cup'
  off_time      timestamptz not null,                -- authoritative scheduled off
  distance      text,                                -- '1m'
  race_class     text,                                -- 'Class 2'
  status        event_status not null default 'scheduled',
  -- place_terms: how many places pay for the "place" outcome (field-size based)
  places_paid   smallint not null default 3 check (places_paid between 1 and 6),
  created_at    timestamptz not null default now(),
  unique (meeting_id, race_no)
);
comment on column public.races.off_time is
  'Authoritative scheduled off time. Used to compute the pick lock deadline; never editable by clients.';

create table public.runners (
  id            uuid primary key default gen_random_uuid(),
  race_id       uuid not null references public.races(id) on delete cascade,
  cloth_no      smallint not null check (cloth_no between 1 and 40),
  horse_name    text not null,
  jockey        text,
  trainer       text,
  -- Odds stored as numerator/denominator so we keep exact fractional SP and can
  -- recompute the v2 base deterministically. decimal_odds is derived, generated.
  odds_num      integer check (odds_num >= 0),
  odds_den      integer check (odds_den > 0),
  decimal_odds  numeric(8,3)
                  generated always as
                  (case when odds_den is null or odds_den = 0 then null
                        else round((odds_num::numeric / odds_den) + 1, 3) end) stored,
  is_favourite  boolean not null default false,      -- set by ingest from the market
  status        runner_status not null default 'declared',
  created_at    timestamptz not null default now(),
  unique (race_id, cloth_no),
  unique (race_id, horse_name)
);
comment on table public.runners is
  'Authoritative racecard runner + Starting Price. Written only by the data-ingest service role. The pick FK targets this row, so a player can never pick a horse that is not in the card.';

-- Exactly one favourite per race (the market favourite). Enforced as a partial
-- unique index: at most one runner per race may have is_favourite = true.
create unique index uniq_one_favourite_per_race
  on public.runners (race_id) where (is_favourite = true);

-- ============================================================================
-- 3. LEAGUES  (a competition instance: a mode + a window + runners; standard 10, partner-configurable 2-100)
-- ============================================================================

create table public.leagues (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 60),
  mode          competition_mode not null,
  festival_id   uuid references public.festivals(id) on delete set null, -- festival mode
  invite_code   text not null unique
                  check (invite_code ~ '^[A-Z0-9-]{4,16}$'),  -- 'RIVALS-X7K2'
  -- The competition window. For festival mode this mirrors the festival dates;
  -- for season it's the campaign; for day it's a single date.
  starts_on     date not null,
  ends_on       date not null,
  max_runners   smallint not null default 10 check (max_runners between 2 and 100), -- standard table = 10; partner-configurable (see 09_league_size.sql)
  status        league_status not null default 'forming',
  created_by    uuid not null references public.profiles(id),
  created_at    timestamptz not null default now(),
  check (ends_on >= starts_on),
  -- Day mode must be a single day; festival mode requires a festival link.
  check (mode <> 'day' or starts_on = ends_on),
  check (mode <> 'festival' or festival_id is not null)
);
comment on table public.leagues is
  'A competition instance. mode drives the window: day = single date, festival = a meeting run (variable length), season = the campaign.';

create table public.league_members (
  league_id   uuid not null references public.leagues(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  status      member_status not null default 'active',
  joined_at   timestamptz not null default now(),
  primary key (league_id, profile_id)
);

-- Cap a league at max_runners active members. Enforced by a trigger (below)
-- rather than a CHECK because it spans rows.

-- ============================================================================
-- 4. PICKS  (the ONLY table the player writes — and only before lock)
-- ============================================================================
-- One pick per (league_member, competition_day). The pick references a runner,
-- which guarantees it is a real horse in a real race in the day's universe.
-- A trigger enforces: (a) the runner's race is on pick_date, (b) now() < lock,
-- (c) the picker is an active member of the league.

create table public.picks (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  pick_date     date not null,                       -- the competition day
  runner_id     uuid not null references public.runners(id),
  kind          pick_kind not null default 'win',
  -- Snapshot of the market AT submission time (audit only; scoring re-reads the
  -- authoritative runner row, it does NOT trust these snapshots).
  odds_num_at_pick integer,
  odds_den_at_pick integer,
  was_fav_at_pick  boolean,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One pick per player per day per league. Changing a pick UPDATEs this row.
  unique (league_id, profile_id, pick_date)
);
comment on table public.picks is
  'The only player-writable game table, and only before the day lock. runner_id FK guarantees the pick is a declared runner. Odds snapshots are audit-only; scoring recomputes from the authoritative runner row.';

-- ============================================================================
-- 5. RESULTS  (authoritative finishing order — written only by ingest)
-- ============================================================================

create table public.race_results (
  id            uuid primary key default gen_random_uuid(),
  race_id       uuid not null references public.races(id) on delete cascade,
  runner_id     uuid not null references public.runners(id) on delete cascade,
  finish_pos    smallint check (finish_pos >= 1),    -- null = unplaced/DNF
  is_void       boolean not null default false,
  resulted_at   timestamptz not null default now(),
  unique (race_id, runner_id),
  -- one runner per finishing position within a race (no two "1st")
  unique (race_id, finish_pos)
);
comment on table public.race_results is
  'Authoritative finishing positions. Written only by the result-ingest service role. The scoring engine reads this; clients never can write it (RLS).';

-- ============================================================================
-- 6. SCORES  (DERIVED — written ONLY by the scoring engine, never the client)
-- ============================================================================
-- One score row per pick once its race is resulted. points is recomputed by the
-- server from authoritative odds + result; the breakdown columns are stored for
-- the transparent "how this was scored" UI and for audit.

create table public.daily_scores (
  id              uuid primary key default gen_random_uuid(),
  league_id       uuid not null references public.leagues(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  pick_id         uuid references public.picks(id) on delete set null, -- null = no-pick day
  score_date      date not null,
  outcome         result_outcome not null,
  -- v2 breakdown (all server-computed)
  base_pts        numeric(8,1) not null default 0,   -- win=odds#, place=half
  fav_bonus_pts   numeric(8,1) not null default 0,   -- +2 flat, WIN ONLY, non-fav
  streak_day      smallint     not null default 0,   -- 0 if not a streak day
  streak_bonus_pts numeric(8,1) not null default 0,  -- +1/day from day 2
  total_pts       numeric(8,1) not null default 0,
  computed_at     timestamptz not null default now(),
  engine_version  text not null default 'v2',
  unique (league_id, profile_id, score_date),
  -- Integrity: total must equal the sum of its parts (the engine sets all of
  -- these together; this guards against any partial/forged write).
  check (total_pts = base_pts + fav_bonus_pts + streak_bonus_pts),
  check (base_pts >= 0 and fav_bonus_pts >= 0 and streak_bonus_pts >= 0)
);
comment on table public.daily_scores is
  'Derived scores. Written ONLY by the scoring engine (SECURITY DEFINER). The CHECK that total = base+fav+streak makes a forged/partial row impossible to commit.';

-- Running league standings (materialised for fast leaderboard reads). Refreshed
-- by the engine after each scoring pass.
create table public.standings (
  league_id     uuid not null references public.leagues(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  total_pts     numeric(10,1) not null default 0,
  days_played   integer not null default 0,
  wins          integer not null default 0,
  current_streak smallint not null default 0,
  rank          integer,
  updated_at    timestamptz not null default now(),
  primary key (league_id, profile_id)
);

-- ============================================================================
-- 7. HEAD-TO-HEAD RIVALRY  (pride-only; season-long arc)
-- ============================================================================
-- A challenge is a 1-v-1 over a window inside a league. The season H2H record
-- between two players is an aggregate derived from settled challenges.

create table public.h2h_challenges (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  challenger_id uuid not null references public.profiles(id) on delete cascade,
  opponent_id   uuid not null references public.profiles(id) on delete cascade,
  starts_on     date not null,
  ends_on       date not null,
  status        challenge_status not null default 'pending',
  -- Settled outcome (engine-written): cumulative points each side over the window
  challenger_pts numeric(10,1),
  opponent_pts   numeric(10,1),
  winner_id      uuid references public.profiles(id),
  settled_at     timestamptz,
  created_at    timestamptz not null default now(),
  check (challenger_id <> opponent_id),     -- can't challenge yourself
  check (ends_on >= starts_on)
);
comment on table public.h2h_challenges is
  'Pride-only 1-v-1. No stake column by design (UKGC). Outcome points + winner are engine-written on settle, not client-set.';

-- Avoid duplicate live challenges between the same pair in a league window.
create unique index uniq_active_challenge_pair
  on public.h2h_challenges (league_id, least(challenger_id, opponent_id), greatest(challenger_id, opponent_id))
  where (status in ('pending','active'));

-- Season-long aggregate record between two players (the "Season H2H · You 4 — Marcus 3").
create table public.h2h_records (
  league_id     uuid not null references public.leagues(id) on delete cascade,
  profile_a     uuid not null references public.profiles(id) on delete cascade,
  profile_b     uuid not null references public.profiles(id) on delete cascade,
  a_wins        integer not null default 0,
  b_wins        integer not null default 0,
  draws         integer not null default 0,
  biggest_margin numeric(10,1) not null default 0,
  updated_at    timestamptz not null default now(),
  -- canonical ordering so each pair has exactly one row
  primary key (league_id, profile_a, profile_b),
  check (profile_a < profile_b)
);
comment on table public.h2h_records is
  'Canonical (profile_a < profile_b) so each pair has one row. Engine-written on challenge settle.';

-- ============================================================================
-- 8. SOCIAL  (chat + reactions — Phase 5). Moderated; not scoring-critical.
-- ============================================================================

create table public.chat_messages (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references public.leagues(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (char_length(body) between 1 and 240),
  is_hidden   boolean not null default false,        -- soft-moderation
  created_at  timestamptz not null default now()
);

create table public.message_reports (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid not null references public.chat_messages(id) on delete cascade,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason      text,
  created_at  timestamptz not null default now(),
  unique (message_id, reporter_id)
);

create table public.user_mutes (
  muter_id    uuid not null references public.profiles(id) on delete cascade,
  muted_id    uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (muter_id, muted_id),
  check (muter_id <> muted_id)
);

create table public.pick_reactions (
  pick_id     uuid not null references public.picks(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  emoji       text not null check (emoji in ('🔥','😬','👏','🐎')),
  created_at  timestamptz not null default now(),
  primary key (pick_id, profile_id, emoji)   -- one of each emoji per user per pick
);

-- ============================================================================
-- 9. INDEXES for hot read paths
-- ============================================================================
create index idx_picks_day        on public.picks (league_id, pick_date);
create index idx_picks_profile    on public.picks (profile_id, pick_date);
create index idx_runners_race     on public.runners (race_id);
create index idx_races_meeting    on public.races (meeting_id, off_time);
create index idx_meetings_date    on public.meetings (meeting_date);
create index idx_scores_league_day on public.daily_scores (league_id, score_date);
create index idx_standings_rank   on public.standings (league_id, rank);
create index idx_chat_league      on public.chat_messages (league_id, created_at desc);
create index idx_members_profile  on public.league_members (profile_id) where status = 'active';

commit;
