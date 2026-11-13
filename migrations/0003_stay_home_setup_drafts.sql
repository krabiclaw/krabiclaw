CREATE TABLE `stay_home_setup_drafts` (
	`organization_id` text NOT NULL,
	`member_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`revision` text NOT NULL,
	PRIMARY KEY(`organization_id`, `member_id`),
	FOREIGN KEY (`member_id`,`organization_id`) REFERENCES `member`(`id`,`organizationId`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "stay_home_setup_drafts_payload_check" CHECK(json_valid(payload_json) AND json_type(payload_json) IS 'object')
);
