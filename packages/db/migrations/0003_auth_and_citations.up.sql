-- Email + password sign-in, used until a hosted sign-in provider (Clerk in the plan) is chosen.
-- Password hashes live in their own table that the app role can't read directly; sign-up and
-- sign-in go through the two functions below, which run as the table owner.

CREATE TABLE auth_local_accounts (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL
);
ALTER TABLE auth_local_accounts ENABLE ROW LEVEL SECURITY;
-- No policy and no grants: app_user cannot see this table at all.

CREATE FUNCTION app_local_sign_up(p_email text, p_password_hash text, p_display_name text,
                                  p_timezone text)
  RETURNS TABLE (user_id uuid, travila_user_id text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
DECLARE v_user uuid; v_travila text;
BEGIN
  IF EXISTS (SELECT 1 FROM auth_local_accounts a WHERE a.email = lower(p_email)) THEN
    RAISE EXCEPTION 'email already registered' USING ERRCODE = 'unique_violation';
  END IF;
  SELECT s.user_id, s.travila_user_id INTO v_user, v_travila
    FROM app_sign_in('local:' || lower(p_email), lower(p_email), p_display_name, p_timezone) s;
  INSERT INTO auth_local_accounts (user_id, email, password_hash)
    VALUES (v_user, lower(p_email), p_password_hash);
  RETURN QUERY SELECT v_user, v_travila;
END $$;

CREATE FUNCTION app_local_account(p_email text)
  RETURNS TABLE (user_id uuid, travila_user_id text, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$
  SELECT u.id, u.travila_user_id, a.password_hash
    FROM auth_local_accounts a JOIN users u ON u.id = a.user_id
   WHERE a.email = lower(p_email)
$$;

REVOKE ALL ON FUNCTION app_local_sign_up(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_local_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_local_sign_up(text, text, text, text) TO app_user;
GRANT EXECUTE ON FUNCTION app_local_account(text) TO app_user;

-- Citation numbers: each source a run collects gets a number [1], [2]... that the model cites
-- and the Sources list shows. The same URL keeps one number within a run.
ALTER TABLE sources ADD COLUMN ref_number integer;
ALTER TABLE sources ADD COLUMN site_name text;
ALTER TABLE sources ADD COLUMN published_at timestamptz;
CREATE UNIQUE INDEX sources_run_ref ON sources (run_id, ref_number);
CREATE UNIQUE INDEX sources_run_url ON sources (run_id, url);
