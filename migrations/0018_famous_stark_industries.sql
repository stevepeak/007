ALTER TABLE `wf_eval_result` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `wf_eval_result` ADD `prompt_label` text;--> statement-breakpoint
ALTER TABLE `wf_eval_result` ADD `prompt_body` text;--> statement-breakpoint
ALTER TABLE `wf_eval_result` ADD `attempt` integer;--> statement-breakpoint
CREATE INDEX `wf_eval_result_cell_idx` ON `wf_eval_result` (`eval_run_id`,`model_id`,`prompt_label`);