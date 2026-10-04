CREATE TABLE `streak_days` (
	`child_id` integer NOT NULL,
	`date` text NOT NULL,
	`result` text NOT NULL,
	`decided_at` integer NOT NULL,
	PRIMARY KEY(`child_id`, `date`),
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `users` ADD `sick_on` text;