CREATE TABLE `server_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `family_settings` ADD `quiet_from` text DEFAULT '20:00';--> statement-breakpoint
ALTER TABLE `family_settings` ADD `quiet_until` text DEFAULT '07:00';--> statement-breakpoint
ALTER TABLE `pairing_codes` ADD `replaces_device` integer REFERENCES devices(id);