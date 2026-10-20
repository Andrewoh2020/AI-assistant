-- Text read out of files people attach (PDF, Word, text), so the assistant answers from it
-- directly instead of opening the file in the browser. Separate from `files` so listing files
-- never reads their text.
CREATE TABLE file_texts (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL,
  pages integer
);
ALTER TABLE file_texts ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_texts_owner ON file_texts TO app_user
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON file_texts TO app_user;

-- The browser card: a short name for the job ("Check GitHub notifications") and a picture of
-- the last page the browser showed (a file of kind 'generated').
ALTER TABLE browser_sessions ADD COLUMN title text;
ALTER TABLE browser_sessions ADD COLUMN screenshot_file_id uuid REFERENCES files(id) ON DELETE SET NULL;
