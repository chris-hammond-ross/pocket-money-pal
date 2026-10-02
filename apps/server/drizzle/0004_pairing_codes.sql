CREATE TABLE `pairing_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code_hash` text NOT NULL,
	`created_by_device` integer,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`created_by_device`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_codes_code_hash_unique` ON `pairing_codes` (`code_hash`);