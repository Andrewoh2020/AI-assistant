-- Tables for phases 2 to 7 (architecture plan, section 6). Created now so the schema is complete
-- and ids and relations never change; the features that use them ship later.
-- Phase noted beside each table.

-- Identity: devices (after 2), plans and usage (4) ---------------------------------

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  push_token text,
  paired_at timestamptz,
  last_seen_at timestamptz
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL
);

CREATE TABLE usage_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  period_start timestamptz NOT NULL,
  reset_at timestamptz NOT NULL,
  tokens_used bigint NOT NULL DEFAULT 0,
  cost numeric(12, 4) NOT NULL DEFAULT 0,
  percent_used numeric(5, 2) NOT NULL DEFAULT 0
);

-- Conversation: group chat participants (5) -------------------------------------

CREATE TABLE chat_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- owner of the chat
  created_at timestamptz NOT NULL DEFAULT now(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  participant_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  external_contact jsonb,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  CHECK (participant_user_id IS NOT NULL OR external_contact IS NOT NULL)
);

-- Files, artifacts and media (2, 5) ------------------------------------------------

CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (kind IN ('upload', 'generated', 'artifact', 'browser_download')),
  storage text NOT NULL CHECK (storage IN ('travila', 'browser_use_workspace', 'own')),
  storage_key text NOT NULL,
  name text,
  mime text,
  bytes bigint,
  sha256 text
);

CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE
);

-- Goals and jobs (4) --------------------------------------------------------------

CREATE TABLE goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  slug text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  parent_goal_id uuid REFERENCES goals(id) ON DELETE SET NULL,
  muted boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  UNIQUE (user_id, slug)
);

CREATE TABLE artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  format text NOT NULL,
  current_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  source_tree_key text,
  chat_id uuid REFERENCES chats(id) ON DELETE SET NULL,
  goal_id uuid REFERENCES goals(id) ON DELETE SET NULL
);

CREATE TABLE media_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  prompt text,
  source text NOT NULL CHECK (source IN ('generated', 'upload', 'library')),
  parent_media_id uuid REFERENCES media_items(id) ON DELETE SET NULL,
  surface_type text
);

CREATE TABLE goal_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  entry_date date NOT NULL,
  text text NOT NULL
);

CREATE TABLE briefings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  goal_id uuid NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  body text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  goal_id uuid REFERENCES goals(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('cron', 'hook')),
  schedule text,
  travila_schedule_id text,
  instructions text NOT NULL, -- saved verbatim
  last_run_at timestamptz,
  watermark jsonb,
  approved_by_message_id uuid REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  travila_execution_id text,
  outcome text CHECK (outcome IN ('new', 'unchanged', 'failed')),
  surfaced_message_id uuid REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  ref_type text,
  ref_id uuid,
  channel text NOT NULL,
  sent_at timestamptz,
  suppressed_reason text
    CHECK (suppressed_reason IN ('quiet_hours', 'muted', 'closed_topic', 'already_offered'))
);

-- Ideas and Feed (5) --------------------------------------------------------------

CREATE TABLE ideas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  rationale text,
  status text NOT NULL DEFAULT 'shown' CHECK (status IN ('shown', 'built', 'dismissed', 'expired')),
  origin_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz,
  built_ref jsonb
);

CREATE TABLE feed_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  media_file_id uuid REFERENCES files(id) ON DELETE SET NULL,
  origin_idea_id uuid REFERENCES ideas(id) ON DELETE SET NULL,
  published_at timestamptz
);

-- Memory extras (2, 6) ----------------------------------------------------------

CREATE TABLE alignment_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  body text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  closeness_rank smallint,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text
);

CREATE TABLE groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text
);

CREATE TABLE group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  group_id uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  UNIQUE (group_id, person_id)
);

CREATE TABLE closed_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  topic text NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now(),
  reopened_at timestamptz,
  source_message_id uuid REFERENCES messages(id) ON DELETE SET NULL
);

CREATE TABLE shopping_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sizes jsonb NOT NULL DEFAULT '{}'::jsonb,
  brands jsonb NOT NULL DEFAULT '[]'::jsonb,
  budget_habits jsonb NOT NULL DEFAULT '{}'::jsonb,
  delivery_prefs jsonb NOT NULL DEFAULT '{}'::jsonb -- never card data
);

-- Permissions, approvals and connectors (3) -----------------------------------------

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid REFERENCES runs(id) ON DELETE SET NULL,
  tool_call_id uuid REFERENCES tool_calls(id) ON DELETE SET NULL,
  travila_tool_call_id text,
  payload jsonb NOT NULL, -- verbatim JSON shown on the card
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  decided_at timestamptz
);

CREATE TABLE permission_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  scope text NOT NULL CHECK (scope IN ('one_time', 'session', 'task', 'time_bound', 'perpetual')),
  target jsonb NOT NULL,
  expires_at timestamptz,
  from_approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  revoked_at timestamptz
);

CREATE TABLE connector_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL,
  travila_account_ref text,
  status text NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('connected', 'not_connected', 'error')),
  last_health_check_at timestamptz
);

-- Commerce and travel (6) --------------------------------------------------------

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  merchant text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivered_total numeric(12, 2),
  currency text,
  approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  merchant_order_ref text, -- copied verbatim
  tracking jsonb
);

CREATE TABLE price_watches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  product_ref jsonb NOT NULL,
  target_price numeric(12, 2),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  title text,
  status text NOT NULL DEFAULT 'planning'
);

CREATE TABLE trip_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('idea', 'choice', 'booking')),
  item_date date,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmation_ref text,
  documents_needed jsonb
);

-- Row-level security for every table above ---------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['devices', 'plans', 'usage_periods', 'chat_participants', 'files',
    'attachments', 'goals', 'artifacts', 'media_items', 'goal_progress', 'briefings', 'jobs',
    'job_runs', 'notifications', 'ideas', 'feed_posts', 'alignment_digests', 'people', 'groups',
    'group_members', 'closed_topics', 'shopping_profiles', 'approvals', 'permission_grants',
    'connector_accounts', 'orders', 'price_watches', 'trips', 'trip_items']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO app_user USING (user_id = app_current_user()) '
                   'WITH CHECK (user_id = app_current_user())', t || '_owner', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

CREATE TRIGGER goals_updated_at BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER artifacts_updated_at BEFORE UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Password vault (3) ------------------------------------------------------------
-- Its own schema. app_user gets NO access: only the vault service's database role
-- (created when the vault ships in phase 3) will be granted it.

CREATE SCHEMA vault;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;

CREATE TABLE vault.credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL CHECK (origin LIKE 'https://%'),
  username_hint text,
  secret_ciphertext bytea NOT NULL,
  key_id text NOT NULL,
  created_via text NOT NULL DEFAULT 'capture_page',
  last_used_at timestamptz
);

CREATE TABLE vault.credential_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), -- the [credential:<uuid>] the agent handles
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  credential_id uuid NOT NULL REFERENCES vault.credentials(id) ON DELETE CASCADE,
  origin text NOT NULL,
  challenge_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
