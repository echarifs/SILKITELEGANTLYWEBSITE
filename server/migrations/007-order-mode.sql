-- 007-order-mode: allow live YouCan Pay payments alongside sandbox.
-- Applied automatically by migrateOrderMode (server/payments.js), which is
-- wired into server/migrate.js. Existing databases get guarded DROP/ADD of the
-- check constraint; fresh installs already have the relaxed constraint in the
-- store_orders CREATE TABLE.

ALTER TABLE store_orders DROP CHECK store_orders_sandbox_chk;

ALTER TABLE store_orders
  ADD CONSTRAINT store_orders_mode_chk CHECK (provider_mode IN ('sandbox', 'live'));

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('007-order-mode', UTC_TIMESTAMP(3));
