-- A payment review now records the tax Stripe Tax calculated for it. A review
-- written before carries no tax, so its buyer reviews the payment again.
UPDATE `payment_attempts` SET `review_json` = NULL WHERE `review_json` IS NOT NULL AND json_type(`review_json`, '$.tax') IS NULL;
