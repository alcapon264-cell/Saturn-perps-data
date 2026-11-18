-- ROLLBACK for migrations/005_hl_funding.sql. Run by hand ONLY if R129 is being removed (it deletes the funding history).
BEGIN;
DROP TABLE IF EXISTS perps_hl_funding;
DELETE FROM perps_migrations WHERE name = '005_hl_funding.sql';
COMMIT;
