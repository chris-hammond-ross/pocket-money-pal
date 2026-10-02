ALTER TABLE `chore_instances` ADD `sent_back_by` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `family_settings` ADD `volume` integer DEFAULT 80 NOT NULL;