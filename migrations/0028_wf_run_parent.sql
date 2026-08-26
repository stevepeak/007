ALTER TABLE `wf_run` ADD `parent_run_id` text;--> statement-breakpoint
ALTER TABLE `wf_run` ADD `parent_node_id` text;--> statement-breakpoint
ALTER TABLE `wf_run` ADD `item_index` integer DEFAULT -1 NOT NULL;--> statement-breakpoint
CREATE INDEX `wf_run_parent_idx` ON `wf_run` (`parent_run_id`,`item_index`);