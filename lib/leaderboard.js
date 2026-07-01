// ============================================================================
// Racing Rivals — Leaderboard data + realtime (LIVE)
// ============================================================================
// Pure data layer for the League screen. No DOM. It exposes:
//
//   getStandings({ leagueId })      → ordered [{ rank, profile, total_pts, ... }]
//   computeGapToLeader(rows, meId)  → { leaderPts, myPts, gap, myRank } | null
//   subscribeStandings(leagueId, onChange) → { unsubscribe() }
//
// The standings table is materialised and written ONLY by the scoring engine
// (RLS: standings_read `using is_member(league_id)`, no write policy). So the
// client only ever READS an ordered slice and RE-READS it whenever a realtime
// postgres_changes event says the engine touched this league.
//
// Realtime with a polling fallback:
//   subscribeStandings opens a channel on public.standings filtered to this
//   league. If the channel reaches SUBSCRIBED we run purely event-driven. If it
//   errors / times out / closes (Realtime disabled on the project, the migration
//   08 not applied, a flaky socket), we fall back to a poll (refetch every
//   POLL_MS and on window focus) so the board still converges. onChange is the
//   single sink either way — the caller just refetches + repaints.
//
// Contract (verified against 01_schema.sql / 03_rls_policies.sql):
//   standings PK (league_id, profile_id); columns total_pts numeric(10,1),
//   days_played, wins, current_streak, rank, updated_at. Order = rank asc, then
//   total_pts desc as a stable tiebreak for rows the engine hasn't ranked yet.
//   profiles readable via profiles_read_all (id, handle, display_name,
//   avatar_seed).
// ============================================================================

import { supabase } from './supabase.js';
import { TABLES } from './config.js';
import { mapError } from './errors.js';

const POLL_MS = 20000; // fallback cadence when realtime is unavailable

// ---- reads -----------------------------------------------------------------

/**
 * Ordered standings for a league, each row joined to its profile for display.
 * Returns { rows, error }. rows = [] on error (never throws).
 */
export async function getStandings({ leagueId }) {
  if (!leagueId) return { rows: [], error: null };

  const { data, error } = await supabase
    .from(TABLES.standings)
    .select(`
      league_id,
      profile_id,
      total_pts,
      days_played,
      wins,
      current_streak,
      rank,
      updated_at,
      profile:profiles ( id, handle, display_name, avatar_seed )
    `)
    .eq('league_id', leagueId)
    .order('rank', { ascending: true, nullsFirst: false })
    .order('total_pts', { ascending: false });

  if (error) return { rows: [], error: mapError(error) };

  const rows = (data || []).map((r) => ({
    leagueId: r.league_id,
    profileId: r.profile_id,
    totalPts: Number(r.total_pts ?? 0),
    daysPlayed: r.days_played ?? 0,
    wins: r.wins ?? 0,
    currentStreak: r.current_streak ?? 0,
    rank: r.rank ?? null,
    updatedAt: r.updated_at ?? null,
    profile: r.profile || null,
  }));

  return { rows, error: null };
}

/**
 * Gap-to-leader summary for the current runner.
 * rows must be the ordered output of getStandings; meProfileId identifies "you".
 * Returns null when the runner is not on the board yet.
 */
export function computeGapToLeader(rows, meProfileId) {
  if (!rows || !rows.length || !meProfileId) return null;
  const leader = rows[0];
  const meIdx = rows.findIndex((r) => r.profileId === meProfileId);
  if (meIdx < 0) return null;
  const me = rows[meIdx];
  const leaderPts = Number(leader.totalPts ?? 0);
  const myPts = Number(me.totalPts ?? 0);
  const gap = Math.round((leaderPts - myPts) * 10) / 10; // 1dp, matches numeric(10,1)
  return {
    leaderPts,
    myPts,
    gap,
    myRank: me.rank ?? meIdx + 1,
    isLeader: meIdx === 0,
    aheadProfile: meIdx > 0 ? rows[meIdx - 1] : null, // the runner directly above you
  };
}

// ---- realtime (with polling fallback) --------------------------------------

/**
 * Subscribe to standings changes for a league.
 *
 * onChange() is invoked (debounced) whenever the engine writes to standings for
 * this league — the caller should refetch getStandings + repaint. It is ALSO
 * invoked by the polling fallback when realtime is unavailable, so the caller
 * needs only one code path.
 *
 * Returns { unsubscribe() } — call it on teardown / route change.
 */
export function subscribeStandings(leagueId, onChange, onModeChange) {
  let channel = null;
  let pollTimer = null;
  let debounceTimer = null;
  let torn = false;
  let mode = 'connecting'; // 'connecting' | 'realtime' | 'polling'

  const setMode = (m) => {
    if (m === mode) return;
    mode = m;
    if (!torn && typeof onModeChange === 'function') { try { onModeChange(m); } catch (_e) { /* noop */ } }
  };

  const fire = () => {
    if (torn) return;
    // Debounce bursts (the engine can write standings + daily_scores back to
    // back on a scoring run) into a single refetch.
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
      .channel(`standings:${leagueId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: TABLES.standings, filter: `league_id=eq.${leagueId}` },
        fire,
      )
      .subscribe((status) => {
        if (torn) return;
        if (status === 'SUBSCRIBED') {
          // Realtime is live — make sure any earlier fallback poll is off.
          setMode('realtime');
          stopPolling();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          // Realtime unavailable (disabled, migration not applied, socket lost)
          // → converge via polling instead so the board still updates.
          startPolling();
        }
      });
  } catch (_e) {
    // supabase.channel unavailable in this client build → straight to polling.
    startPolling();
  }

  // Safety net: if we never reach SUBSCRIBED within a short window, start
  // polling anyway (covers silent stalls where no status callback fires).
  const armFallback = setTimeout(() => {
    if (!torn && mode === 'connecting') startPolling();
  }, 5000);

  return {
    get mode() { return mode; },
    unsubscribe() {
      torn = true;
      clearTimeout(armFallback);
      if (debounceTimer) clearTimeout(debounceTimer);
      stopPolling();
      if (channel) {
        try { supabase.removeChannel(channel); } catch (_e) { /* best effort */ }
        channel = null;
      }
    },
  };
}

export default { getStandings, computeGapToLeader, subscribeStandings };
