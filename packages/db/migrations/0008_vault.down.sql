ALTER TABLE browser_sessions
  DROP COLUMN IF EXISTS ask_saved_account,
  DROP COLUMN IF EXISTS ask_problem,
  DROP COLUMN IF EXISTS sign_in_note,
  DROP COLUMN IF EXISTS vault_credential_id,
  DROP COLUMN IF EXISTS sign_in_site,
  DROP COLUMN IF EXISTS sign_in_by;
DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS vault.credential_refs;
DROP TABLE IF EXISTS vault.credentials;
DROP TABLE IF EXISTS vault.import_batches;
REVOKE ALL ON SCHEMA vault FROM vault_service;
REVOKE USAGE ON SCHEMA public FROM vault_service;

-- The placeholder tables from 0002.
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  credential_id uuid NOT NULL REFERENCES vault.credentials(id) ON DELETE CASCADE,
  origin text NOT NULL,
  challenge_id text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
