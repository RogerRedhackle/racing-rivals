// ============================================================================
// Racing Rivals — shared error mapper
// ============================================================================
// Turns raw Supabase / Postgres errors into human, editorial-toned messages,
// and classifies them so callers can decide whether to retry.
//
// Three classes:
//   'validation' — trg_validate_pick raised (deterministic; DO NOT retry)
//   'auth'       — no/expired session or profile mismatch (re-auth)
//   'transport'  — network / 5xx (safe to retry with backoff)
//   'rls'        — request denied / returned empty for a non-member (not a bug)
//   'unknown'    — anything unmapped
// ============================================================================

// The exact RAISE strings from validate_pick() / block_locked_pick_delete()
// (02_functions_triggers.sql). We match on stable substrings, not full text.
const VALIDATION_MAP = [
  { match: 'profile_id must equal',       kind: 'auth',       msg: 'Your session expired — sign in again to pick.' },
  { match: 'not an active member',        kind: 'validation', msg: "You're not an active runner in this league." },
  { match: 'does not exist',              kind: 'validation', msg: 'That horse is no longer in the field — pick another.' },
  { match: 'races on',                    kind: 'validation', msg: "That race isn't part of today's card." },
  { match: 'non-runner / withdrawn',      kind: 'validation', msg: 'That horse is a non-runner — pick another.' },
  { match: 'pick window is locked',       kind: 'validation', msg: 'Picks are locked for today.' },
  { match: 'locked',                      kind: 'validation', msg: 'Picks are locked for today.' },
];

/**
 * @returns {{kind:string, message:string, retryable:boolean, raw:any}}
 */
export function mapError(error) {
  if (!error) return { kind: 'unknown', message: 'Something went wrong.', retryable: false, raw: error };

  const text = (error.message || error.error_description || String(error)).toLowerCase();

  // Auth first (supabase-js surfaces these by name).
  if (error.name === 'AuthSessionMissingError' || text.includes('jwt') || text.includes('not authenticated')) {
    return { kind: 'auth', message: 'Your session expired — sign in again to pick.', retryable: false, raw: error };
  }

  // trg_validate_pick / delete-block RAISEs come back as Postgres errors.
  for (const rule of VALIDATION_MAP) {
    if (text.includes(rule.match)) {
      return { kind: rule.kind, message: rule.msg, retryable: false, raw: error };
    }
  }

  // Postgres RLS denial for a write the policy forbids.
  if (error.code === '42501' || text.includes('row-level security') || text.includes('permission denied')) {
    return { kind: 'rls', message: "You don't have access to do that here.", retryable: false, raw: error };
  }

  // Network / gateway — safe to retry.
  if (text.includes('failed to fetch') || text.includes('network') ||
      (error.status && error.status >= 500)) {
    return { kind: 'transport', message: 'Connection hiccup — try again.', retryable: true, raw: error };
  }

  return { kind: 'unknown', message: error.message || 'Something went wrong.', retryable: false, raw: error };
}

export default { mapError };
