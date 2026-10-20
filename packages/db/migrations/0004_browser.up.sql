-- Step 1d: the browser (Browser Use) and files people attach or the browser downloads.

-- One Browser Use profile (cookies, sign-ins) and one workspace (files) per person.
ALTER TABLE user_settings ADD COLUMN bu_profile_id text;
ALTER TABLE user_settings ADD COLUMN bu_workspace_id text;

-- Which version of the assistant's instructions and tools a chat's Travila thread was set up
-- with, so older chats get the new tools (such as browse) on their next message.
ALTER TABLE chats ADD COLUMN travila_profile_version text;

-- Files: where they came from, and where the browser sees them.
ALTER TABLE files ADD COLUMN chat_id uuid REFERENCES chats(id) ON DELETE CASCADE;
ALTER TABLE files ADD COLUMN run_id uuid REFERENCES runs(id) ON DELETE SET NULL;
-- Path in the person's Browser Use workspace once the file has been given to the browser.
ALTER TABLE files ADD COLUMN bu_path text;
CREATE INDEX files_run ON files (run_id);

-- The bytes of files we keep ourselves (storage = 'own'). Separate from `files` so listing files
-- never reads their contents.
CREATE TABLE file_blobs (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data bytea NOT NULL
);
ALTER TABLE file_blobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_blobs_owner ON file_blobs TO app_user
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON file_blobs TO app_user;

-- Attachments point at a user's message; a message's files are looked up by message.
CREATE INDEX attachments_message ON attachments (message_id);

-- A browser session is one browse tool call: a Browser Use run (plus any follow-up runs after
-- the person hands the browser back).
ALTER TABLE browser_sessions ADD COLUMN tool_call_id uuid REFERENCES tool_calls(id) ON DELETE CASCADE;
ALTER TABLE browser_sessions ADD COLUMN bu_run_id text;
ALTER TABLE browser_sessions ADD COLUMN task text;
ALTER TABLE browser_sessions ADD COLUMN step text;
ALTER TABLE browser_sessions ADD COLUMN needs_user text;
ALTER TABLE browser_sessions ADD COLUMN result text;
ALTER TABLE browser_sessions ADD COLUMN error text;
ALTER TABLE browser_sessions ADD COLUMN events_after bigint NOT NULL DEFAULT 0;
-- Files already in the workspace's outputs/ folder when the run started, so only new ones are
-- copied out afterwards.
ALTER TABLE browser_sessions ADD COLUMN outputs_before jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE browser_sessions ADD COLUMN cost_usd numeric;
ALTER TABLE browser_sessions ADD COLUMN checked_at timestamptz;
ALTER TABLE browser_sessions ADD COLUMN waiting_since timestamptz;
ALTER TABLE browser_sessions ADD COLUMN finished_at timestamptz;
ALTER TABLE browser_sessions ADD CONSTRAINT browser_sessions_status CHECK (status IN
  ('starting', 'running', 'needs_user', 'user_control', 'done', 'failed', 'stopped'));
CREATE UNIQUE INDEX browser_sessions_tool_call ON browser_sessions (tool_call_id);
CREATE INDEX browser_sessions_run ON browser_sessions (run_id);
