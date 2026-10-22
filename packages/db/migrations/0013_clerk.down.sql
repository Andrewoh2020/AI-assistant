DROP FUNCTION IF EXISTS app_clerk_sign_in(text, text, text, text, boolean);
ALTER TABLE users DROP COLUMN IF EXISTS onboarded_at;
