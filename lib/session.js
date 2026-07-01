// ============================================================================
// Racing Rivals — session guard + auth-state observer
// ============================================================================
// Every RLS policy in migration 03 keys off auth.uid(). No session => the
// client is the `anon` role: it can read public racing data but is DENIED on
// leagues / picks / standings, and every pick INSERT fails the trg_validate_pick
// check (profile_id = auth.uid()). So the pick-submission routes MUST have a
// live session before they render.
//
// This module:
//   1. exposes getSession()/getUser()/requireSession() helpers,
//   2. installs an onAuthStateChange observer that keeps header + guarded UI in
//      sync (sign-in, sign-out, token refresh),
//   3. guardRoute() redirects unauthenticated visitors off protected pages.
// ============================================================================

import { supabase } from './supabase.js';
import { SIGN_IN_PATH } from './config.js';

let _cachedUser = null;
const _listeners = new Set();

/** Current Supabase session (or null). */
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    console.error('[RacingRivals] getSession error', error);
    return null;
  }
  return data.session;
}

/** Current authenticated user (or null). This id is what RLS checks as auth.uid(). */
export async function getUser() {
  const session = await getSession();
  _cachedUser = session?.user ?? null;
  return _cachedUser;
}

/** Synchronous access to the last-known user (populated after getUser/observer). */
export function currentUser() {
  return _cachedUser;
}

/**
 * Subscribe to auth changes. Callback receives (event, session).
 * Returns an unsubscribe function.
 */
export function onAuth(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/**
 * Redirect to the sign-in screen if there is no session.
 * Call at the top of every protected page BEFORE rendering pick UI.
 * Returns the user if authenticated, else null (after kicking off a redirect).
 */
export async function requireSession() {
  const user = await getUser();
  if (!user) {
    const back = encodeURIComponent(location.pathname + location.search);
    location.replace(`${SIGN_IN_PATH}?next=${back}`);
    return null;
  }
  return user;
}

/**
 * Guard a page: if it is a protected route and there is no session, redirect.
 * `render` runs only when a session exists.
 */
export async function guardRoute(render) {
  const user = await requireSession();
  if (user && typeof render === 'function') {
    await render(user);
  }
  return user;
}

/** Sign out and notify listeners. */
export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error('[RacingRivals] signOut error', error);
  _cachedUser = null;
}

// --- install the single global auth observer --------------------------------
// Fires on INITIAL_SESSION, SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED.
supabase.auth.onAuthStateChange((event, session) => {
  _cachedUser = session?.user ?? null;
  for (const cb of _listeners) {
    try {
      cb(event, session);
    } catch (e) {
      console.error('[RacingRivals] auth listener threw', e);
    }
  }
});

export default { getSession, getUser, currentUser, onAuth, requireSession, guardRoute, signOut };
