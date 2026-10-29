DROP INDEX `member_userId_organizationId_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `member_userId_organizationId_unique` ON `member` (`userId`,`organizationId`);