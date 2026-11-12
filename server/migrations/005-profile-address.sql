-- Optional delivery address on the customer profile (saved account address only;
-- not synchronized to the Google Sheet). server/db.js applies the same guarded
-- ALTERs deterministically via migrateProfileAddress().
ALTER TABLE customers ADD COLUMN address_line1 VARCHAR(200) NULL;
ALTER TABLE customers ADD COLUMN address_line2 VARCHAR(200) NULL;
ALTER TABLE customers ADD COLUMN city VARCHAR(120) NULL;
ALTER TABLE customers ADD COLUMN postal_code VARCHAR(20) NULL;
ALTER TABLE customers ADD COLUMN country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL;
INSERT IGNORE INTO schema_migrations (id, applied_at)
VALUES ('005-profile-address', UTC_TIMESTAMP(3));
