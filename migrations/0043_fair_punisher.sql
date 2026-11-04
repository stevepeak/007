ALTER TABLE `wf_run_step` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `tool_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `output_tokens` integer;--> statement-breakpoint
CREATE INDEX `wf_run_step_agent_id_idx` ON `wf_run_step` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `wf_run_step_tool_id_idx` ON `wf_run_step` (`tool_id`,`started_at`);