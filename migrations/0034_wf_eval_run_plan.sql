ALTER TABLE `wf_eval_run` ADD `plan` text;--> statement-breakpoint
ALTER TABLE `wf_eval_run` ADD `drive_state` text;--> statement-breakpoint
ALTER TABLE `wf_eval_run` ADD `heartbeat_at` integer;--> statement-breakpoint
CREATE INDEX `wf_eval_run_heartbeat_idx` ON `wf_eval_run` (`status`,`heartbeat_at`);