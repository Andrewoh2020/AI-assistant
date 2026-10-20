UPDATE browser_sessions SET ask_problem = NULL WHERE ask_problem = 'saved_code_rejected';
ALTER TABLE browser_sessions DROP CONSTRAINT browser_sessions_ask_problem_check;
ALTER TABLE browser_sessions ADD CONSTRAINT browser_sessions_ask_problem_check
  CHECK (ask_problem IN ('saved_rejected', 'typed_rejected'));
ALTER TABLE browser_sessions DROP COLUMN IF EXISTS code_site, DROP COLUMN IF EXISTS code_by;

DELETE FROM audit_events WHERE action IN ('code_saved', 'code_removed', 'code_used');
ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_check
  CHECK (action IN ('saved', 'replaced', 'used', 'worked', 'rejected', 'deleted', 'imported',
                    'ask_on', 'ask_off'));
