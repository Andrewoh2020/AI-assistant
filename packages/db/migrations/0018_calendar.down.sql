CREATE OR REPLACE FUNCTION app_gmail_users(p_limit integer)
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    SELECT user_id FROM connector_accounts
    WHERE provider = 'gmail' AND status = 'connected'
    ORDER BY last_synced_at NULLS FIRST LIMIT p_limit
  $$;
DROP TABLE calendar_scanned;
DELETE FROM connector_accounts WHERE provider = 'google_calendar';
UPDATE trip_items SET source = 'chat' WHERE source = 'calendar';
ALTER TABLE trip_items DROP CONSTRAINT trip_items_source_check;
ALTER TABLE trip_items ADD CONSTRAINT trip_items_source_check CHECK (source IN ('gmail', 'chat'));
DELETE FROM vault.connected_accounts WHERE provider = 'google_calendar';
ALTER TABLE vault.connected_accounts DROP CONSTRAINT connected_accounts_provider_check;
ALTER TABLE vault.connected_accounts ADD CONSTRAINT connected_accounts_provider_check
  CHECK (provider = 'gmail');
