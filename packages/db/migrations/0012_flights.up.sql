-- Flights: check-in by itself, the trip card, live status, time to leave and arrival cards.
-- Plan: /mnt/project-files/design/checkin-plan.html (Option A, chosen by Andrew 2026-10-21).

-- Travel details the person gives once and is never asked for again. Personal but not secret
-- details live here; passport, Known Traveler and frequent flyer numbers are sealed in
-- vault.travel_documents, and only the vault code opens them.
CREATE TABLE travel_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  first_name text,
  middle_name text,
  last_name text,
  date_of_birth date,
  gender text CHECK (gender IN ('female', 'male', 'x')),
  -- ISO country codes, like "US".
  nationality text CHECK (nationality ~ '^[A-Z]{2}$'),
  passport_country text CHECK (passport_country ~ '^[A-Z]{2}$'),
  passport_expiry date,
  -- Where the "time to leave" reminder starts from for flights from home.
  home_address text,
  -- Left empty on a trip card: not asked again (the leave reminder allows an hour instead).
  skipped_home_address boolean NOT NULL DEFAULT false,
  seat_side text CHECK (seat_side IN ('window', 'aisle', 'any')),
  seat_zone text CHECK (seat_zone IN ('front', 'middle', 'back', 'any')),
  seat_empty_nearby boolean,
  seat_avoid_washroom boolean,
  -- Which secret details are saved in the vault ("passport", "known_traveler", "ff:UA"), so the
  -- app knows what not to ask for without opening the vault.
  saved_documents text[] NOT NULL DEFAULT '{}',
  -- "No" answers, remembered so the question is never asked again.
  no_known_traveler boolean NOT NULL DEFAULT false,
  no_frequent_flyer text[] NOT NULL DEFAULT '{}',
  -- Answers to extra questions an airline or arrival form asked (like an emergency contact).
  answers jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE vault.travel_documents (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- {"passportNumber", "knownTravelerNumber", "frequentFlyer": {"UA": "..."}}, sealed with the
  -- row's own key, which is sealed with the master key.
  sealed bytea NOT NULL,
  wrapped_key bytea NOT NULL,
  key_id text NOT NULL
);
ALTER TABLE vault.travel_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY travel_documents_owner ON vault.travel_documents TO vault_service
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, UPDATE, DELETE ON vault.travel_documents TO vault_service;

-- One row per flight the person is on: everything the assistant does for that flight.
CREATE TABLE flight_plans (
  trip_item_id uuid PRIMARY KEY REFERENCES trip_items(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The booked times as real moments (the booking only has airport-local times).
  depart_at timestamptz,
  arrive_at timestamptz,
  -- The trip card in the Main chat.
  card_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  -- The person's own statement, per flight: "I'm not carrying any banned items".
  no_banned_items boolean NOT NULL DEFAULT false,
  auto_checkin boolean NOT NULL DEFAULT true,

  checkin_status text NOT NULL DEFAULT 'scheduled' CHECK (checkin_status IN
    ('scheduled', 'waiting_for_you', 'running', 'done', 'airport', 'backup', 'off', 'past')),
  -- When check-in opens, or when the next try is due.
  checkin_due_at timestamptz,
  checkin_tries integer NOT NULL DEFAULT 0,
  -- The one question the airline asked that we couldn't answer, shown on the card.
  checkin_question text,
  -- Why it couldn't finish online (airport check-in, the backup link), in plain words.
  checkin_note text,
  -- {"seat", "group", "terminal", "gate", "skipped": [...], "mismatch"}.
  checkin_result jsonb,
  checkin_browser_id uuid REFERENCES browser_sessions(id) ON DELETE SET NULL,
  boarding_pass_file_id uuid REFERENCES files(id) ON DELETE SET NULL,

  -- Arrival card (Singapore, Thailand): ISO country of arrival, when there is a form we file.
  arrival_country text,
  arrival_status text NOT NULL DEFAULT 'not_needed' CHECK (arrival_status IN
    ('not_needed', 'scheduled', 'ready', 'running', 'done', 'waiting_for_you', 'backup')),
  arrival_due_at timestamptz,
  arrival_tries integer NOT NULL DEFAULT 0,
  arrival_question text,
  arrival_note text,
  -- The person tapped "Looks right, submit" on the answers (health and customs are theirs).
  arrival_confirmed boolean NOT NULL DEFAULT false,
  arrival_browser_id uuid REFERENCES browser_sessions(id) ON DELETE SET NULL,
  arrival_file_id uuid REFERENCES files(id) ON DELETE SET NULL,

  -- Live flight status (FlightAware): {"status", "departAt", "arriveAt", "terminal", "gate", ...}.
  live jsonb,
  live_checked_at timestamptz,
  -- Time to leave: when to go, and how ({"mode", "minutes", "options": [...]}).
  leave_by timestamptz,
  leave_plan jsonb,
  -- Messages already sent for this flight ("prep_reminder", "leave", "delay:45", ...).
  sent text[] NOT NULL DEFAULT '{}',

  -- When the scheduler should next look at this flight, and who is looking now (a lease).
  next_due_at timestamptz,
  lease_until timestamptz,
  -- The person changed something while the flight was being looked at: look again right away.
  poked boolean NOT NULL DEFAULT false
);
CREATE INDEX flight_plans_due ON flight_plans (next_due_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['travel_profiles', 'flight_plans']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I TO app_user USING (user_id = app_current_user()) '
                   'WITH CHECK (user_id = app_current_user())', t || '_owner', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t);
  END LOOP;
END $$;

-- The scheduler works for everyone, so it needs to see whose flights are due. These two functions
-- are the only way past row-level security for it, and they return ids only.
CREATE FUNCTION app_due_flights(p_now timestamptz, p_limit integer)
  RETURNS TABLE (user_id uuid, trip_item_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    SELECT user_id, trip_item_id FROM flight_plans
    WHERE next_due_at <= p_now AND (lease_until IS NULL OR lease_until < p_now)
    ORDER BY next_due_at LIMIT p_limit
  $$;
REVOKE ALL ON FUNCTION app_due_flights(timestamptz, integer) FROM PUBLIC;

-- When the next flight needs looking at, so the scheduler can sleep until then.
CREATE FUNCTION app_next_flight_due()
  RETURNS timestamptz
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$ SELECT min(next_due_at) FROM flight_plans $$;
REVOKE ALL ON FUNCTION app_next_flight_due() FROM PUBLIC;

-- People with Gmail connected, so new booking emails are found even when the app is closed.
CREATE FUNCTION app_gmail_users(p_limit integer)
  RETURNS TABLE (user_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    SELECT user_id FROM connector_accounts
    WHERE provider = 'gmail' AND status = 'connected'
    ORDER BY last_synced_at NULLS FIRST LIMIT p_limit
  $$;
REVOKE ALL ON FUNCTION app_gmail_users(integer) FROM PUBLIC;

-- Check-ins and arrival cards run in a browser with nobody watching; their browser sessions belong
-- to the flight rather than to a chat reply.
ALTER TABLE browser_sessions ADD COLUMN purpose text NOT NULL DEFAULT 'chat'
  CHECK (purpose IN ('chat', 'checkin', 'arrival_card'));
ALTER TABLE browser_sessions ADD COLUMN chat_id uuid REFERENCES chats(id) ON DELETE SET NULL;
ALTER TABLE browser_sessions ADD COLUMN trip_item_id uuid REFERENCES trip_items(id) ON DELETE CASCADE;
