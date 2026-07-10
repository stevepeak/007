CREATE TABLE `wf_run` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_version_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_id` text,
	`correlation_id` text,
	`trigger_kind` text NOT NULL,
	`cloudflare_run_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text,
	`output` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wf_run_tenant_created_idx` ON `wf_run` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wf_run_version_created_idx` ON `wf_run` (`workflow_version_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wf_run_subject_idx` ON `wf_run` (`subject_id`);--> statement-breakpoint
CREATE TABLE `wf_run_step` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`node_kind` text NOT NULL,
	`sequence` integer NOT NULL,
	`status` text NOT NULL,
	`input` text DEFAULT '{}' NOT NULL,
	`output` text DEFAULT '{}' NOT NULL,
	`branch_result` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `wf_run_step_run_sequence_idx` ON `wf_run_step` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `wf_run_step_run_node_idx` ON `wf_run_step` (`run_id`,`node_id`);--> statement-breakpoint
CREATE TABLE `wf_workflow` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_workflow_tenant_idx` ON `wf_workflow` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `wf_workflow_assignment` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`workflow_id` text NOT NULL,
	`assigned_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wf_assignment_tenant_trigger_idx` ON `wf_workflow_assignment` (`tenant_id`,`trigger_kind`);--> statement-breakpoint
CREATE TABLE `wf_workflow_draft` (
	`workflow_id` text PRIMARY KEY NOT NULL,
	`graph` text NOT NULL,
	`base_version_id` text,
	`last_edited_by` text,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `wf_workflow_version` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`graph` text NOT NULL,
	`change_note` text,
	`created_by` text,
	`published_by` text,
	`published_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wf_workflow_version_workflow_number_idx` ON `wf_workflow_version` (`workflow_id`,`version_number`);