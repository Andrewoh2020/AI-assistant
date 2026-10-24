-- Flights are now known by route and departure time (dedupeKey in apps/api/src/bookings.ts), so
-- the same flight under a codeshare number ("JL 8325" and "AA 6488") is one booking, not two.
-- This merges the duplicates saved before, moves flights to the new key, and renames trips after
-- where they go (destinationOf in apps/api/src/gmail.ts) instead of their first connection.

-- Times and dates as saved are checked loosely; one that doesn't parse counts as unknown.
CREATE OR REPLACE FUNCTION pg_temp.ts(text) RETURNS timestamp LANGUAGE plpgsql AS $$
BEGIN RETURN $1::timestamp; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION pg_temp.day(text) RETURNS date LANGUAGE plpgsql AS $$
BEGIN RETURN $1::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;

CREATE TEMP TABLE flight_keys ON COMMIT DROP AS
SELECT i.id, i.user_id, i.trip_id, i.created_at,
       'flight:' || lower(coalesce(i.details->>'fromCode', i.details->>'fromCity')) || '-'
         || lower(coalesce(i.details->>'toCode', i.details->>'toCity')) || ':'
         || lower(i.details->>'departAt') AS new_key,
       EXISTS (SELECT 1 FROM flight_plans p WHERE p.trip_item_id = i.id) AS planned
FROM trip_items i
WHERE i.kind = 'booking' AND i.details->>'kind' = 'flight'
  AND coalesce(i.details->>'fromCode', i.details->>'fromCity') IS NOT NULL
  AND coalesce(i.details->>'toCode', i.details->>'toCity') IS NOT NULL
  AND i.details->>'departAt' IS NOT NULL;

-- Of each set of copies, keep the one check-in is already working on, else the first saved.
CREATE TEMP TABLE flight_dupes ON COMMIT DROP AS
SELECT id AS dupe, trip_id, first_value(id) OVER w AS keeper, row_number() OVER w AS n
FROM flight_keys
WINDOW w AS (PARTITION BY user_id, new_key ORDER BY planned DESC, created_at, id);
DELETE FROM flight_dupes WHERE n = 1;

-- The kept copy keeps its own number, airline and booking reference, fills what it lacks from the
-- others, and remembers their numbers as codeshares.
UPDATE trip_items k
SET details = k.details || jsonb_strip_nulls(jsonb_build_object(
      'flightNumber', coalesce(k.details->>'flightNumber', m.numbers[1]),
      'airline', coalesce(k.details->>'airline', m.airline),
      'arriveAt', coalesce(k.details->>'arriveAt', m.arrive),
      'confirmation', coalesce(k.details->>'confirmation', m.confirmation),
      'codeshares', (SELECT jsonb_agg(DISTINCT n) FROM unnest(m.numbers) n
                     WHERE n IS DISTINCT FROM coalesce(k.details->>'flightNumber', m.numbers[1])))),
    confirmation_ref = coalesce(k.confirmation_ref, k.details->>'confirmation', m.confirmation),
    updated_at = now()
FROM (
  SELECT d.keeper,
         array_agg(i.details->>'flightNumber' ORDER BY i.created_at)
           FILTER (WHERE i.details->>'flightNumber' IS NOT NULL) AS numbers,
         (array_agg(i.details->>'airline' ORDER BY i.created_at)
           FILTER (WHERE i.details->>'airline' IS NOT NULL))[1] AS airline,
         (array_agg(i.details->>'arriveAt' ORDER BY i.created_at)
           FILTER (WHERE i.details->>'arriveAt' IS NOT NULL))[1] AS arrive,
         (array_agg(i.details->>'confirmation' ORDER BY i.created_at)
           FILTER (WHERE i.details->>'confirmation' IS NOT NULL))[1] AS confirmation
  FROM flight_dupes d JOIN trip_items i ON i.id = d.dupe
  GROUP BY d.keeper
) m
WHERE k.id = m.keeper;

UPDATE browser_sessions b SET trip_item_id = d.keeper FROM flight_dupes d WHERE b.trip_item_id = d.dupe;
DELETE FROM trip_items WHERE id IN (SELECT dupe FROM flight_dupes);
DELETE FROM trips t
WHERE t.id IN (SELECT trip_id FROM flight_dupes)
  AND NOT EXISTS (SELECT 1 FROM trip_items i WHERE i.trip_id = t.id);

UPDATE trip_items i SET dedupe_key = k.new_key
FROM flight_keys k
WHERE i.id = k.id AND i.dedupe_key IS DISTINCT FROM k.new_key;

-- Trip dates, destination and title, worked out from the bookings as refreshTrip does.
WITH bookings AS (
  SELECT trip_id, details d, item_date, created_at FROM trip_items WHERE kind = 'booking'
), legs AS (
  SELECT trip_id, d,
         row_number() OVER w AS n,
         count(*) OVER (PARTITION BY trip_id) AS total,
         lead(d->>'departAt') OVER w AS next_depart
  FROM bookings WHERE d->>'kind' = 'flight'
  WINDOW w AS (PARTITION BY trip_id ORDER BY d->>'departAt')
), ends AS (
  SELECT trip_id,
         max(total) > 1 AND CASE
           WHEN max(d->>'fromCode') FILTER (WHERE n = 1) IS NOT NULL
            AND max(d->>'toCode') FILTER (WHERE n = total) IS NOT NULL
           THEN max(d->>'fromCode') FILTER (WHERE n = 1) = max(d->>'toCode') FILTER (WHERE n = total)
           ELSE coalesce(lower(max(d->>'fromCity') FILTER (WHERE n = 1))
                         = lower(max(d->>'toCity') FILTER (WHERE n = total)), false)
         END AS round_trip,
         max(coalesce(d->>'toCity', d->>'toCode')) FILTER (WHERE n = total) AS last_place
  FROM legs GROUP BY trip_id
), longest AS (
  SELECT DISTINCT ON (trip_id) trip_id, coalesce(d->>'toCity', d->>'toCode') AS place
  FROM legs WHERE n < total
  ORDER BY trip_id,
           pg_temp.ts(next_depart) - pg_temp.ts(coalesce(d->>'arriveAt', d->>'departAt')) DESC NULLS LAST,
           n
), hotels AS (
  SELECT DISTINCT ON (trip_id) trip_id, d->>'city' AS city
  FROM bookings WHERE d->>'kind' = 'hotel' AND d->>'city' IS NOT NULL
  ORDER BY trip_id, item_date, created_at
), dates AS (
  SELECT trip_id,
         min(pg_temp.day(CASE WHEN d->>'kind' = 'flight' THEN left(d->>'departAt', 10)
                              ELSE d->>'checkIn' END)) AS starts,
         max(pg_temp.day(CASE WHEN d->>'kind' = 'flight'
                              THEN coalesce(left(d->>'arriveAt', 10), left(d->>'departAt', 10))
                              ELSE coalesce(d->>'checkOut', d->>'checkIn') END)) AS ends
  FROM bookings GROUP BY trip_id
), places AS (
  SELECT dt.trip_id, dt.starts, dt.ends,
         coalesce(h.city, CASE WHEN e.round_trip THEN l.place ELSE e.last_place END) AS destination
  FROM dates dt
  LEFT JOIN hotels h USING (trip_id)
  LEFT JOIN ends e USING (trip_id)
  LEFT JOIN longest l USING (trip_id)
)
UPDATE trips t
SET destination = p.destination,
    title = CASE WHEN p.destination IS NOT NULL THEN 'Trip to ' || p.destination ELSE 'Trip' END,
    starts_on = coalesce(p.starts, t.starts_on),
    ends_on = coalesce(p.ends, t.ends_on)
FROM places p
WHERE t.id = p.trip_id;
