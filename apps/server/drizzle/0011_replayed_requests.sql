CREATE TABLE `replayed_requests` (
	`key` text PRIMARY KEY NOT NULL,
	`status` integer NOT NULL,
	`body` text,
	`replaced` text,
	`moved` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `replayed_requests_at` ON `replayed_requests` (`at`);