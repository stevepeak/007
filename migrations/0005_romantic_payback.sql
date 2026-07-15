DROP INDEX `wf_agent_tenant_idx`;--> statement-breakpoint
ALTER TABLE `wf_agent` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `wf_run_tenant_created_idx`;--> statement-breakpoint
CREATE INDEX `wf_run_created_idx` ON `wf_run` (`created_at`);--> statement-breakpoint
ALTER TABLE `wf_run` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `wf_workflow_tenant_idx`;--> statement-breakpoint
ALTER TABLE `wf_workflow` DROP COLUMN `tenant_id`;--> statement-breakpoint
DROP INDEX `wf_assignment_tenant_trigger_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `wf_assignment_trigger_idx` ON `wf_workflow_assignment` (`trigger_kind`);--> statement-breakpoint
ALTER TABLE `wf_workflow_assignment` DROP COLUMN `tenant_id`;