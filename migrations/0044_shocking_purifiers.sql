ALTER TABLE `wf_connector_oauth_state` ADD `owner_scope` text DEFAULT 'workspace' NOT NULL;--> statement-breakpoint
ALTER TABLE `wf_connector_oauth_state` ADD `owner_id` text DEFAULT '' NOT NULL;