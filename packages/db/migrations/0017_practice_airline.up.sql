-- Ability Practice Air: a pretend airline on our own site, so check-in can be tried from start to
-- finish without a real flight (flights "ZZ 101" and so on). Each check-in it takes is kept, so
-- what the browser typed and chose can be checked. The passport number itself is never kept, only
-- whether it matched the one saved in the vault.
CREATE TABLE practice_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_item_id uuid NOT NULL REFERENCES trip_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  seat text NOT NULL,
  -- {"firstName", "lastName", "dateOfBirth", "gender", "nationality", "passportMatched",
  --  "passportExpiry", "passportCountry", "extras": [...], "restrictedItems": true}
  details jsonb NOT NULL
);
CREATE INDEX practice_checkins_item ON practice_checkins (trip_item_id, created_at DESC);
ALTER TABLE practice_checkins ENABLE ROW LEVEL SECURITY;
CREATE POLICY practice_checkins_owner ON practice_checkins TO app_user
  USING (user_id = app_current_user()) WITH CHECK (user_id = app_current_user());
GRANT SELECT, INSERT, DELETE ON practice_checkins TO app_user;

-- The practice airline's booking lookup, like a real airline's: a booking reference and the last
-- name on it find one practice flight, and nothing else. Ids only; the rest is read as its owner.
CREATE FUNCTION app_practice_booking(p_reference text, p_last_name text)
  RETURNS TABLE (user_id uuid, trip_item_id uuid)
  LANGUAGE sql SECURITY DEFINER SET search_path = public
  AS $$
    SELECT i.user_id, i.id FROM trip_items i JOIN travel_profiles p ON p.user_id = i.user_id
    WHERE i.kind = 'booking' AND i.details->>'kind' = 'flight'
      AND i.details->>'flightNumber' ILIKE 'ZZ %'
      AND upper(i.confirmation_ref) = upper(btrim(p_reference))
      AND upper(btrim(p.last_name)) = upper(btrim(p_last_name))
      AND length(btrim(p_reference)) >= 5
    ORDER BY i.created_at DESC LIMIT 1
  $$;
REVOKE ALL ON FUNCTION app_practice_booking(text, text) FROM PUBLIC;
