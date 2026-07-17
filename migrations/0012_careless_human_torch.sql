CREATE TABLE `wf_run_log` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text,
	`node_kind` text,
	`sequence` integer,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`meta` text,
	`ts` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `wf_run_log_run_ts_idx` ON `wf_run_log` (`run_id`,`ts`);--> statement-breakpoint
CREATE INDEX `wf_run_log_run_node_idx` ON `wf_run_log` (`run_id`,`node_id`);--> statement-breakpoint
ALTER TABLE `wf_run` ADD `sentry_trace_id` text;