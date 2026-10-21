-- People can see and change their own saved logins in Settings; both are logged.

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check
  CHECK (action IN ('saved', 'replaced', 'used', 'worked', 'rejected', 'deleted', 'imported',
                    'ask_on', 'ask_off', 'code_saved', 'code_removed', 'code_used',
                    'viewed', 'edited'));
