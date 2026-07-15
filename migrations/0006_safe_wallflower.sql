CREATE TABLE `wf_eval_result` (
	`id` text PRIMARY KEY NOT NULL,
	`eval_run_id` text NOT NULL,
	`row_id` text NOT NULL,
	`wf_run_id` text,
	`status` text NOT NULL,
	`score` real,
	`check_results` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wf_eval_result_run_idx` ON `wf_eval_result` (`eval_run_id`);--> statement-breakpoint
CREATE INDEX `wf_eval_result_row_idx` ON `wf_eval_result` (`row_id`);--> statement-breakpoint
CREATE TABLE `wf_eval_row` (
	`id` text PRIMARY KEY NOT NULL,
	`set_id` text NOT NULL,
	`name` text NOT NULL,
	`initial_condition` text DEFAULT '{}' NOT NULL,
	`fixtures` text DEFAULT '{}' NOT NULL,
	`checks` text DEFAULT '{"op":"and","checks":[]}' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_eval_row_set_order_idx` ON `wf_eval_row` (`set_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `wf_eval_run` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`set_ids` text DEFAULT '[]' NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`score` real,
	`started_at` integer,
	`finished_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wf_eval_run_created_idx` ON `wf_eval_run` (`created_at`);--> statement-breakpoint
CREATE TABLE `wf_eval_set` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_eval_set_created_idx` ON `wf_eval_set` (`created_at`);--> statement-breakpoint
ALTER TABLE `wf_run` ADD `is_eval` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `wf_run_eval_created_idx` ON `wf_run` (`is_eval`,`created_at`);