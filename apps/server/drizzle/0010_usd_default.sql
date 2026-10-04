PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_family_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`family_name` text DEFAULT 'Our Family' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`cents_per_point` integer DEFAULT 5 NOT NULL,
	`timezone` text DEFAULT 'Europe/London' NOT NULL,
	`volume` integer DEFAULT 80 NOT NULL,
	`paused_from` text,
	`paused_until` text,
	`quiet_from` text DEFAULT '20:00',
	`quiet_until` text DEFAULT '07:00',
	`payday_day` integer DEFAULT 0 NOT NULL,
	`payday_time` text DEFAULT '18:00' NOT NULL,
	`payday_auto` integer DEFAULT true NOT NULL,
	`payday_changed_at` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_family_settings`("id", "family_name", "currency", "cents_per_point", "timezone", "volume", "paused_from", "paused_until", "quiet_from", "quiet_until", "payday_day", "payday_time", "payday_auto", "payday_changed_at", "created_at", "updated_at") SELECT "id", "family_name", "currency", "cents_per_point", "timezone", "volume", "paused_from", "paused_until", "quiet_from", "quiet_until", "payday_day", "payday_time", "payday_auto", "payday_changed_at", "created_at", "updated_at" FROM `family_settings`;--> statement-breakpoint
DROP TABLE `family_settings`;--> statement-breakpoint
ALTER TABLE `__new_family_settings` RENAME TO `family_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;