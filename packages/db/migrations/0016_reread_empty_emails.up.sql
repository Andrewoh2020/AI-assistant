-- Emails whose plain-text part was a single line (AirAsia) were read as having no bookings. Forget
-- the emails where nothing was found, and look back as on the first check, so they're read again.
DELETE FROM gmail_scanned WHERE bookings = 0;
UPDATE connector_accounts SET last_synced_at = NULL WHERE provider = 'gmail';
