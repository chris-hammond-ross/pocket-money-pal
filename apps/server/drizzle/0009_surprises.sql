CREATE TABLE `surprise_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer,
	`title` text NOT NULL,
	`icon` text NOT NULL,
	`reward_points` integer NOT NULL,
	`time_frame_min` integer NOT NULL,
	`child_id` integer,
	`status` text NOT NULL,
	`date` text NOT NULL,
	`appear_at` integer,
	`sent_at` integer NOT NULL,
	`shown_at` integer,
	`expires_at` integer,
	`grabbed_at` integer,
	`team` integer DEFAULT false NOT NULL,
	`ended_at` integer,
	`source` text DEFAULT 'phone' NOT NULL,
	`sent_by` integer,
	`cancelled_by` integer,
	`chore_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `surprise_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sent_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chore_id`) REFERENCES `chores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `surprise_runs_status` ON `surprise_runs` (`status`);--> statement-breakpoint
CREATE INDEX `surprise_runs_date` ON `surprise_runs` (`date`);--> statement-breakpoint
CREATE TABLE `surprise_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`icon` text NOT NULL,
	`reward_points` integer NOT NULL,
	`time_frame_min` integer NOT NULL,
	`child_id` integer,
	`deleted_at` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`child_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `chores` ADD `surprise_run_id` integer REFERENCES surprise_runs(id);