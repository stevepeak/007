CREATE TABLE `wf_change` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_kind` text NOT NULL,
	`entity_id` text NOT NULL,
	`parent_id` text,
	`action` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`before` text,
	`after` text,
	`truncated` integer DEFAULT false NOT NULL,
	`actor_id` text,
	`source` text DEFAULT 'ui' NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wf_change_entity_idx` ON `wf_change` (`entity_kind`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wf_change_parent_idx` ON `wf_change` (`parent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wf_change_actor_idx` ON `wf_change` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wf_change_created_idx` ON `wf_change` (`created_at`);