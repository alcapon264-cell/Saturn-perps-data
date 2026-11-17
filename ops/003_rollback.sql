-- Operator rollback for migration 003 (NOT a migration; run by hand inside one transaction, only if needed).
-- Archives the view-only data first, then removes ONLY the four 003 tables. SOL/ETH/BTC tables are never referenced.
BEGIN;
CREATE TABLE IF NOT EXISTS archive_perps_view_markets      AS SELECT * FROM perps_view_markets;
CREATE TABLE IF NOT EXISTS archive_perps_view_observations AS SELECT * FROM perps_view_observations;
CREATE TABLE IF NOT EXISTS archive_perps_view_candles      AS SELECT * FROM perps_view_candles;
DROP TABLE perps_view_candles;
DROP TABLE perps_view_observations;
DROP TABLE perps_view_rejects;
DROP TABLE perps_view_markets;
DELETE FROM perps_migrations WHERE name = '003_view_only_markets.sql';
COMMIT;
