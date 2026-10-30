CREATE TABLE `review_category_ratings` (
	`review_id` text NOT NULL,
	`category` text NOT NULL,
	`rating` integer NOT NULL,
	PRIMARY KEY(`review_id`, `category`),
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_category_ratings_rating_check" CHECK(rating BETWEEN 1 AND 5),
	CONSTRAINT "review_category_ratings_category_check" CHECK(category IN ('food', 'service', 'atmosphere', 'expertise', 'organization', 'enjoyment', 'listening', 'explanation', 'next_steps', 'cleanliness', 'accuracy', 'check_in', 'communication'))
);
--> statement-breakpoint
ALTER TABLE `bookings` ADD `no_show_at` text;--> statement-breakpoint
ALTER TABLE `reservations` ADD `no_show_at` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `private_feedback` text;--> statement-breakpoint
ALTER TABLE `stays` ADD `no_show_at` text;