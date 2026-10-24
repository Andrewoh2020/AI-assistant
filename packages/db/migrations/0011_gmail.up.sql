-- Gmail connector: connect Gmail, spot flight and hotel bookings in it, and keep them as trips.
-- The Google sign-in token is a secret, so it lives in the vault schema ("connected accounts" in
-- /mnt/project-files/design/vault-plan.html). The rest of the app only sees whether Gmail is
-- connected, which address, and when it was last checked.

CREATE TABLE vault.connected_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL CHECK (provider IN ('gmail')),
  -- The refresh token, sealed with the row's own key, which is sealed with the master key.
  sealed bytea NOT NULL,
  wrapped_key bytea NOT NULL,
  key_id text NOT NULL,
  UNIQUE (user_id, provider)
);
ALTER TABLE vault.connected_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY connected_accounts_owner ON vault.connected_accounts TO vault_service
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON vault.connected_accounts TO vault_service;

ALTER TABLE connector_accounts
  ADD COLUMN account_email text,
  ADD COLUMN scopes text,
  ADD COLUMN last_synced_at timestamptz,
  -- A check in progress, so two requests don't read the same mail at once (a 2-minute lease).
  ADD COLUMN sync_started_at timestamptz,
  ADD COLUMN last_error text;
CREATE UNIQUE INDEX connector_accounts_one_per_provider ON connector_accounts (user_id, provider);

-- Emails already read, so each is only ever sent to the model once.
CREATE TABLE gmail_scanned (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  bookings integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, message_id)
);
ALTER TABLE gmail_scanned ENABLE ROW LEVEL SECURITY;
CREATE POLICY gmail_scanned_owner ON gmail_scanned TO app_user
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON gmail_scanned TO app_user;

ALTER TABLE trips
  ADD COLUMN starts_on date,
  ADD COLUMN ends_on date,
  ADD COLUMN destination text;

-- One row per flight or hotel stay. dedupe_key ("flight:NH7:2026-11-03", "hotel:abc123") makes a
-- change email update the booking instead of adding a second one.
ALTER TABLE trip_items
  ADD COLUMN dedupe_key text,
  ADD COLUMN source text CHECK (source IN ('gmail', 'chat')),
  ADD COLUMN source_message_id text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX trip_items_dedupe ON trip_items (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
