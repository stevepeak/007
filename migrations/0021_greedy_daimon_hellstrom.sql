ALTER TABLE `wf_agent` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `wf_agent_slug_idx` ON `wf_agent` (`slug`);--> statement-breakpoint
ALTER TABLE `wf_workflow` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `wf_workflow_slug_idx` ON `wf_workflow` (`slug`);