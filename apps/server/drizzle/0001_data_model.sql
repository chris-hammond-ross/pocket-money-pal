CREATE TABLE `chore_assignments` (
	`chore_id` integer NOT NULL,
	`child_id` integer NOT NULL,
	PRIMARY KEY(`chore_id`, `child_id`),
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assignments_child` ON `chore_assignments` (`child_id`);--> statement-breakpoint
CREATE TABLE `chore_instances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chore_id` integer NOT NULL,
	`child_id` integer NOT NULL,
	`date` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`bonus_before` text NOT NULL,
	`due_by` text NOT NULL,
	`late_after` text NOT NULL,
	`base_points` integer NOT NULL,
	`early_bonus` integer NOT NULL,
	`unprompted_bonus` integer NOT NULL,
	`late_penalty` integer NOT NULL,
	`claimed_at` integer,
	`unprompted` integer,
	`send_back_reason` text,
	`approved_at` integer,
	`approved_by` integer,
	`awarded_base` integer,
	`awarded_early` integer,
	`awarded_unprompted` integer,
	`awarded_late` integer,
	`awarded_extra` integer,
	`awarded_total` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instances_chore_child_date` ON `chore_instances` (`chore_id`,`child_id`,`date`);--> statement-breakpoint
CREATE INDEX `instances_date` ON `chore_instances` (`date`);--> statement-breakpoint
CREATE TABLE `chores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`icon` text NOT NULL,
	`library_id` text,
	`together` integer DEFAULT false NOT NULL,
	`bonus_before` text NOT NULL,
	`due_by` text NOT NULL,
	`late_after` text NOT NULL,
	`base_points` integer NOT NULL,
	`early_bonus` integer DEFAULT 0 NOT NULL,
	`unprompted_bonus` integer DEFAULT 0 NOT NULL,
	`late_penalty` integer DEFAULT 0 NOT NULL,
	`days` text DEFAULT '[]' NOT NULL,
	`one_off_date` text,
	`deleted_at` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`push_subscription` text,
	`last_seen_at` integer,
	`revoked_at` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`type` text NOT NULL,
	`actor_id` integer,
	`child_id` integer,
	`chore_id` integer,
	`instance_id` integer,
	`data` text,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_at` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`child_id` integer NOT NULL,
	`kind` text NOT NULL,
	`points` integer DEFAULT 0 NOT NULL,
	`cents` integer DEFAULT 0 NOT NULL,
	`cents_per_point` integer,
	`instance_id` integer,
	`reverses_id` integer,
	`note` text,
	`created_by` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instance_id`) REFERENCES `chore_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reverses_id`) REFERENCES `ledger`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `ledger_child_at` ON `ledger` (`child_id`,`at`);--> statement-breakpoint
CREATE INDEX `ledger_child_kind` ON `ledger` (`child_id`,`kind`);--> statement-breakpoint
CREATE INDEX `ledger_instance` ON `ledger` (`instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_reverses` ON `ledger` (`reverses_id`);--> statement-breakpoint
CREATE TABLE `setup_drafts` (
	`id` integer PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `family_settings` ADD `paused_from` text;--> statement-breakpoint
ALTER TABLE `family_settings` ADD `paused_until` text;--> statement-breakpoint
ALTER TABLE `users` ADD `age` integer;--> statement-breakpoint
-- Hand-written: the ledger is append-only (ADR 0004). Drizzle doesn't model triggers.
CREATE TRIGGER `ledger_no_update` BEFORE UPDATE ON `ledger`
BEGIN
	SELECT RAISE(ABORT, 'ledger is append-only');
END;--> statement-breakpoint
CREATE TRIGGER `ledger_no_delete` BEFORE DELETE ON `ledger`
BEGIN
	SELECT RAISE(ABORT, 'ledger is append-only');
END;
