-- 006-order-shipping: delivery address captured for store orders.
-- Applied automatically by migrateOrderShipping (server/payments.js), which is
-- wired into server/migrate.js. Existing databases get guarded ALTERs; fresh
-- installs already have the columns in the store_orders CREATE TABLE.

ALTER TABLE store_orders
  ADD COLUMN shipping_line1 VARCHAR(200) NULL,
  ADD COLUMN shipping_line2 VARCHAR(200) NULL,
  ADD COLUMN shipping_city VARCHAR(120) NULL,
  ADD COLUMN shipping_postal_code VARCHAR(20) NULL,
  ADD COLUMN shipping_country CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN shipping_set_at DATETIME(3) NULL;

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('006-order-shipping', UTC_TIMESTAMP(3));
