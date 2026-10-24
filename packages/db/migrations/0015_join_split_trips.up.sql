-- Joins trips that were split in two before fileBooking (apps/api/src/gmail.ts) filed bookings
-- one at a time: legs of one journey saved at the same moment each started a trip
-- (Mumbai-Doha-Philadelphia became "Trip to Doha" and "Trip to Philadelphia"). Two of a person's
-- trips within two days of each other become one, as a new booking would. Flights further apart
-- are left alone: without knowing where the person lives, a flight home can't be told from the
-- start of a new trip. Then trips are renamed and re-dated as in 0014.

CREATE OR REPLACE FUNCTION pg_temp.ts(text) RETURNS timestamp LANGUAGE plpgsql AS $$
BEGIN RETURN $1::timestamp; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION pg_temp.day(text) RETURNS date LANGUAGE plpgsql AS $$
BEGIN RETURN $1::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;

DO $$
DECLARE
  pair record;
BEGIN
  LOOP
    SELECT a.id AS keep, b.id AS absorb INTO pair
    FROM trips a
    JOIN trips b ON b.user_id = a.user_id AND b.id <> a.id
    WHERE a.starts_on IS NOT NULL AND b.starts_on IS NOT NULL
      AND (a.starts_on, a.id) < (b.starts_on, b.id)
      AND b.starts_on - 2 <= a.ends_on
    ORDER BY a.starts_on, b.starts_on
    LIMIT 1;
    EXIT WHEN NOT FOUND;
    UPDATE trip_items SET trip_id = pair.keep WHERE trip_id = pair.absorb;
    DELETE FROM trips WHERE id = pair.absorb;
    -- The kept trip's dates now cover both, so the next pass sees the joined journey.
    UPDATE trips t SET starts_on = d.starts, ends_on = d.ends
    FROM (
      SELECT min(pg_temp.day(CASE WHEN details->>'kind' = 'flight' THEN left(details->>'departAt', 10)
                                  ELSE details->>'checkIn' END)) AS starts,
             max(pg_temp.day(CASE WHEN details->>'kind' = 'flight'
                                  THEN coalesce(left(details->>'arriveAt', 10), left(details->>'departAt', 10))
                                  ELSE coalesce(details->>'checkOut', details->>'checkIn') END)) AS ends
      FROM trip_items WHERE trip_id = pair.keep AND kind = 'booking'
    ) d
    WHERE t.id = pair.keep AND d.starts IS NOT NULL;
  END LOOP;
END $$;

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
