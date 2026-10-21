ALTER TABLE browser_sessions DROP COLUMN trip_item_id;
ALTER TABLE browser_sessions DROP COLUMN chat_id;
ALTER TABLE browser_sessions DROP COLUMN purpose;
DROP FUNCTION app_gmail_users(integer);
DROP FUNCTION IF EXISTS app_next_flight_due();
DROP FUNCTION app_due_flights(timestamptz, integer);
DROP TABLE flight_plans;
DROP TABLE vault.travel_documents;
DROP TABLE travel_profiles;
