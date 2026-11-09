CREATE TABLE `mailbox_forward_addresses` (
	`mailbox_id` text PRIMARY KEY NOT NULL,
	`local_part` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_forward_addresses_local_part_idx` ON `mailbox_forward_addresses` (`local_part`);