-- r131 Saturn Perps: global Saturn platform fee (0.06%). Forward-only, additive; no existing row is changed.
-- 1. the relay may now record approveBuilderFee (a user's one-time approval of Saturn's fee, Saturn's fee wallet only)
-- 2. each order row records the Saturn fee it carried (Hyperliquid builder "f", tenths of a basis point; NULL = no Saturn fee on that order)
ALTER TABLE perps_hl_requests DROP CONSTRAINT IF EXISTS perps_hl_requests_action_type_check;
ALTER TABLE perps_hl_requests ADD CONSTRAINT perps_hl_requests_action_type_check
  CHECK (action_type IN ('approveAgent','order','cancel','cancelByCloid','updateLeverage','sendAsset','withdraw3','approveBuilderFee'));
ALTER TABLE perps_hl_requests ADD COLUMN IF NOT EXISTS saturn_fee_tenths_bp integer NULL CHECK (saturn_fee_tenths_bp IS NULL OR (saturn_fee_tenths_bp >= 0 AND saturn_fee_tenths_bp <= 100));
