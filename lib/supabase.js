// ============================================================================
// Racing Rivals — Supabase client singleton
// ============================================================================
// One shared client for all prototype pages. Uses the PUBLIC anon key and the
// `authenticated` role once a session exists; RLS (migration 03) governs every
// read/write. The service_role key is server-only and must never be imported
// here.
//
// The prototypes are plain static HTML, so we import supabase-js as an ES module
// from a CDN — no build step required for the demo.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';

if (!isConfigured()) {
  // Loud, early failure beats a silent connection to the wrong project.
  console.warn(
    '[RacingRivals] Supabase is not configured. Set window.__RR_SUPABASE_URL__ ' +
      'and window.__RR_SUPABASE_ANON_KEY__ (see lib/config.js / .env.example).'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,      // keep auth.uid() stable across prototype pages
    autoRefreshToken: true,    // refresh the JWT before it expires
    detectSessionInUrl: true,  // needed for magic-link / OAuth redirect callbacks
    storageKey: 'rr-demo-auth',
  },
});

export default supabase;
