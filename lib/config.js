// ============================================================================
// Racing Rivals — client config (demo environment)
// ============================================================================
// Single source of truth for the Supabase connection used by every prototype
// page. The anon key is a PUBLIC key by design — RLS (migration 03) is what
// enforces access, NOT secrecy of this key. The service_role key must NEVER
// appear in client code.
//
// For the demo we read from injected globals when present (so the deploy target
// can set them without a build step), then fall back to placeholders that make
// a mis-config obvious rather than silently pointing at prod.
// ============================================================================

const g = typeof window !== 'undefined' ? window : globalThis;

export const SUPABASE_URL =
  g.__RR_SUPABASE_URL__ || 'https://YOUR-DEMO-PROJECT.supabase.co';

export const SUPABASE_ANON_KEY =
  g.__RR_SUPABASE_ANON_KEY__ || 'REPLACE_WITH_DEMO_ANON_KEY';

// Table / function names kept in one place so a rename is a one-line change.
export const TABLES = {
  profiles: 'profiles',
  leagues: 'leagues',
  leagueMembers: 'league_members',
  races: 'races',
  runners: 'runners',
  raceResults: 'race_results',
  picks: 'picks',
  dailyScores: 'daily_scores',
  standings: 'standings',
};

export const RPC = {
  pickLockAt: 'pick_lock_at',   // (p_date date) -> timestamptz  [anon + authenticated]
  isMember: 'is_member',        // (p_league uuid) -> boolean     [authenticated]
};

// Where an unauthenticated visitor is sent when they hit a protected route.
export const SIGN_IN_PATH = './signin.html';

// Routes that require an active session (pick submission + anything that writes
// picks / reads member-gated standings). Guarded by lib/session.js.
export const PROTECTED_ROUTES = [
  'today.html',
  'racecard.html',
  'leaderboard.html',
  'results.html',
  'result-reveal.html',
  'rivalry.html',
];

export function isConfigured() {
  return (
    !SUPABASE_URL.includes('YOUR-DEMO-PROJECT') &&
    SUPABASE_ANON_KEY !== 'REPLACE_WITH_DEMO_ANON_KEY'
  );
}
