// ============================================================================
// Racing Rivals — Today (LIVE)
// ============================================================================
// Reactive controller for today.html when Supabase is configured AND the visitor
// holds a session. It OWNS the #scroll region (the demo state-switcher render in
// today.html stands down via window.__RR_LIVE__), and drives the real pick flow:
//
//   profile → active league → today's card + current pick + authoritative lock
//   ↳ live countdown to lock (colour-only tension, matching the prototype)
//   ↳ "Pick your runner" / "Change pick" → bottom sheet of selectable runners
//   ↳ submit = optimistic paint, then reconcile against the server row
//   ↳ every failure is mapped (lib/errors.js) to an editorial toast; the trigger
//     is the source of truth, so a rejected optimistic pick is rolled back
//   ↳ once locked, controls disable themselves (client mirror of trg_validate_pick)
//
// The write path this drives was validated end-to-end on PostgreSQL 18:
// valid insert, in-place upsert change, non-runner reject, wrong-date reject,
// pick_lock_at RPC, and post-lock reject all behave as the UI assumes here.
// ============================================================================

import {
  getCard, getMyActiveLeague, getLockAt, startLockCountdown,
  getMyPick, submitPick,
} from './picks.js';
import { getMyProfile } from './profile.js';
import { getUser } from './session.js';

// ---- state -----------------------------------------------------------------

const state = {
  user: null,
  profile: null,
  league: null,
  pickDate: null,     // YYYY-MM-DD (Europe/London "today")
  races: [],          // [{id,name,off_time,meeting,runners:[...]}]
  runnersById: {},    // id -> runner (flat lookup for reconcile / paint)
  pick: null,         // current server pick row (or null)
  lockAt: null,       // Date or null
  locked: false,
  loading: true,
  loadError: null,    // mapped error object when the initial load failed
  // sheet
  sheetKind: 'win',
  sheetSel: null,     // selected runner id inside the sheet
  submitting: false,
};

let stopCountdown = null;

// ---- helpers ---------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Europe/London calendar date as YYYY-MM-DD (matches server pick_date basis). */
function londonToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** Human date line for the header, e.g. "Wednesday · 1 July". */
function dayLine(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'Europe/London' }).format(d);
  const dm = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' }).format(d);
  return `${wd} · ${dm}`;
}

/** Fractional odds label from a runner row. */
function oddsLabel(r) {
  if (r?.odds_num == null || r?.odds_den == null) return 'SP';
  return `${r.odds_num}/${r.odds_den}`;
}

/** The race a given runner belongs to (for the pick "race" line). */
function raceOfRunner(runnerId) {
  return state.races.find((rc) => (rc.runners || []).some((ru) => ru.id === runnerId)) || null;
}

function raceLabel(race) {
  if (!race) return '';
  const off = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/London',
  }).format(new Date(race.off_time));
  const course = race.meeting?.course || race.name || 'Race';
  return `${course} ${off}`;
}

// ---- toast -----------------------------------------------------------------

let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('toast');
  if (!el) return;
  el.textContent = '';
  el.innerHTML = message;
  el.classList.toggle('err', kind === 'err');
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}

// ---- countdown -------------------------------------------------------------

function toneForMs(ms) {
  if (ms == null) return 'normal';
  if (ms <= 5 * 60 * 1000) return 'red';
  if (ms <= 30 * 60 * 1000) return 'amber';
  return 'normal';
}

function mountCountdown() {
  if (stopCountdown) { stopCountdown(); stopCountdown = null; }
  const wrap = $('rr-count');
  if (!wrap) return;

  stopCountdown = startLockCountdown(state.lockAt, ({ ms, label, locked }) => {
    const w = $('rr-count');
    if (!w) return;
    const tone = locked ? 'normal' : toneForMs(ms);
    w.classList.remove('amber', 'red');
    if (tone !== 'normal') w.classList.add(tone);

    const numEl = $('rr-count-num');
    if (numEl) numEl.textContent = state.lockAt ? (locked ? 'LOCKED' : label) : '—';

    const footEl = $('rr-count-foot');
    if (footEl) {
      footEl.innerHTML = !state.lockAt
        ? "No card published for today yet"
        : locked ? "Picks are <b>locked</b> for today"
        : tone === 'red' ? "<b>Last chance</b> — change or keep your pick"
        : tone === 'amber' ? "Deadline approaching — <b>review your pick</b>"
        : "Plenty of time — change your pick whenever";
    }

    // Lock transition: flip UI to locked and disable controls exactly once.
    if (locked && !state.locked) {
      state.locked = true;
      closeSheet();
      renderToday();
      toast('Picks are now locked for today.', 'info');
    }
  });
}

// ---- data load -------------------------------------------------------------

async function loadAll() {
  state.loading = true;
  state.loadError = null;
  renderToday();

  state.pickDate = londonToday();

  // Profile (RLS: a runner can always read their own row; handle_new_user seeds it).
  // getMyProfile returns the row directly, or null on error.
  const profile = await getMyProfile(state.user.id);
  if (!profile) {
    state.loadError = { kind: 'transport', message: "Couldn't load your profile — check your connection and try again.", retryable: true };
    state.loading = false; return renderToday();
  }
  state.profile = profile;

  // Which live league are we picking in today?
  const { league, error: lErr } = await getMyActiveLeague({
    profileId: state.profile.id, pickDate: state.pickDate,
  });
  if (lErr) { state.loadError = lErr; state.loading = false; return renderToday(); }
  state.league = league;

  // Card + lock in parallel (both are public-readable; lock is an RPC).
  const [cardRes, lockRes] = await Promise.all([
    getCard(state.pickDate),
    getLockAt(state.pickDate),
  ]);
  if (cardRes.error) { state.loadError = cardRes.error; state.loading = false; return renderToday(); }
  state.races = cardRes.races;
  state.runnersById = {};
  for (const rc of state.races) for (const ru of (rc.runners || [])) state.runnersById[ru.id] = ru;
  state.lockAt = lockRes.error ? null : lockRes.lockAt;
  state.locked = !!(state.lockAt && state.lockAt.getTime() - Date.now() <= 0);

  // Current pick (only meaningful when we resolved a league).
  if (state.league) {
    const { pick, error: mpErr } = await getMyPick({
      leagueId: state.league.id, profileId: state.profile.id, pickDate: state.pickDate,
    });
    // A read error here (e.g. transient) shouldn't blank the whole page — surface
    // it as a toast and continue with no known pick.
    if (mpErr) toast(mpErr.message, mpErr.kind === 'transport' ? 'err' : 'info');
    state.pick = pick || null;
  }

  state.loading = false;
  renderToday();
  mountCountdown();
}

// ---- render: today ---------------------------------------------------------

function countdownBlock() {
  // Rendered once; the countdown loop only mutates #rr-count-num / -foot / classes.
  return `
    <div class="countwrap" id="rr-count">
      <div class="cl">Lock in by 12:30 (or 30m before the first race)</div>
      <div class="clock">
        <div class="unit"><span class="num" id="rr-count-num" style="font-size:30px">—</span>
          <span class="ul">Until lock</span></div>
      </div>
      <div class="cfoot" id="rr-count-foot">&nbsp;</div>
    </div>`;
}

function pickSlotFilled() {
  const r = state.runnersById[state.pick.runner_id] || null;
  const name = r ? r.horse_name : 'Your runner';
  const race = raceLabel(raceOfRunner(state.pick.runner_id));
  const odds = r ? oddsLabel(r) : oddsLabel(state.pick); // pick carries audit odds too
  const kindLabel = state.pick.kind === 'place' ? 'Place' : 'Win';
  const headR = state.locked
    ? `<span class="sh-r locked">🔒 Locked</span>`
    : `<span class="sh-r open">● Locked in · changeable</span>`;
  const footBtn = state.locked
    ? `<button class="btn btn-ghost" disabled style="opacity:.5;cursor:default">Picks locked</button>`
    : `<button class="btn btn-ghost" id="rr-change">Change pick</button>`;
  return `
    <div class="slot">
      <div class="slot-h"><span class="sh-l">Today's pick</span>${headR}</div>
      <div class="pickrow">
        <div class="silk"></div>
        <div class="pick-meta">
          <div class="pick-name">${esc(name)}</div>
          <div class="pick-race">${esc(race)}${race ? ' · ' : ''}${esc(odds)} · ${kindLabel}</div>
        </div>
      </div>
      <div class="slot-foot">${footBtn}</div>
    </div>`;
}

function pickSlotEmpty() {
  const hasCard = state.races.some((rc) => (rc.runners || []).length > 0);
  if (state.locked) {
    return `
      <div class="slot">
        <div class="slot-h"><span class="sh-l">Today's pick</span><span class="sh-r locked">🔒 Locked</span></div>
        <div class="empty">
          <div class="ei">✕</div>
          <div class="et">No pick today</div>
          <div class="es">The window has closed and you didn't pick a runner. No score today — the window reopens tomorrow at 7:30am.</div>
        </div>
      </div>`;
  }
  if (!hasCard) {
    return `
      <div class="slot">
        <div class="slot-h"><span class="sh-l">Today's pick</span><span class="sh-r locked">Awaiting card</span></div>
        <div class="empty">
          <div class="ei">⏱</div>
          <div class="et">Card not up yet</div>
          <div class="es">Today's runners haven't been published. Check back shortly — you'll be able to pick as soon as the card lands.</div>
        </div>
      </div>`;
  }
  return `
    <div class="slot">
      <div class="slot-h"><span class="sh-l">Today's pick</span><span class="sh-r open">● Open</span></div>
      <div class="empty">
        <div class="ei">+</div>
        <div class="et">No runner yet</div>
        <div class="es">Choose one horse from any race today. You can change it right up to the deadline.</div>
        <button class="btn btn-primary" id="rr-pick">Pick your runner</button>
      </div>
    </div>`;
}

function noLeagueBlock() {
  return `
    <div class="slot">
      <div class="slot-h"><span class="sh-l">Today's pick</span><span class="sh-r locked">No league</span></div>
      <div class="empty">
        <div class="ei">📊</div>
        <div class="et">You're not in a live league</div>
        <div class="es">Join or start a league to pick a runner. Once you're an active runner, today's card shows up here.</div>
      </div>
    </div>`;
}

function errorBlock(err) {
  return `
    <div class="slot">
      <div class="slot-h"><span class="sh-l">Today</span><span class="sh-r locked">Problem</span></div>
      <div class="empty">
        <div class="ei">!</div>
        <div class="et">Couldn't load today</div>
        <div class="es">${esc(err.message)}</div>
        <button class="btn ${err.retryable ? 'btn-primary' : 'btn-ghost'}" id="rr-retry">Try again</button>
      </div>
    </div>`;
}

export function renderToday() {
  const scroll = $('scroll');
  if (!scroll) return;

  if (state.loading) {
    scroll.innerHTML = `
      <div class="kicker">${esc(dayLine(state.pickDate || londonToday()))}</div>
      <div class="daytitle">Today's runner</div>
      <div class="daysub">Loading your card…</div>
      <div class="countwrap"><div class="cl">Loading…</div>
        <div class="clock"><div class="unit"><span class="num" style="font-size:30px">—</span>
        <span class="ul">Until lock</span></div></div></div>`;
    return;
  }

  let body;
  if (state.loadError) body = errorBlock(state.loadError);
  else if (!state.league) body = countdownBlock() + noLeagueBlock();
  else body = countdownBlock() + (state.pick ? pickSlotFilled() : pickSlotEmpty());

  const leagueName = state.league ? ` · ${esc(state.league.name)}` : '';
  scroll.innerHTML = `
    <div class="kicker">${esc(dayLine(state.pickDate))} <span class="livebadge">Live${leagueName}</span></div>
    <div class="daytitle">Today's runner</div>
    <div class="daysub">Pick one horse from any race today.</div>
    ${body}`;

  // wire buttons that exist in this render
  const bPick = $('rr-pick'); if (bPick) bPick.onclick = () => openSheet();
  const bChange = $('rr-change'); if (bChange) bChange.onclick = () => openSheet();
  const bRetry = $('rr-retry'); if (bRetry) bRetry.onclick = () => loadAll();

  // countdown block was re-created — (re)mount the loop unless we errored/loading
  if (!state.loadError) mountCountdown();
}

// expose for the bottom-nav "Today" tab in today.html
window.__rrRenderToday = renderToday;

// ---- runner-selection sheet ------------------------------------------------

function openSheet() {
  if (state.locked) { toast('Picks are locked for today.', 'info'); return; }
  state.sheetKind = state.pick?.kind || 'win';
  state.sheetSel = state.pick?.runner_id || null;
  syncKindTog();
  renderSheetBody();
  syncConfirm();
  $('sheet').classList.add('open');
  $('sheetScrim').classList.add('open');
}

function closeSheet() {
  const s = $('sheet'), sc = $('sheetScrim');
  if (s) s.classList.remove('open');
  if (sc) sc.classList.remove('open');
}

function syncKindTog() {
  document.querySelectorAll('#kindTog button').forEach((b) => {
    b.classList.toggle('on', b.dataset.kind === state.sheetKind);
  });
}

function renderSheetBody() {
  const body = $('sheetBody');
  if (!body) return;
  const blocks = state.races
    .filter((rc) => (rc.runners || []).length > 0)
    .map((rc) => {
      const rows = rc.runners.map((ru) => {
        const sel = ru.id === state.sheetSel ? ' sel' : '';
        const fav = ru.is_favourite ? ' fav' : '';
        return `
          <button class="runopt${sel}" data-runner="${ru.id}">
            <span class="cn">${esc(ru.cloth_no ?? '')}</span>
            <span class="rn">
              <span class="h">${esc(ru.horse_name)}</span>
              <span class="j">${esc(ru.jockey || '')}${ru.jockey && ru.trainer ? ' · ' : ''}${esc(ru.trainer || '')}</span>
            </span>
            <span class="od${fav}">${esc(oddsLabel(ru))}</span>
          </button>`;
      }).join('');
      return `<div class="raceblk"><div class="rh">${esc(raceLabel(rc))}</div>${rows}</div>`;
    }).join('');
  body.innerHTML = blocks || `<div class="empty" style="padding:30px 8px">
    <div class="et">No runners available</div>
    <div class="es">Today's card has no selectable runners yet.</div></div>`;

  body.querySelectorAll('.runopt').forEach((btn) => {
    btn.onclick = () => {
      state.sheetSel = btn.dataset.runner;
      body.querySelectorAll('.runopt').forEach((b) => b.classList.toggle('sel', b === btn));
      syncConfirm();
    };
  });
}

function syncConfirm() {
  const c = $('sheetConfirm');
  if (!c) return;
  if (state.submitting) {
    c.disabled = true; c.style.opacity = '.7';
    c.innerHTML = '<span class="spinner"></span>Submitting…';
    return;
  }
  const ready = !!state.sheetSel;
  c.disabled = !ready;
  c.style.opacity = ready ? '1' : '.5';
  const changing = state.pick && state.pick.runner_id === state.sheetSel && state.pick.kind === state.sheetKind;
  c.textContent = !ready ? 'Select a runner'
    : changing ? 'Keep this pick'
    : state.pick ? 'Change my pick' : 'Confirm my pick';
}

// ---- submit (optimistic → reconcile) ---------------------------------------

async function doSubmit() {
  if (!state.sheetSel || state.submitting) return;
  if (state.locked) { toast('Picks are locked for today.', 'err'); closeSheet(); return; }
  if (!state.league) { toast("You're not in a live league.", 'err'); return; }

  const runner = state.runnersById[state.sheetSel];
  if (!runner) { toast('That horse is no longer in the field — pick another.', 'err'); renderSheetBody(); return; }

  // --- optimistic paint: adopt the new pick locally, close the sheet ---
  const prevPick = state.pick;
  state.pick = {
    id: prevPick?.id || null,
    runner_id: runner.id,
    kind: state.sheetKind,
    odds_num_at_pick: runner.odds_num ?? null,
    odds_den_at_pick: runner.odds_den ?? null,
    was_fav_at_pick: runner.is_favourite ?? null,
    _optimistic: true,
  };
  state.submitting = true;
  syncConfirm();
  renderToday();

  // --- server write (trg_validate_pick is the source of truth) ---
  const { pick, error } = await submitPick({
    leagueId: state.league.id,
    profileId: state.profile.id,
    pickDate: state.pickDate,
    runner,
    kind: state.sheetKind,
  });

  state.submitting = false;

  if (error) {
    // Reconcile: roll back to the previous confirmed pick and explain.
    state.pick = prevPick;
    renderToday();
    toast(error.message, error.kind === 'validation' || error.kind === 'auth' || error.kind === 'rls' ? 'err' : 'err');

    // If the trigger says we're locked or the horse vanished, refresh so the UI
    // reflects the true server state rather than a stale optimistic view.
    if (error.kind === 'validation') loadAll();
    // Auth failures mean the session died — the guard will catch it on reload.
    return;
  }

  // --- reconcile with the authoritative row ---
  state.pick = pick;
  closeSheet();
  renderToday();
  toast(prevPick ? 'Pick changed.' : 'Pick confirmed. Good luck.', 'info');
}

// ---- static wiring (elements that always exist) ----------------------------

function wireStatic() {
  const close = $('sheetClose'); if (close) close.onclick = closeSheet;
  const scrim = $('sheetScrim'); if (scrim) scrim.onclick = closeSheet;
  const confirm = $('sheetConfirm'); if (confirm) confirm.onclick = doSubmit;
  document.querySelectorAll('#kindTog button').forEach((b) => {
    b.onclick = () => { state.sheetKind = b.dataset.kind; syncKindTog(); syncConfirm(); };
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
}

// ---- boot ------------------------------------------------------------------

(async function boot() {
  state.user = await getUser();
  wireStatic();
  if (!state.user) {
    // The guard should have redirected already; if we somehow got here without a
    // user, show a recoverable error rather than throwing on state.user.id.
    state.loading = false;
    state.loadError = { kind: 'auth', message: 'Your session expired — sign in again to pick.', retryable: false };
    renderToday();
    return;
  }
  await loadAll();
})();

export default { renderToday };
