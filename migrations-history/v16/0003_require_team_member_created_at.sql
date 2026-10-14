PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_teamMember` (
	`id` text PRIMARY KEY NOT NULL,
	`teamId` text NOT NULL,
	`userId` text NOT NULL,
	`membershipKey` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`teamId`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_teamMember`("id", "teamId", "userId", "membershipKey", "createdAt") SELECT "id", "teamId", "userId", "membershipKey", "createdAt" FROM `teamMember`;--> statement-breakpoint
DROP TABLE `teamMember`;--> statement-breakpoint
ALTER TABLE `__new_teamMember` RENAME TO `teamMember`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `teamMember_membershipKey_unique` ON `teamMember` (`membershipKey`);--> statement-breakpoint
CREATE INDEX `teamMember_teamId_idx` ON `teamMember` (`teamId`);--> statement-breakpoint
CREATE INDEX `teamMember_userId_idx` ON `teamMember` (`userId`);