CREATE TABLE `envelopes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`child_id` integer NOT NULL,
	`cents` integer NOT NULL,
	`note` text NOT NULL,
	`from_name` text NOT NULL,
	`created_by` integer,
	`sent_at` integer NOT NULL,
	`opened_at` integer,
	`ledger_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ledger_id`) REFERENCES `ledger`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `envelopes_child` ON `envelopes` (`child_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`child_id` integer NOT NULL,
	`name` text NOT NULL,
	`emoji` text NOT NULL,
	`target_cents` integer NOT NULL,
	`shop_url` text,
	`image_path` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_by` integer,
	`price_checked_at` integer,
	`smashed_at` integer,
	`bought_at` integer,
	`deleted_at` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goals_child` ON `goals` (`child_id`);--> statement-breakpoint
CREATE TABLE `paydays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`ran_at` integer NOT NULL,
	`started_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paydays_at_unique` ON `paydays` (`at`);--> statement-breakpoint
ALTER TABLE `family_settings` ADD `payday_day` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `family_settings` ADD `payday_time` text DEFAULT '18:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `family_settings` ADD `payday_auto` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `family_settings` ADD `payday_changed_at` integer;--> statement-breakpoint
ALTER TABLE `ledger` ADD `goal_id` integer REFERENCES goals(id);--> statement-breakpoint
ALTER TABLE `ledger` ADD `payday_id` integer REFERENCES paydays(id);--> statement-breakpoint
CREATE INDEX `ledger_goal` ON `ledger` (`goal_id`);--> statement-breakpoint
-- Existing families: paydays start from the first slot after this migration (ADR 0010).
UPDATE `family_settings` SET `payday_changed_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER);
