CREATE TABLE `wf_connector` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`url` text NOT NULL,
	`transport` text DEFAULT 'http' NOT NULL,
	`auth_kind` text DEFAULT 'oauth2' NOT NULL,
	`scopes` text,
	`enabled` integer DEFAULT true NOT NULL,
	`icon` text,
	`icon_name` text,
	`color` text,
	`note` text,
	`last_refreshed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `wf_connector_client` (
	`connector_id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`redirect_uri` text NOT NULL,
	`issuer` text,
	`raw` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `wf_connector_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`owner_scope` text DEFAULT 'workspace' NOT NULL,
	`owner_id` text DEFAULT '' NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`token_type` text DEFAULT 'Bearer' NOT NULL,
	`expires_at` integer,
	`scopes` text,
	`account_label` text,
	`status` text DEFAULT 'connected' NOT NULL,
	`last_error` text,
	`token_version` integer DEFAULT 0 NOT NULL,
	`connected_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wf_connector_connection_owner_idx` ON `wf_connector_connection` (`connector_id`,`owner_scope`,`owner_id`);--> statement-breakpoint
CREATE TABLE `wf_connector_oauth_state` (
	`state` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`code_verifier` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_to` text,
	`token_endpoint` text NOT NULL,
	`issuer` text,
	`scopes` text,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wf_connector_tool` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`title` text,
	`description` text,
	`input_schema` text,
	`output_schema` text,
	`annotations` text,
	`side_effect` text DEFAULT 'write' NOT NULL,
	`side_effect_overridden` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`schema_hash` text NOT NULL,
	`last_seen_at` integer,
	`missing_since` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `wf_connector_tool_connector_idx` ON `wf_connector_tool` (`connector_id`);--> statement-breakpoint
CREATE INDEX `wf_connector_tool_enabled_idx` ON `wf_connector_tool` (`enabled`);
