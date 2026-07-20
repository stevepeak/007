ALTER TABLE `wf_model` ADD `supports_tools` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `wf_model` ADD `supports_reasoning` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `wf_model` ADD `supports_structured_output` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `wf_model` ADD `supports_vision` integer DEFAULT false NOT NULL;