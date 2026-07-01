// ============================================================================
// Racing Rivals — Results / Scoring (LIVE)
// ============================================================================
// Reactive controller for results.html when Supabase is configured AND the
// visitor holds a session. It OWNS the #scroll region (the static demo in
// results.html stands down via window.__RR_LIVE__) and renders the runner's
// real, member-gated day-by-day scoring breakdown:
//
//   profile → active league → my daily_scores (newest first, with pick/runner/
//             race/meeting context + finishing position)
//   ↳ week strip (last 7 days), total banner (my rank + gap from standings),
//     per-day result cards each opening its own scoring breakdown.
//
// EVERY number is READ straight from daily_scores — base_pts / fav_bonus_pts /
// streak_bonus_pts / total_pts / streak_day / outcome are written ONLY by the
// scoring engine (RLS scores_read = is_member(league_id), no client write). The
// client NEVER recomputes a score; it displays the authoritative breakdown, so
// "the maths is always open" surface can't drift from the engine. This makes
// the controller a pure READ + SUBSCRIBE + REPAINT path.
//
// Rank / gap-to-leader in the total banner come from the standings slice
// (getStandings + computeGapToLeader) — the same live, member-gated source the
// League screen uses — so the two screens can never disagree.
// ============================================================================

import { getMyActiveLeague } from './picks.js';
import { getMyProfile } from './profile.js';
import { getUser } from './session.js';
import { getMyDailyScores, sumTotals, subscribeMyScores } from './results.js';
import { getStandings, computeGapToLeader } from './leaderboard.js';

// ---- state -----------------------------------------------------------------

const state = {
  user: null,
  profile: null,
  league: null,
  pickDate: null,
  rows: [],        // my daily_scores, newest first
  standing: null,  // { myRank, gap, isLeader, ... } from computeGapToLeader
  loading: true,
  loadError: null,
  sub: null,
};

// ---- tiny helpers (mirror leaderboard-live.js) -----------------------------

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

/** 1dp, .0 trimmed (matches the prototype's show()). */
function show(n) {
  const v = Math.round(Number(n ?? 0) * 10) / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Short weekday label for the week strip (MON/TUE/…), London tz. */
function wdLabel(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'Europe/London' })
    .format(d).slice(0, 3).toUpperCase();
}

/** Fractional-odds string from odds_num/odds_den (e.g. 9/1, 7/2, Evens). */
function oddsStr(row) {
  const n = row.oddsNum;
  const dvals = row.oddsDen;
  if (n == null || dvals == null) return null;
  if (Number(n) === Number(dvals)) return 'Evens';
  return `${n}/${dvals}`;
}

/** Finish string ("3rd of 28") when we resolved a finishing position. */
function finishStr(row) {
  if (row.finishPos == null) return null;
  const field = row.fieldSize ? ` of ${row.fieldSize}` : '';
  return `${ordinal(row.finishPos)}${field}`;
}

/**
 * Map the daily_scores outcome enum to the prototype's visual class.
 *   win               → 'win'   (green)
 *   place             → 'plc'   (amber)
 *   unplaced|no_pick  → 'miss'  (muted)
 *   void              → 'void'  (neutral, points refunded to 0)
 */
function visualClass(outcome) {
  if (outcome === 'win') return 'win';
  if (outcome === 'place') return 'plc';
  if (outcome === 'void') return 'void';
  return 'miss'; // unplaced, no_pick, anything unexpected
}

/** Deterministic silk colours from the horse name (no external silk service yet). */
function silkColours(name) {
  const palette = [
    ['#1b6e3a', '#ffd23f'], ['#b3122b', '#0a0a0a'], ['#1e4fff', '#ffffff'],
    ['#6d28d9', '#f5d90a'], ['#0f766e', '#ffffff'], ['#9a3412', '#fde68a'],
  ];
  let h = 0;
  for (let i = 0; i < String(name || '').length; i += 1) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return palette[h % palette.length];
}

// ---- render ----------------------------------------------------------------

function shell(inner) {
  const scroll = $('scroll');
  if (scroll) scroll.innerHTML = inner;
}

function renderResults() {
  if (state.loading) {
    shell(`
      <div class="kicker">Results</div>
      <h2 class="section-h serif">Your week</h2>
      <div class="rl-skel">Loading your scores…</div>`);
    return;
  }

  if (state.loadError) {
    shell(`
      <div class="kicker">Results</div>
      <h2 class="section-h serif">Your week</h2>
      <div class="rl-empty"><div class="rl-empty-t">Couldn’t load your results</div>
        <div class="rl-empty-s">${esc(state.loadError.message)}</div></div>`);
    return;
  }

  if (!state.league) {
    shell(`
      <div class="kicker">Results</div>
      <h2 class="section-h serif">Your week</h2>
      <div class="rl-empty"><div class="rl-empty-t">No live league yet</div>
        <div class="rl-empty-s">Join a table and your day-by-day breakdown will appear here once the day is scored.</div></div>`);
    return;
  }

  const leagueName = state.league.name ? esc(state.league.name) : 'your league';

  if (!state.rows.length) {
    shell(`
      <div class="kicker">Results <span class="livebadge">Live · ${leagueName}</span></div>
      <h2 class="section-h serif">Your week</h2>
      <div class="section-sub">Every pick, every result — and exactly where the points came from. No hidden maths.</div>
      ${explainerHtml()}
      <div class="rl-empty"><div class="rl-empty-t">No scores in yet</div>
        <div class="rl-empty-s">Your breakdown fills in as each day’s results are settled.</div></div>`);
    return;
  }

  const total = sumTotals(state.rows);

  // week strip — the seven most recent days, oldest → newest for reading order.
  const week = [...state.rows].slice(0, 7).reverse();
  const strip = week.map((r) => {
    const cls = visualClass(r.outcome);
    const sym = cls === 'win' ? '🥇' : cls === 'plc' ? '●' : cls === 'void' ? '∅' : '–';
    const val = cls === 'miss' ? '0' : cls === 'void' ? '—' : `+${show(r.totalPts)}`;
    return `<div class="daycell ${cls}">
      <div class="dl">${esc(wdLabel(r.scoreDate))}</div>
      <div class="dp">${val}</div>
      <div class="ds">${sym}</div></div>`;
  }).join('');

  // total banner — rank + gap come from the live standings slice.
  let rankLine = 'Standings update as results settle';
  if (state.standing) {
    if (state.standing.isLeader) {
      rankLine = `Top of ${leagueName}<br><b>Leading the table</b>`;
    } else {
      rankLine = `${ordinal(state.standing.myRank)} in <b>${leagueName}</b><br>${show(state.standing.gap)} pts off the lead`;
    }
  }

  // result cards — newest first (rows already newest-first).
  const cards = state.rows.map((r) => resultCard(r)).join('');

  shell(`
    <div class="kicker">Results <span class="livebadge">Live · ${leagueName}</span></div>
    <h2 class="section-h serif">Your week</h2>
    <div class="section-sub">Every pick, every result — and exactly where the points came from. No hidden maths.</div>

    <div class="weekbar">${strip}</div>

    <div class="totbanner">
      <div><div class="tl">Your total</div><div class="tv mono">${show(total)}</div></div>
      <div class="tr">${rankLine}</div>
    </div>

    ${explainerHtml()}

    <div class="daydivide">Day by day</div>
    ${cards}
    <div class="rl-foot mono">Scores settle after each day’s results. ${state.sub && state.sub.mode === 'polling' ? 'Refreshing periodically.' : 'Updating live.'}</div>
  `);
}

/** One day's result card + its authoritative scoring breakdown. */
function resultCard(r) {
  const cls = visualClass(r.outcome);
  const sk = silkColours(r.horseName || '?');
  const outLbl = r.outcome === 'no_pick'
    ? 'NO PICK'
    : { win: 'WON', plc: 'PLACED', void: 'VOID', miss: 'UNPLACED' }[cls];
  const horse = r.horseName ? esc(r.horseName) : (r.outcome === 'no_pick' ? 'No pick' : 'Runner');
  const odds = oddsStr(r);
  const finish = finishStr(r);
  const subBits = [r.course && esc(r.course), r.raceName && esc(r.raceName), odds && esc(odds), finish && esc(finish)]
    .filter(Boolean).join(' · ');
  const silkChar = (r.horseName || '?').trim()[0] || '?';

  let bd;
  if (cls === 'miss') {
    const fin = finish ? `Finished ${esc(finish)}. ` : '';
    const noPick = r.outcome === 'no_pick'
      ? 'No pick entered — no points, and your streak resets.'
      : `${fin}No points — win or place only. Your streak resets.`;
    bd = `<div class="breakdown"><div class="bd-miss">${noPick}</div></div>`;
  } else if (cls === 'void') {
    bd = `<div class="breakdown"><div class="bd-miss">Race void — pick refunded, scores 0. Your streak is unaffected.</div></div>`;
  } else {
    // Breakdown lines READ straight from daily_scores. No recomputation.
    const lines = [];
    lines.push(`<div class="bd-row bd-base">
      <span class="bl">${cls === 'win' ? 'Win' : 'Place'}${odds ? ` · ${esc(odds)}` : ''}</span>
      <span class="bv">+${show(r.basePts)}</span></div>`);
    if (Number(r.favBonusPts) > 0) {
      lines.push(`<div class="bd-row">
        <span class="bl"><span class="bd-tag fav">FAV-BEATER</span>Beat the favourite</span>
        <span class="bv pos">+${show(r.favBonusPts)}</span></div>`);
    }
    if (Number(r.streakBonusPts) > 0) {
      lines.push(`<div class="bd-row">
        <span class="bl"><span class="bd-tag streak">STREAK</span>Win streak · day ${r.streakDay}</span>
        <span class="bv pos">+${show(r.streakBonusPts)}</span></div>`);
    }
    const formulaBits = [`${cls === 'win' ? 'win' : 'place'} base = ${show(r.basePts)}`];
    if (Number(r.favBonusPts) > 0) formulaBits.push(`+${show(r.favBonusPts)} fav-beater`);
    if (Number(r.streakBonusPts) > 0) formulaBits.push(`+${show(r.streakBonusPts)} streak`);
    bd = `<div class="breakdown">${lines.join('')}
      <div class="bd-row bd-total ${cls}"><span class="bl">Day total</span><span class="bv">+${show(r.totalPts)}</span></div>
      <div class="bd-formula">${formulaBits.join('  ·  ')}</div></div>`;
  }

  const bigPts = (cls === 'miss') ? '0' : (cls === 'void') ? '—' : `+${show(r.totalPts)}`;

  return `<div class="rescard ${cls}">
    <div class="rc-head">
      <div class="silk" style="background:linear-gradient(135deg,${sk[0]} 50%,${sk[1]} 50%)">${esc(silkChar)}</div>
      <div class="rc-mid">
        <div class="rc-name serif">${horse} <span class="outcome ${cls}">${outLbl}</span></div>
        <div class="rc-sub">${subBits || '&nbsp;'}</div>
      </div>
      <div class="rc-pts ${cls}"><div class="big">${bigPts}</div><div class="lbl">pts</div></div>
    </div>
    ${bd}
  </div>`;
}

/** The collapsible "How points work" explainer (static copy; matches engine). */
function explainerHtml() {
  return `
    <div class="explainer" id="explainer">
      <div class="ex-head" onclick="document.getElementById('explainer').classList.toggle('open')">
        <div class="eh serif">🧮 How points work</div>
        <div class="ei">tap ⌄</div>
      </div>
      <div class="ex-body"><div class="ex-in">
        <div class="ex-item"><span class="en">1</span><div><b>Win</b> = your horse’s price as a number. A 9/1 winner = <b>9 pts</b>, evens = <b>1</b>, 28/1 = <b>28</b>. The bigger the price, the bigger the points.<div class="ex-eg">evens → 1 · 7/2 → 3.5 · 9/1 → 9 · 28/1 → 28</div></div></div>
        <div class="ex-item"><span class="en">2</span><div><b>Place</b> (top finish, didn’t win) = <b>half</b> the win value. A 9/1 placed = <b>4.5 pts</b>. A near-miss still scores.</div></div>
        <div class="ex-item"><span class="en">3</span><div><b>Beat the favourite</b> — if your pick wasn’t the market favourite and it <b>wins</b>, <b>+2</b>. Reward for backing a winner over the chalk. <span class="ex-eg">A place doesn’t earn it — only a win.</span></div></div>
        <div class="ex-item"><span class="en">4</span><div><b>Win streak</b> — win on consecutive days and earn <b>+1 per extra day</b> (day 2 = +1, day 3 = +2…). Only wins build a streak; a place or blank day resets it.</div></div>
        <div class="ex-item"><span class="en">5</span><div>No cap. A miss scores <b>0</b>. Every result shows the full breakdown — the maths is always open.</div></div>
      </div></div>
    </div>`;
}

window.__rrRenderResults = renderResults;

// ---- data ------------------------------------------------------------------

async function refetch() {
  if (!state.league || !state.profile) return;
  const [{ rows, error }, { rows: standRows }] = await Promise.all([
    getMyDailyScores({ leagueId: state.league.id, profileId: state.profile.id }),
    getStandings({ leagueId: state.league.id }),
  ]);
  if (error) { state.loadError = error; renderResults(); return; }
  state.rows = rows;
  state.standing = computeGapToLeader(standRows, state.profile.id);
  renderResults();
}

async function loadAll() {
  state.loading = true;
  state.loadError = null;
  renderResults();

  state.pickDate = londonToday();
  state.profile = await getMyProfile(state.user.id);
  if (!state.profile) {
    state.loading = false;
    state.loadError = { kind: 'auth', message: 'We couldn’t load your profile. Sign in again.', retryable: false };
    renderResults();
    return;
  }

  const { league, error } = await getMyActiveLeague({ profileId: state.profile.id, pickDate: state.pickDate });
  if (error) { state.loading = false; state.loadError = error; renderResults(); return; }
  state.league = league;

  if (!state.league) { state.loading = false; renderResults(); return; }

  const [{ rows, error: sErr }, { rows: standRows }] = await Promise.all([
    getMyDailyScores({ leagueId: state.league.id, profileId: state.profile.id }),
    getStandings({ leagueId: state.league.id }),
  ]);
  state.loading = false;
  if (sErr) { state.loadError = sErr; renderResults(); return; }
  state.rows = rows;
  state.standing = computeGapToLeader(standRows, state.profile.id);
  renderResults();

  // Go live: realtime on daily_scores with polling fallback. Any change →
  // refetch (scores + standings) + repaint. On a realtime↔polling transition,
  // repaint so the footer label reflects the actual delivery mode.
  if (state.sub) state.sub.unsubscribe();
  state.sub = subscribeMyScores(state.league.id, state.profile.id, refetch, () => renderResults());

  window.addEventListener('beforeunload', () => { if (state.sub) state.sub.unsubscribe(); });
}

// ---- boot ------------------------------------------------------------------

(async function boot() {
  state.user = await getUser();
  if (!state.user) {
    state.loading = false;
    state.loadError = { kind: 'auth', message: 'Your session expired — sign in again.', retryable: false };
    renderResults();
    return;
  }
  await loadAll();
})();

export default { renderResults };
