CREATE TABLE `wf_agent` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`icon` text,
	`color` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_agent_tenant_idx` ON `wf_agent` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `wf_agent_draft` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`base_version_id` text,
	`last_edited_by` text,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `wf_agent_version` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`config` text NOT NULL,
	`change_note` text,
	`created_by` text,
	`published_by` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wf_agent_version_agent_number_idx` ON `wf_agent_version` (`agent_id`,`version_number`);