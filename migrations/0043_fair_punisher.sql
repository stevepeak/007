-- The DROP INDEX statements are hand-written: 0036's expression indexes are absent
-- from schema-runs.ts. Existing rows are filled by src/storage/backfill-run-step-columns.sql,
-- run by hand, because D1 rejected backfilling them in this migration's single request.
ALTER TABLE `wf_run_step` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `tool_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `output_tokens` integer;--> statement-breakpoint
DROP INDEX IF EXISTS `wf_run_step_agent_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `wf_run_step_tool_idx`;--> statement-breakpoint
CREATE INDEX `wf_run_step_agent_id_idx` ON `wf_run_step` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `wf_run_step_tool_id_idx` ON `wf_run_step` (`tool_id`,`started_at`);
