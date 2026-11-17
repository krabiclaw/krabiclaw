CREATE TABLE `__new_listing_message_members` (
	`organization_id` text NOT NULL,
	`listing_id` text NOT NULL,
	`member_id` text NOT NULL,
	`access` text DEFAULT 'messaging' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`organization_id`, `listing_id`, `member_id`),
	FOREIGN KEY (`organization_id`,`listing_id`) REFERENCES `products`(`organization_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_listing_message_members`("organization_id", "listing_id", "member_id", "access", "created_at") SELECT "organization_id", "listing_id", "member_id", 'messaging', "created_at" FROM `listing_message_members`;--> statement-breakpoint
DROP TABLE `listing_message_members`;--> statement-breakpoint
ALTER TABLE `__new_listing_message_members` RENAME TO `listing_message_members`;--> statement-breakpoint
CREATE INDEX `listing_message_members_member_idx` ON `listing_message_members` (`member_id`,`organization_id`);--> statement-breakpoint
ALTER TABLE `invitation` ADD `listing_access` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `claim_role` text;
--> statement-breakpoint
CREATE TRIGGER apply_invited_listing_access
AFTER INSERT ON member
WHEN EXISTS (
  SELECT 1 FROM invitation i JOIN user u ON u.id = NEW.userId
  WHERE i.organizationId = NEW.organizationId AND lower(i.email) = lower(u.email)
    AND i.role = NEW.role AND i.status = 'accepted' AND i.listing_access IS NOT NULL
)
BEGIN
  SELECT CASE WHEN (
    SELECT count(*) FROM invitation i JOIN user u ON u.id = NEW.userId
    WHERE i.organizationId = NEW.organizationId AND lower(i.email) = lower(u.email)
      AND i.role = NEW.role AND i.status = 'accepted' AND i.listing_access IS NOT NULL AND u.emailVerified = 1
  ) <> 1 THEN RAISE(ABORT, 'Invitation listing access has no unique verified recipient') END;
  INSERT INTO listing_message_members (organization_id, listing_id, member_id, access)
    SELECT NEW.organizationId, json_extract(grant.value, '$.listing_id'), NEW.id, json_extract(grant.value, '$.access')
    FROM invitation i JOIN user u ON u.id = NEW.userId, json_each(i.listing_access) grant
    WHERE i.organizationId = NEW.organizationId AND lower(i.email) = lower(u.email)
      AND i.role = NEW.role AND i.status = 'accepted' AND i.listing_access IS NOT NULL;
  UPDATE invitation SET listing_access = NULL
    WHERE organizationId = NEW.organizationId AND lower(email) = (SELECT lower(email) FROM user WHERE id = NEW.userId)
      AND role = NEW.role AND status = 'accepted' AND listing_access IS NOT NULL;
END;
