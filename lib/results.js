// ============================================================================
// Racing Rivals — Results data + realtime (LIVE)
// ============================================================================
// Pure data layer for the Results screen. No DOM. It exposes:
//
//   getMyDailyScores({ leagueId, profileId }) → ordered [{ scoreDate, outcome,
//       basePts, favBonusPts, streakBonusPts, streakDay, totalPts, pick }]
//   subscribeMyScores(leagueId, profileId, onChange) → { unsubscribe() }
//
// The Results screen shows YOUR day-by-day scoring breakdown. Every number is
// READ straight from daily_scores — the scoring engine already computed
// base/fav/streak/total (and the DB enforces total = base+fav+streak). The
// client NEVER recomputes; it just displays the authoritative breakdown, so
// the "maths is always open" surface can't drift from the engine.
//
// Context (which horse, price, finish) is joined off pick_id → picks → runners
// → races → meetings, and the finishing position off race_results. All of these
// are read-only for authenticated users; daily_scores + picks are member-gated
// (RLS scores_read / picks_read `using is_member(league_id)`).
//
// Contract (verified against 01_schema.sql / 03_rls_policies.sql):
//   daily_scores(league_id, profile_id, pick_id null=no-pick, score_date,
//     outcome result_outcome['win','place','unplaced','void','no_pick'],
//     base_pts, fav_bonus_pts, streak_day, streak_bonus_pts, total_pts).
//     unique(league_id,profile_id,score_date); total = base+fav+streak (CHECK).
//   picks(runner_id, kind ['win','place'], odds_*_at_pick audit-only).
//   runners(horse_name, cloth_no, odds_num, odds_den, is_favourite, race_id).
//   races(name, off_time, meeting_id); meetings(course).
//   race_results(race_id, runner_id, finish_pos null=unplaced, is_void).
// ============================================================================

import { supabase } from './supabase.js';
import { TABLES } from './config.js';
import { mapError } from './errors.js';

const POLL_MS = 20000;

// ---- reads -----------------------------------------------------------------

/**
 * The current runner's day-by-day scores for a league, newest first, each row
 * carrying its pick + runner + race context and finishing position.
 * Returns { rows, error }. rows = [] on error (never throws).
 */
export async function getMyDailyScores({ leagueId, profileId }) {
  if (!leagueId || !profileId) return { rows: [], error: null };

  // daily_scores → pick → runner → race → meeting. finish_pos is resolved in a
  // second pass (race_results is keyed by race_id+runner_id, not reachable via
  // the pick FK chain in one embed).
  const { data, error } = await supabase
    .from(TABLES.dailyScores)
    .select(`
      league_id,
      profile_id,
      pick_id,
      score_date,
      outcome,
      base_pts,
      fav_bonus_pts,
      streak_day,
      streak_bonus_pts,
      total_pts,
      pick:picks (
        id, kind, runner_id,
        runner:runners (
          id, horse_name, cloth_no, odds_num, odds_den, is_favourite, race_id,
          race:races ( id, name, off_time, places_paid,
            meeting:meetings ( course ) )
        )
      )
    `)
    .eq('league_id', leagueId)
    .eq('profile_id', profileId)
    .order('score_date', { ascending: false });

  if (error) return { rows: [], error: mapError(error) };

  const rows = (data || []).map(mapScoreRow);

  // Resolve finishing positions in one batched query over race_results.
  await attachFinishes(rows);

  return { rows, error: null };
}

function mapScoreRow(r) {
  const pick = r.pick || null;
  const runner = pick && pick.runner ? pick.runner : null;
  const race = runner && runner.race ? runner.race : null;
  const meeting = race && race.meeting ? race.meeting : null;
  return {
    leagueId: r.league_id,
    profileId: r.profile_id,
    pickId: r.pick_id,
    scoreDate: r.score_date,
    outcome: r.outcome, // 'win'|'place'|'unplaced'|'void'|'no_pick'
    basePts: Number(r.base_pts ?? 0),
    favBonusPts: Number(r.fav_bonus_pts ?? 0),
    streakDay: r.streak_day ?? 0,
    streakBonusPts: Number(r.streak_bonus_pts ?? 0),
    totalPts: Number(r.total_pts ?? 0),
    kind: pick ? pick.kind : null, // 'win'|'place' (the runner's selection)
    horseName: runner ? runner.horse_name : null,
    clothNo: runner ? runner.cloth_no : null,
    oddsNum: runner ? runner.odds_num : null,
    oddsDen: runner ? runner.odds_den : null,
    wasFavourite: runner ? !!runner.is_favourite : false,
    raceId: race ? race.id : null,
    runnerId: runner ? runner.id : null,
    raceName: race ? race.name : null,
    offTime: race ? race.off_time : null,
    placesPaid: race ? race.places_paid : null,
    course: meeting ? meeting.course : null,
    finishPos: null, // filled by attachFinishes
    fieldSize: null,
    isVoid: r.outcome === 'void',
  };
}

/** Batch-resolve finish_pos (and field size) for rows that have a race+runner. */
async function attachFinishes(rows) {
  const raceIds = [...new Set(rows.map((r) => r.raceId).filter(Boolean))];
  if (!raceIds.length) return;

  const { data, error } = await supabase
    .from(TABLES.raceResults)
    .select('race_id, runner_id, finish_pos, is_void')
    .in('race_id', raceIds);

  if (error || !data) return; // context is best-effort; a scores row still renders

  // finishing position for the runner's own result…
  const byRaceRunner = new Map();
  const fieldByRace = new Map();
  for (const rr of data) {
    byRaceRunner.set(`${rr.race_id}:${rr.runner_id}`, rr);
    fieldByRace.set(rr.race_id, (fieldByRace.get(rr.race_id) || 0) + 1);
  }
  for (const row of rows) {
    if (!row.raceId || !row.runnerId) continue;
    const rr = byRaceRunner.get(`${row.raceId}:${row.runnerId}`);
    if (rr) {
      row.finishPos = rr.finish_pos ?? null;
      row.isVoid = row.isVoid || !!rr.is_void;
    }
    row.fieldSize = fieldByRace.get(row.raceId) || null;
  }
}

/** Sum of settled day totals (defensive; the leaderboard total is authoritative). */
export function sumTotals(rows) {
  return Math.round(
    (rows || []).reduce((a, r) => a + Number(r.totalPts ?? 0), 0) * 10,
  ) / 10;
}

// ---- realtime (with polling fallback) --------------------------------------

/**
 * Subscribe to daily_scores changes for THIS runner in a league. onChange fires
 * (debounced) when the engine writes/updates one of their day scores. Same
 * realtime-or-poll fallback shape as subscribeStandings (see lib/leaderboard.js).
 *
 * Note: postgres_changes cannot filter on two columns, so we filter server-side
 * on league_id and re-check profile_id in the caller's refetch (getMyDailyScores
 * already scopes to profileId). Returns { unsubscribe() }.
 */
export function subscribeMyScores(leagueId, profileId, onChange, onModeChange) {
  let channel = null;
  let pollTimer = null;
  let debounceTimer = null;
  let torn = false;
  let mode = 'connecting';

  const setMode = (m) => {
    if (m === mode) return;
    mode = m;
    if (!torn && typeof onModeChange === 'function') { try { onModeChange(m); } catch (_e) { /* noop */ } }
  };

  const fire = () => {
    if (torn) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { if (!torn) onChange(); }, 250);
  };

  const startPolling = () => {
    if (torn || pollTimer) return;
    setMode('polling');
    pollTimer = setInterval(fire, POLL_MS);
    window.addEventListener('focus', fire);
  };
  const stopPolling = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    window.removeEventListener('focus', fire);
  };

  try {
    channel = supabase
      .channel(`scores:${leagueId}:${profileId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TABLES.dailyScores, filter: `league_id=eq.${leagueId}` },
        fire,
      )
      .subscribe((status) => {
        if (torn) return;
        if (status === 'SUBSCRIBED') { setMode('realtime'); stopPolling(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { startPolling(); }
      });
  } catch (_e) {
    startPolling();
  }

  const armFallback = setTimeout(() => { if (!torn && mode === 'connecting') startPolling(); }, 5000);

  return {
    get mode() { return mode; },
    unsubscribe() {
      torn = true;
      clearTimeout(armFallback);
      if (debounceTimer) clearTimeout(debounceTimer);
      stopPolling();
      if (channel) { try { supabase.removeChannel(channel); } catch (_e) { /* noop */ } channel = null; }
    },
  };
}

export default { getMyDailyScores, sumTotals, subscribeMyScores };
