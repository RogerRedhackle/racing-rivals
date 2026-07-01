// ============================================================================
// Racing Rivals — runtime environment (demo)
// ============================================================================
// Injected BEFORE the ES module scripts so lib/config.js picks up the live
// Supabase connection. Loaded as a plain (non-module) <script> in the <head>
// of every live page, guaranteeing it runs before deferred module imports.
//
// The anon/publishable key is PUBLIC by design — Row Level Security (migration
// 03) enforces access, NOT secrecy of this key. The service_role key must
// NEVER appear here or anywhere in client code.
// ============================================================================
(function (g) {
  g.__RR_SUPABASE_URL__ = 'https://efwwvsgnkiezegejzhaa.supabase.co';
  g.__RR_SUPABASE_ANON_KEY__ =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVmd3d2c2dua2llemVnZWp6aGFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5MTMzMTYsImV4cCI6MjA5ODQ4OTMxNn0._oZnf9TtKhvHcVGPlC7o8QEL6lWbDllrHafeyzHGF2g';
})(typeof window !== 'undefined' ? window : globalThis);
