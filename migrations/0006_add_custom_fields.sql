-- Add custom fields JSON column to persons table in Cloudflare D1
ALTER TABLE persons ADD COLUMN custom_fields TEXT DEFAULT '{}';
