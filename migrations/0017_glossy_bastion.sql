DROP INDEX `wf_run_step_run_node_idx`;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `parent_node_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `item_index` integer DEFAULT -1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `wf_run_step_run_node_idx` ON `wf_run_step` (`run_id`,`node_id`,`item_index`);