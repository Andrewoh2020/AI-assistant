-- The browser card and panel: the tabs open in the browser at the last picture (title, address,
-- which one was showing), when that picture was taken, and whether the site blocked the browser.
ALTER TABLE browser_sessions ADD COLUMN tabs jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE browser_sessions ADD COLUMN screenshot_at timestamptz;
ALTER TABLE browser_sessions ADD COLUMN blocked boolean NOT NULL DEFAULT false;
