-- The password vault, step V1 (docs: /mnt/project-files/design/vault-plan.html).
-- Saved logins live in the vault schema, which only the vault service's role can open. app_user
-- (every request, and so the assistant) has no access at all; a test checks that.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'vault_service') THEN
    CREATE ROLE vault_service NOLOGIN;
  END IF;
END $$;
GRANT vault_service TO CURRENT_USER;
GRANT USAGE ON SCHEMA vault TO vault_service;
GRANT USAGE ON SCHEMA public TO vault_service;

-- The placeholder tables from 0002 were never used; they are replaced with the vault plan's shape.
DROP TABLE vault.credential_refs;
DROP TABLE vault.credentials;

CREATE TABLE vault.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  manager text NOT NULL,
  imported integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0
);

-- One saved login. The username and password are sealed with the login's own key, and that key is
-- sealed with the master key (envelope encryption), so a copy of the database alone opens nothing.
CREATE TABLE vault.credentials (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The only site it may ever be typed into, like "github.com".
  site text NOT NULL CHECK (site ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
  -- The account as the person typed it, shown in the Vault page and the sign-in box.
  account text NOT NULL DEFAULT '',
  login_path text,
  sealed bytea NOT NULL,
  -- Authenticator key for 2-step codes (V4), sealed with the same key.
  sealed_otp bytea,
  wrapped_key bytea NOT NULL,
  key_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('typed', 'imported')),
  import_batch_id uuid REFERENCES vault.import_batches(id) ON DELETE SET NULL,
  ask_before_use boolean NOT NULL DEFAULT false,
  last_result text CHECK (last_result IN ('worked', 'rejected')),
  last_result_at timestamptz,
  last_used_at timestamptz,
  UNIQUE (user_id, site, account)
);

CREATE TABLE vault.credential_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  credential_id uuid NOT NULL REFERENCES vault.credentials(id) ON DELETE CASCADE,
  origin text NOT NULL,
  challenge_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['import_batches', 'credentials', 'credential_refs']
  LOOP
    EXECUTE format('ALTER TABLE vault.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON vault.%I TO vault_service USING (user_id = app_current_user()) '
                   'WITH CHECK (user_id = app_current_user())', t || '_owner', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON vault.%I TO vault_service', t);
  END LOOP;
END $$;

-- What happened to saved logins, for the Vault page's activity list. There is no column that
-- could hold a secret. The vault service writes it; the person can read their own.
CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL CHECK (action IN ('saved', 'replaced', 'used', 'worked', 'rejected',
                                         'deleted', 'imported', 'ask_on', 'ask_off')),
  site text,
  account text,
  detail text,
  browser_session_id uuid
);
CREATE INDEX audit_events_user ON audit_events (user_id, created_at DESC);
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_read ON audit_events FOR SELECT TO app_user
  USING (user_id = app_current_user());
CREATE POLICY audit_events_vault ON audit_events TO vault_service
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT ON audit_events TO app_user;
GRANT SELECT, INSERT ON audit_events TO vault_service;

-- The browser card: which sign-in was last sent (typed in the box, or a saved login), so a second
-- sign-in page on the same site is known to mean "rejected"; and what the box should say.
ALTER TABLE browser_sessions
  ADD COLUMN sign_in_by text CHECK (sign_in_by IN ('typed', 'saved')),
  ADD COLUMN sign_in_site text,
  ADD COLUMN vault_credential_id uuid,
  ADD COLUMN sign_in_note text,
  ADD COLUMN ask_problem text CHECK (ask_problem IN ('saved_rejected', 'typed_rejected')),
  ADD COLUMN ask_saved_account text;
