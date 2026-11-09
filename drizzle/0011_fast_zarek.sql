CREATE TABLE `mail_archive_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`direction` text NOT NULL,
	`source_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`archive_key` text,
	`sha256` text,
	`size_bytes` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `mail_archive_entries_status_idx` ON `mail_archive_entries` (`status`,`updated_at`);