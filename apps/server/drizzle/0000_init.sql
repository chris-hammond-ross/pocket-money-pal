CREATE TABLE `family_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`family_name` text DEFAULT 'Our Family' NOT NULL,
	`currency` text DEFAULT 'GBP' NOT NULL,
	`cents_per_point` integer DEFAULT 5 NOT NULL,
	`timezone` text DEFAULT 'Europe/London' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`avatar` text,
	`colour` text,
	`pin_hash` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
