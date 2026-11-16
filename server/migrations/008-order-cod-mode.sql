-- 008-order-cod-mode: allow cash-on-delivery orders (provider_mode 'none'),
-- which carry no YouCan Pay transaction. Applied automatically by
-- migrateOrderCodMode (server/payments.js), wired into server/migrate.js.
-- Fresh installs already have the relaxed constraint in the CREATE TABLE.

ALTER TABLE store_orders DROP CHECK store_orders_mode_chk;

ALTER TABLE store_orders
  ADD CONSTRAINT store_orders_mode_chk CHECK (provider_mode IN ('sandbox', 'live', 'none'));

INSERT IGNORE INTO schema_migrations (id, applied_at) VALUES ('008-order-cod-mode', UTC_TIMESTAMP(3));
