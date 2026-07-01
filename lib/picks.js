// ============================================================================
// Racing Rivals — reactive pick submission
// ============================================================================
// Picks are the ONLY freely client-writable game table. The browser writes
// public.picks directly under RLS (picks_insert_own / picks_update_own /
// picks_delete_own, all check profile_id = auth.uid()), and trg_validate_pick
// enforces correctness server-side. There is NO service-role RPC for picking —
// the client owns this write.
//
// Contract this wires to (verified against 01/02):
//   * picks unique key = (league_id, profile_id, pick_date)  -> change = UPSERT
//   * kind is 'win' | 'place'
//   * odds_num_at_pick / odds_den_at_pick / was_fav_at_pick are AUDIT-ONLY
//     snapshots (scoring re-reads the authoritative runner row, never these)
//   * trg_validate_pick rejects: profile≠uid; not active member; runner missing;
//     runner races on a different date; runner non_runner/withdrawn; now()≥lock
//   * pick_lock_at(date) = least(12:30 Europe/London, first non-void race −30m)
// ============================================================================

import { supabase } from './supabase.js';
import { TABLES, RPC } from './config.js';
import { mapError } from './errors.js';

// --- racecard / runners -----------------------------------------------------

/**
 * Load the day's races + their selectable runners for a pick_date (YYYY-MM-DD).
 * Filters OUT non_runner / withdrawn — those can never be picked.
 * Returns races ordered by off_time, each with a `runners` array.
 */
export async function getCard(pickDate) {
  const { data, error } = await supabase
    .from(TABLES.races)
    .select(`
      id, name, off_time, status,
      meeting:meetings ( course ),
      runners (
        id, cloth_no, horse_name, jockey, trainer,
        odds_num, odds_den, decimal_odds, is_favourite, status
      )
    `)
    .gte('off_time', `${pickDate}T00:00:00Z`)
    .lte('off_time', `${pickDate}T23:59:59Z`)
    .order('off_time', { ascending: true });

  if (error) return { races: [], error: mapError(error) };

  const races = (data || []).map((r) => ({
    ...r,
    runners: (r.runners || [])
      .filter((ru) => ru.status !== 'non_runner' && ru.status !== 'withdrawn')
      .sort((a, b) => a.cloth_no - b.cloth_no),
  }));
  return { races, error: null };
}

// --- league resolution ------------------------------------------------------

/**
 * Resolve the caller's active league for picking. The demo runner belongs to one
 * live league; we pick the most-recently-created active membership whose league
 * is live and whose window covers `pickDate`. Returns { league, error }.
 * `league` is { id, name, mode, starts_on, ends_on } or null when the runner has
 * no eligible league (a legitimate empty state, not an error).
 */
export async function getMyActiveLeague({ profileId, pickDate }) {
  const { data, error } = await supabase
    .from(TABLES.leagueMembers)
    .select(`
      status,
      league:leagues ( id, name, mode, status, starts_on, ends_on )
    `)
    .eq('profile_id', profileId)
    .eq('status', 'active');

  if (error) return { league: null, error: mapError(error) };

  const eligible = (data || [])
    .map((m) => m.league)
    .filter((l) => l && l.status === 'live' &&
                   (!pickDate || (l.starts_on <= pickDate && l.ends_on >= pickDate)))
    .sort((a, b) => (a.starts_on < b.starts_on ? 1 : -1));

  return { league: eligible[0] || null, error: null };
}

// --- lock timing ------------------------------------------------------------

/** Authoritative lock time for the day (timestamptz string) or null. */
export async function getLockAt(pickDate) {
  const { data, error } = await supabase.rpc(RPC.pickLockAt, { p_pick_date: pickDate });
  if (error) return { lockAt: null, error: mapError(error) };
  return { lockAt: data ? new Date(data) : null, error: null };
}

/** Milliseconds until lock (negative once locked). null if no lock known. */
export function msUntilLock(lockAt) {
  if (!lockAt) return null;
  return lockAt.getTime() - Date.now();
}

/** True once the window is shut — trust this to disable the pick controls. */
export function isLocked(lockAt) {
  const ms = msUntilLock(lockAt);
  return ms !== null && ms <= 0;
}

/**
 * Start a 1s countdown. onTick({ms,label,locked}) fires immediately then every
 * second; when it crosses zero it fires once more with locked=true and stops.
 * Returns a stop() function.
 */
export function startLockCountdown(lockAt, onTick) {
  function fmt(ms) {
    if (ms <= 0) return '00:00:00';
    const s = Math.floor(ms / 1000);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  let stopped = false;
  let timer = null;
  function tick() {
    if (stopped) return;
    const ms = msUntilLock(lockAt);
    const locked = ms !== null && ms <= 0;
    onTick({ ms, label: ms === null ? '—' : fmt(ms), locked });
    if (locked && timer) { clearInterval(timer); timer = null; }
  }
  tick();
  timer = setInterval(tick, 1000);
  return function stop() { stopped = true; if (timer) clearInterval(timer); };
}

// --- read current pick ------------------------------------------------------

/** The user's current pick for the day in this league (or null). */
export async function getMyPick({ leagueId, profileId, pickDate }) {
  const { data, error } = await supabase
    .from(TABLES.picks)
    .select('id, runner_id, kind, odds_num_at_pick, odds_den_at_pick, was_fav_at_pick, updated_at')
    .eq('league_id', leagueId)
    .eq('profile_id', profileId)
    .eq('pick_date', pickDate)
    .maybeSingle();
  if (error) return { pick: null, error: mapError(error) };
  return { pick: data || null, error: null };
}

// --- submit / change / clear -----------------------------------------------

/**
 * Submit or change a pick. Because of the unique (league,profile,date) key,
 * this is an UPSERT on that key — first pick inserts, later ones update in place.
 * `runner` is the selected runner row (for the audit odds snapshot).
 * trg_validate_pick runs on both insert and update; failures are mapped.
 *
 * @returns {{pick:object|null, error:object|null}}
 */
export async function submitPick({ leagueId, profileId, pickDate, runner, kind = 'win' }) {
  const row = {
    league_id: leagueId,
    profile_id: profileId,      // MUST equal auth.uid() or the trigger rejects
    pick_date: pickDate,
    runner_id: runner.id,
    kind,
    // audit-only market snapshot (scoring ignores these):
    odds_num_at_pick: runner.odds_num ?? null,
    odds_den_at_pick: runner.odds_den ?? null,
    was_fav_at_pick: runner.is_favourite ?? null,
  };
  const { data, error } = await supabase
    .from(TABLES.picks)
    .upsert(row, { onConflict: 'league_id,profile_id,pick_date' })
    .select()
    .single();
  if (error) return { pick: null, error: mapError(error) };
  return { pick: data, error: null };
}

/**
 * Clear the pick (delete). block_locked_pick_delete prevents dodging a 0 after
 * lock, so a post-lock clear is rejected and mapped.
 */
export async function clearPick({ leagueId, profileId, pickDate }) {
  const { error } = await supabase
    .from(TABLES.picks)
    .delete()
    .eq('league_id', leagueId)
    .eq('profile_id', profileId)
    .eq('pick_date', pickDate);
  if (error) return { ok: false, error: mapError(error) };
  return { ok: true, error: null };
}

export default {
  getCard, getMyActiveLeague, getLockAt, msUntilLock, isLocked, startLockCountdown,
  getMyPick, submitPick, clearPick,
};
