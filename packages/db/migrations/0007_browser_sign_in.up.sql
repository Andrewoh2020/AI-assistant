-- The secure sign-in box: what the browser is asking for (a sign-in, or a one-time code) and the
-- site it will be typed into. The person's password itself is never stored; it goes straight to
-- Browser Use with the follow-up run.
ALTER TABLE browser_sessions ADD COLUMN ask_kind text CHECK (ask_kind IN ('sign_in', 'code'));
ALTER TABLE browser_sessions ADD COLUMN ask_site text;
