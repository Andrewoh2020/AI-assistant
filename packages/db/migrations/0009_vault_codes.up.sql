-- Vault step V4: 2-step codes from a saved authenticator key (sealed in vault.credentials.sealed_otp).

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check
  CHECK (action IN ('saved', 'replaced', 'used', 'worked', 'rejected', 'deleted', 'imported',
                    'ask_on', 'ask_off', 'code_saved', 'code_removed', 'code_used'));

-- The last one-time code sent to the site: typed in the box, or made from a saved key.
ALTER TABLE browser_sessions
  ADD COLUMN code_by text CHECK (code_by IN ('typed', 'saved')),
  ADD COLUMN code_site text;
ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_ask_problem_check;
ALTER TABLE browser_sessions ADD CONSTRAINT browser_sessions_ask_problem_check
  CHECK (ask_problem IN ('saved_rejected', 'typed_rejected', 'saved_code_rejected'));
