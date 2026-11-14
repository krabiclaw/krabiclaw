DROP INDEX `messages_conversation_event_idx`;--> statement-breakpoint
CREATE INDEX `messages_conversation_author_idx` ON `messages` (`conversation_id`,`author_kind`);--> statement-breakpoint
CREATE INDEX `messages_conversation_event_idx` ON `messages` (`conversation_id`,`event_name`,`author_kind`);