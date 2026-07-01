// ============================================================================
// Racing Rivals — League / Leaderboard (LIVE)
// ============================================================================
// Reactive controller for leaderboard.html when Supabase is configured AND the
// visitor holds a session. It OWNS the #scroll region (the static demo board in
// leaderboard.html stands down via window.__RR_LIVE__) and renders the real,
// member-gated standings:
//
//   profile → active league → ordered standings (rank asc, total_pts desc)
//   ↳ gap-to-leader nudge computed from the live rows
//   ↳ the current runner's row is highlighted
//   ↳ subscribeStandings keeps the board live: realtime postgres_changes when
//     available, a 20s poll + focus refetch as fallback (see lib/leaderboard.js)
//
// standings is engine-written only (RLS read = is_member(league_id), no client
// write), so this controller is READ + SUBSCRIBE + REPAINT — never a write path.
// ============================================================================

import { getMyActiveLeague } from './picks.js';
import { getMyProfile } from './profile.js';
import { getUser } from './session.js';
import { getStandings, computeGapToLeader, subscribeStandings } from './leaderboard.js';

// ---- state -----------------------------------------------------------------

const state = {
  user: null,
  profile: null,
  league: null,
  pickDate: null,
  rows: [],
  gap: null,
  loading: true,
  loadError: null,
  sub: null, // subscription handle
};

// ---- tiny helpers (mirrors today-live.js) ----------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function londonToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

function dayLine(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/London' }).format(d);
  const dm = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }).format(d);
  return `${wd} · ${dm}`;
}

/** Deterministic initials from display_name / handle (no external avatar svc). */
function initials(profile) {
  const name = (profile && (profile.display_name || profile.handle)) || '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return String(name).slice(0, 2).toUpperCase();
}

/** 1dp points, tabular. */
const pts = (n) => (Math.round(Number(n ?? 0) * 10) / 10).toFixed(1);

function displayName(profile, isMe) {
  const n = (profile && (profile.display_name || (profile.handle ? `@${profile.handle}` : null))) || 'Runner';
  return isMe ? `${esc(n)} <span class="lbyou">You</span>` : esc(n);
}

// ---- render ----------------------------------------------------------------

function renderLeague() {
  const scroll = $('scroll');
  if (!scroll) return;

  if (state.loading) {
    scroll.innerHTML = `
      <div class="kicker">${esc(dayLine(state.pickDate || londonToday()))}</div>
      <div class="daytitle serif">The League</div>
      <div class="lb-skel">Loading the standings…</div>`;
    return;
  }

  if (state.loadError) {
    scroll.innerHTML = `
      <div class="kicker">${esc(dayLine(state.pickDate || londonToday()))}</div>
      <div class="daytitle serif">The League</div>
      <div class="lb-empty"><div class="lb-empty-t">Couldn’t load the board</div>
        <div class="lb-empty-s">${esc(state.loadError.message)}</div></div>`;
    return;
  }

  if (!state.league) {
    scroll.innerHTML = `
      <div class="kicker">${esc(dayLine(state.pickDate))}</div>
      <div class="daytitle serif">The League</div>
      <div class="lb-empty"><div class="lb-empty-t">No live league yet</div>
        <div class="lb-empty-s">Join a table and the standings will appear here once the day is scored.</div></div>`;
    return;
  }

  const meId = state.profile && state.profile.id;
  const leagueName = state.league.name ? esc(state.league.name) : 'The League';

  if (!state.rows.length) {
    scroll.innerHTML = `
      <div class="kicker">${esc(dayLine(state.pickDate))} <span class="livebadge">Live · ${leagueName}</span></div>
      <div class="daytitle serif">The League</div>
      <div class="lb-empty"><div class="lb-empty-t">No scores in yet</div>
        <div class="lb-empty-s">The table fills in as the day’s results are settled.</div></div>`;
    return;
  }

  // gap-to-leader nudge
  let nudge = '';
  if (state.gap) {
    if (state.gap.isLeader) {
      nudge = `<div class="lb-nudge lead"><span class="lb-nudge-k">Top of the table</span>
        <span class="lb-nudge-b">You lead on ${pts(state.gap.myPts)} pts. Keep it clean.</span></div>`;
    } else {
      const ahead = state.gap.aheadProfile;
      const aheadName = ahead ? (ahead.profile && (ahead.profile.display_name || (ahead.profile.handle ? `@${ahead.profile.handle}` : 'the runner above'))) : 'the runner above';
      nudge = `<div class="lb-nudge"><span class="lb-nudge-k">Gap to leader</span>
        <span class="lb-nudge-b"><b>${pts(state.gap.gap)}</b> pts off the top — you’re ${ordinal(state.gap.myRank)}, chasing ${esc(aheadName)}.</span></div>`;
    }
  }

  const rowsHtml = state.rows.map((r, i) => {
    const rank = r.rank ?? i + 1;
    const isMe = meId && r.profileId === meId;
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
    const rankCls = rank <= 3 ? ` rank-${rank}` : '';
    return `
      <div class="lb-row${rankCls}${isMe ? ' you' : ''}">
        <div class="lb-pos mono">${medal || rank}</div>
        <div class="lb-avatar" aria-hidden="true">${esc(initials(r.profile))}</div>
        <div class="lb-main">
          <div class="lb-name">${displayName(r.profile, isMe)}</div>
          <div class="lb-meta mono">${r.daysPlayed} day${r.daysPlayed === 1 ? '' : 's'} · ${r.wins} win${r.wins === 1 ? '' : 's'}${r.currentStreak > 0 ? ` · 🔥${r.currentStreak}` : ''}</div>
        </div>
        <div class="lb-pts mono">${pts(r.totalPts)}</div>
      </div>`;
  }).join('');

  scroll.innerHTML = `
    <div class="kicker">${esc(dayLine(state.pickDate))} <span class="livebadge">Live · ${leagueName}</span></div>
    <div class="daytitle serif">The League</div>
    <div class="daysub">${state.rows.length} runner${state.rows.length === 1 ? '' : 's'} · pride, not prizes</div>
    ${nudge}
    <div class="lb-list">${rowsHtml}</div>
    <div class="lb-foot mono">Standings settle after each day’s results. ${state.sub && state.sub.mode === 'polling' ? 'Refreshing periodically.' : 'Updating live.'}</div>`;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

window.__rrRenderLeague = renderLeague;

// ---- data ------------------------------------------------------------------

async function refetch() {
  if (!state.league) return;
  const { rows, error } = await getStandings({ leagueId: state.league.id });
  if (error) { state.loadError = error; renderLeague(); return; }
  state.rows = rows;
  state.gap = computeGapToLeader(rows, state.profile && state.profile.id);
  renderLeague();
}

async function loadAll() {
  state.loading = true;
  state.loadError = null;
  renderLeague();

  state.pickDate = londonToday();
  state.profile = await getMyProfile(state.user.id);
  if (!state.profile) {
    state.loading = false;
    state.loadError = { kind: 'auth', message: 'We couldn’t load your profile. Sign in again.', retryable: false };
    renderLeague();
    return;
  }

  const { league, error } = await getMyActiveLeague({ profileId: state.profile.id, pickDate: state.pickDate });
  if (error) { state.loading = false; state.loadError = error; renderLeague(); return; }
  state.league = league;

  if (!state.league) { state.loading = false; renderLeague(); return; }

  const { rows, error: sErr } = await getStandings({ leagueId: state.league.id });
  state.loading = false;
  if (sErr) { state.loadError = sErr; renderLeague(); return; }
  state.rows = rows;
  state.gap = computeGapToLeader(rows, state.profile.id);
  renderLeague();

  // Go live: realtime with polling fallback. Any change → refetch + repaint.
  // On a realtime↔polling transition, repaint so the footer label reflects the
  // actual delivery mode ("Updating live." vs "Refreshing periodically.").
  if (state.sub) state.sub.unsubscribe();
  state.sub = subscribeStandings(state.league.id, refetch, () => renderLeague());

  window.addEventListener('beforeunload', () => { if (state.sub) state.sub.unsubscribe(); });
}

// ---- boot ------------------------------------------------------------------

(async function boot() {
  state.user = await getUser();
  if (!state.user) {
    state.loading = false;
    state.loadError = { kind: 'auth', message: 'Your session expired — sign in again.', retryable: false };
    renderLeague();
    return;
  }
  await loadAll();
})();

export default { renderLeague };
