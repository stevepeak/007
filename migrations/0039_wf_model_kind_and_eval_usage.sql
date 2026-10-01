ALTER TABLE `wf_eval_result` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `wf_eval_result` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `wf_model` ADD `kind` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
CREATE INDEX `wf_model_kind_enabled_idx` ON `wf_model` (`kind`,`enabled`);