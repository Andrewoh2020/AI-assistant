DROP FUNCTION IF EXISTS app_sign_in(text, text, text, text);
DROP TABLE IF EXISTS browser_sessions, memory_entries, sources, tool_calls, messages, runs, chats,
  user_settings, users CASCADE;
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS app_current_user();
REVOKE USAGE ON SCHEMA public FROM app_user;
-- The app_user role is shared across databases on the same server, so it is left in place.
