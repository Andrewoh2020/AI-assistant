-- Sign-in through Clerk ("Continue with Google" or a code emailed to you), plus first-run
-- onboarding. Clerk proves who someone is; our own session cookie still carries them after that.

-- Set when the person finishes (or skips) the welcome questions. People who already had an
-- account count as onboarded, so nobody already using the app is sent through it.
ALTER TABLE users ADD COLUMN onboarded_at timestamptz;
UPDATE users SET onboarded_at = created_at;

-- Finds or creates the user behind a Clerk account. Clerk has already checked the email (Google,
-- or the emailed code), so the first Clerk sign-in with the email of an existing email + password
-- account takes that account over, keeping its chats, vault and trips. p_allow_new is false for
-- someone without an invite: they can only sign in to an account that already exists.
CREATE FUNCTION app_clerk_sign_in(p_clerk_id text, p_email text, p_display_name text,
                                  p_timezone text, p_allow_new boolean)
  RETURNS TABLE (user_id uuid, travila_user_id text, onboarded boolean, timezone text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
DECLARE v_id uuid; v_subject text := 'clerk:' || p_clerk_id;
BEGIN
  SELECT u.id INTO v_id FROM users u WHERE u.auth_subject = v_subject;
  IF v_id IS NULL AND p_email IS NOT NULL THEN
    SELECT u.id INTO v_id FROM users u
     WHERE u.auth_subject = 'local:' || lower(p_email)
     LIMIT 1;
    IF v_id IS NOT NULL THEN
      UPDATE users SET auth_subject = v_subject WHERE id = v_id;
    END IF;
  END IF;
  IF v_id IS NULL THEN
    IF NOT p_allow_new THEN
      RAISE EXCEPTION 'not invited' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT s.user_id INTO v_id
      FROM app_sign_in(v_subject, lower(p_email), p_display_name, p_timezone) s;
  ELSE
    UPDATE users SET email = coalesce(lower(p_email), email) WHERE id = v_id;
  END IF;
  RETURN QUERY SELECT u.id, u.travila_user_id, u.onboarded_at IS NOT NULL, u.timezone
                 FROM users u WHERE u.id = v_id;
END $$;
REVOKE ALL ON FUNCTION app_clerk_sign_in(text, text, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_clerk_sign_in(text, text, text, text, boolean) TO app_user;
