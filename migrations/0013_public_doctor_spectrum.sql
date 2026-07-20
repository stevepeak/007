CREATE TABLE `wf_model` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`label` text NOT NULL,
	`vendor` text,
	`enabled` integer DEFAULT false NOT NULL,
	`cost_per_m_tok` real,
	`prompt_price_per_m_tok` real,
	`completion_price_per_m_tok` real,
	`context_length` integer,
	`tokens_per_sec` real,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_model_provider_idx` ON `wf_model` (`provider_id`);--> statement-breakpoint
CREATE INDEX `wf_model_enabled_idx` ON `wf_model` (`enabled`);--> statement-breakpoint
CREATE TABLE `wf_model_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`note` text,
	`last_refreshed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
