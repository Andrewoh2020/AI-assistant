-- Google Calendar: flights the person has only in their calendar (an event Gmail added, or one they
-- made) become trips too. Connected like Gmail, with its account id kept in the vault.
ALTER TABLE vault.connected_accounts DROP CONSTRAINT connected_accounts_provider_check;
ALTER TABLE vault.connected_accounts ADD CONSTRAINT connected_accounts_provider_check
  CHECK (provider IN ('gmail', 'google_calendar'));

ALTER TABLE trip_items DROP CONSTRAINT trip_items_source_check;
ALTER TABLE trip_items ADD CONSTRAINT trip_items_source_check
  CHECK (source IN ('gmail', 'chat', 'calendar'));

-- Flight-like events already read, so each goes to the model once (again only if it changes).
CREATE TABLE calendar_scanned (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_updated text NOT NULL,
  scanned_at timestamptz NOT NULL DEFAULT now(),
  bookings integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, event_id)
);
ALTER TABLE calendar_scanned ENABLE ROW LEVEL SECURITY;
CREATE POLICY calendar_scanned_owner ON calendar_scanned TO app_user
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON calendar_scanned TO app_user;

-- People with Gmail or Google Calendar connected, so new bookings are found with the app closed.
CREATE OR REPLACE FUNCTION app_gmail_users(p_limit integer)
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    SELECT user_id FROM connector_accounts
    WHERE provider IN ('gmail', 'google_calendar') AND status = 'connected'
    GROUP BY user_id
    ORDER BY bool_or(last_synced_at IS NULL) DESC, min(last_synced_at) LIMIT p_limit
  $$;
