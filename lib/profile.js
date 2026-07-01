// ============================================================================
// Racing Rivals — profile helpers
// ============================================================================
// handle_new_user() (SECURITY DEFINER, migration 02) auto-creates the profile
// row on signup, so the client NEVER inserts into public.profiles — it only
// reads (profiles_read_all) and updates its own row (profiles_update_own).
//
// profiles_update_own additionally FORBIDS changing privileged columns
// (is_admin, kyc_status, age_verified) — those keep their stored values or the
// WITH CHECK fails. So updates from here must be limited to display fields.
// ============================================================================

import { supabase } from './supabase.js';
import { TABLES } from './config.js';

/** Read the current user's profile row (or null). */
export async function getMyProfile(userId) {
  const { data, error } = await supabase
    .from(TABLES.profiles)
    .select('id, handle, display_name, avatar_seed, country, age_verified, kyc_status, is_admin')
    .eq('id', userId)
    .single();
  if (error) {
    console.error('[RacingRivals] getMyProfile error', error);
    return null;
  }
  return data;
}

/**
 * Update display-only fields on the current user's profile.
 * Only handle / display_name / avatar_seed are safe to send — privileged
 * columns are rejected by the profiles_update_own WITH CHECK.
 */
export async function updateMyProfile(userId, { handle, display_name, avatar_seed } = {}) {
  const patch = {};
  if (handle !== undefined) patch.handle = handle;
  if (display_name !== undefined) patch.display_name = display_name;
  if (avatar_seed !== undefined) patch.avatar_seed = avatar_seed;

  const { data, error } = await supabase
    .from(TABLES.profiles)
    .update(patch)
    .eq('id', userId)
    .select()
    .single();
  if (error) {
    console.error('[RacingRivals] updateMyProfile error', error);
    throw error;
  }
  return data;
}

export default { getMyProfile, updateMyProfile };
