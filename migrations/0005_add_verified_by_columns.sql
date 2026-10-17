-- Add supervisor verification attribution columns to attendance records in Cloudflare D1
ALTER TABLE attendance_records ADD COLUMN verified_by_name TEXT;
ALTER TABLE attendance_records ADD COLUMN verified_by_id INTEGER;
