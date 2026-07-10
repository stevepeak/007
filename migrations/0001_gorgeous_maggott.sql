CREATE TABLE `wf_prompt` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_prompt_tenant_idx` ON `wf_prompt` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `wf_prompt_draft` (
	`prompt_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`base_version_id` text,
	`last_edited_by` text,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `wf_prompt_version` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`body` text NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`change_note` text,
	`created_by` text,
	`published_by` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wf_prompt_version_prompt_number_idx` ON `wf_prompt_version` (`prompt_id`,`version_number`);--> statement-breakpoint
ALTER TABLE `wf_run` ADD `manifest` text DEFAULT '[]' NOT NULL;