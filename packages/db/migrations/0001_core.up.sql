-- Phase 1 tables: identity, chat, runs, tool calls, sources, memory mirror, browser sessions.
-- See docs/architecture-plan.html section 6. Every table carries user_id and row-level security,
-- so a request running as one user can never read or write another user's rows.

-- The role the API and worker switch to for every request (SET LOCAL ROLE app_user).
-- Row-level security applies to it; the migration owner keeps full access for maintenance.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;
GRANT app_user TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO app_user;

-- The user id of the current request, set with set_config('app.user_id', ..., true).
CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- Identity and settings ------------------------------------------------------

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  auth_subject text NOT NULL UNIQUE,
  display_name text,
  email text,
  timezone text NOT NULL DEFAULT 'UTC',
  locale text NOT NULL DEFAULT 'en',
  travila_user_id text NOT NULL UNIQUE,
  proactive_window_start time NOT NULL DEFAULT '09:00',
  proactive_window_end time NOT NULL DEFAULT '21:30',
  feed_prompt text
);

CREATE TABLE user_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  appearance text NOT NULL DEFAULT 'system' CHECK (appearance IN ('system', 'light', 'dark')),
  notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  language_match boolean NOT NULL DEFAULT true,
  bluntness smallint NOT NULL DEFAULT 2 CHECK (bluntness BETWEEN 0 AND 4)
);

-- Conversation --------------------------------------------------------------

CREATE TABLE chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('main', 'side', 'group')),
  title text,
  travila_thread_id text UNIQUE,
  clean_room boolean NOT NULL DEFAULT false,
  pinned boolean NOT NULL DEFAULT false,
  archived_at timestamptz
);
-- One Main chat per user.
CREATE UNIQUE INDEX chats_one_main_per_user ON chats (user_id) WHERE kind = 'main';
CREATE INDEX chats_user_updated ON chats (user_id, updated_at DESC);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  travila_run_id text UNIQUE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'awaiting_tools', 'completed', 'failed', 'cancelled')),
  status_line text,
  model text,
  profile_version text,
  reasoning_effort text,
  started_at timestamptz,
  finished_at timestamptz,
  usage jsonb,
  error text
);
CREATE INDEX runs_chat ON runs (chat_id, created_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  sender_user_id uuid REFERENCES users(id),
  -- [{type: text|reasoning|card|artifact_ref|approval_ref|attachment_ref, ...}]
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  travila_message_id text,
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  origin text NOT NULL DEFAULT 'reply' CHECK (origin IN ('reply', 'proactive', 'correction')),
  language text,
  -- Lets a client retry a send after a dropped connection without creating a duplicate.
  client_message_id text
);
CREATE INDEX messages_chat ON messages (chat_id, created_at);
CREATE UNIQUE INDEX messages_client_id ON messages (chat_id, client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  travila_tool_call_id text,
  tool text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_decision text CHECK (policy_decision IN ('allow', 'deny', 'ask')),
  decision_reason text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'denied')),
  tainted boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (run_id, travila_tool_call_id)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  url text NOT NULL,
  title text,
  fetched_at timestamptz,
  content_hash text,
  origin text NOT NULL CHECK (origin IN ('search', 'fetch', 'browse')),
  injection_flag boolean NOT NULL DEFAULT false
);
CREATE INDEX sources_run ON sources (run_id);

-- Memory mirror --------------------------------------------------------------

CREATE TABLE memory_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  travila_memory_id text,
  type text NOT NULL CHECK (type IN ('fact', 'preference', 'decision', 'commitment')),
  text text NOT NULL,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  supersedes_id uuid REFERENCES memory_entries(id) ON DELETE SET NULL,
  forgotten_at timestamptz
);

-- Browser sessions (used from step 1d) ----------------------------------------

CREATE TABLE browser_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  bu_session_id text,
  bu_browser_id text,
  bu_profile_id text,
  bu_workspace_id text,
  status text NOT NULL DEFAULT 'starting',
  -- Encrypted by the application before it is stored; treated as a credential.
  live_view_url_ciphertext text,
  user_took_over_at timestamptz
);

-- updated_at triggers ----------------------------------------------------------

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER user_settings_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER chats_updated_at BEFORE UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Row-level security -----------------------------------------------------------

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_self ON users TO app_user
  USING (id = app_current_user()) WITH CHECK (id = app_current_user());
GRANT SELECT, UPDATE ON users TO app_user;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_settings', 'chats', 'runs', 'messages', 'tool_calls', 'sources',
                           'memory_entries', 'browser_sessions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO app_user USING (user_id = app_current_user()) '
                   'WITH CHECK (user_id = app_current_user())', t || '_owner', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

-- Sign-in happens before we know the user id, so it goes through this one function,
-- which runs as the table owner. It returns the user's id and Travila id.
CREATE FUNCTION app_sign_in(p_auth_subject text, p_email text, p_display_name text, p_timezone text)
  RETURNS TABLE (user_id uuid, travila_user_id text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO users (auth_subject, email, display_name, timezone, travila_user_id)
  VALUES (p_auth_subject, p_email, p_display_name, coalesce(p_timezone, 'UTC'),
          'aia_' || replace(gen_random_uuid()::text, '-', ''))
  ON CONFLICT (auth_subject) DO UPDATE
    SET email = coalesce(EXCLUDED.email, users.email),
        display_name = coalesce(EXCLUDED.display_name, users.display_name)
  RETURNING id INTO v_id;
  INSERT INTO user_settings (user_id) VALUES (v_id) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT u.id, u.travila_user_id FROM users u WHERE u.id = v_id;
END $$;
REVOKE ALL ON FUNCTION app_sign_in(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_sign_in(text, text, text, text) TO app_user;
