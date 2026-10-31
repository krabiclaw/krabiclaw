-- Member message alerts use the same receipt purpose as every other member alert.
UPDATE guest_thread_deliveries SET purpose = 'owner_alert' WHERE purpose = 'team_message';
