-- "Not recorded" was a placeholder 0008 wrote for direct bookings with no recorded visit. A booking whose
-- source was not recorded has none: it is NULL, not listed as a source and not counted as a website booking.
UPDATE `bookings` SET `website_source` = NULL WHERE `website_source` = 'Not recorded';
