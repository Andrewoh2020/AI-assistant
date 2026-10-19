DROP INDEX IF EXISTS sources_run_url;
DROP INDEX IF EXISTS sources_run_ref;
ALTER TABLE sources DROP COLUMN IF EXISTS published_at, DROP COLUMN IF EXISTS site_name,
  DROP COLUMN IF EXISTS ref_number;
DROP FUNCTION IF EXISTS app_local_account(text);
DROP FUNCTION IF EXISTS app_local_sign_up(text, text, text, text);
DROP TABLE IF EXISTS auth_local_accounts;
