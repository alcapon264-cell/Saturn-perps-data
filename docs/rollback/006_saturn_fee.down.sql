-- ROLLBACK for migrations/006_saturn_fee.sql. Run by hand ONLY if R131 is being removed. Deletes approveBuilderFee audit rows (the check cannot exclude them otherwise).
BEGIN;
DELETE FROM perps_hl_requests WHERE action_type = 'approveBuilderFee';
ALTER TABLE perps_hl_requests DROP COLUMN IF EXISTS saturn_fee_tenths_bp;
ALTER TABLE perps_hl_requests DROP CONSTRAINT IF EXISTS perps_hl_requests_action_type_check;
ALTER TABLE perps_hl_requests ADD CONSTRAINT perps_hl_requests_action_type_check CHECK (action_type IN ('approveAgent','order','cancel','cancelByCloid','updateLeverage','sendAsset','withdraw3'));
DELETE FROM perps_migrations WHERE name = '006_saturn_fee.sql';
COMMIT;
