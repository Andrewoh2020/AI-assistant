DROP INDEX IF EXISTS browser_sessions_run;
DROP INDEX IF EXISTS browser_sessions_tool_call;
ALTER TABLE browser_sessions DROP CONSTRAINT IF EXISTS browser_sessions_status;
ALTER TABLE browser_sessions DROP COLUMN IF EXISTS finished_at, DROP COLUMN IF EXISTS waiting_since,
  DROP COLUMN IF EXISTS checked_at, DROP COLUMN IF EXISTS cost_usd,
  DROP COLUMN IF EXISTS outputs_before, DROP COLUMN IF EXISTS events_after,
  DROP COLUMN IF EXISTS error, DROP COLUMN IF EXISTS result, DROP COLUMN IF EXISTS needs_user,
  DROP COLUMN IF EXISTS step, DROP COLUMN IF EXISTS task, DROP COLUMN IF EXISTS bu_run_id,
  DROP COLUMN IF EXISTS tool_call_id;
DROP INDEX IF EXISTS attachments_message;
DROP TABLE IF EXISTS file_blobs;
DROP INDEX IF EXISTS files_run;
ALTER TABLE files DROP COLUMN IF EXISTS bu_path, DROP COLUMN IF EXISTS run_id,
  DROP COLUMN IF EXISTS chat_id;
ALTER TABLE chats DROP COLUMN IF EXISTS travila_profile_version;
ALTER TABLE user_settings DROP COLUMN IF EXISTS bu_workspace_id, DROP COLUMN IF EXISTS bu_profile_id;
