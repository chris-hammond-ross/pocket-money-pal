ALTER TABLE `family_settings` ADD `piggy_percent` integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `kind` text DEFAULT 'jar' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `goals_one_piggy` ON `goals` (`child_id`) WHERE "goals"."kind" = 'piggy';