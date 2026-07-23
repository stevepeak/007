CREATE TABLE `wf_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`correlation_id` text,
	`run_id` text,
	`rating` text NOT NULL,
	`note` text,
	`body` text,
	`subject_title` text,
	`subject_url` text,
	`rater_user_id` text,
	`rater_label` text,
	`correlation_label` text,
	`ack_at` integer,
	`ack_by_user_id` text,
	`ack_by_label` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wf_feedback_subject_id_unique` ON `wf_feedback` (`subject_id`);--> statement-breakpoint
CREATE INDEX `wf_feedback_rating_created_idx` ON `wf_feedback` (`rating`,`created_at`);--> statement-breakpoint
CREATE INDEX `wf_feedback_correlation_idx` ON `wf_feedback` (`correlation_id`);