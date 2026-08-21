-- Sample authoring split: one INPUT (shaped like the target's own contract) and
-- one TOOLS setting, replacing the overlapping `initial_condition` + `fixtures`
-- pair. A pure rename: the legacy JSON stays in place and is upgraded on read by
-- `parseEvalSampleInput` / `parseEvalTools`, then written back in the new shape
-- on the row's next save. No JSON surgery in SQL, and no table rebuild.
ALTER TABLE `wf_eval_row` RENAME COLUMN `initial_condition` TO `input`;--> statement-breakpoint
ALTER TABLE `wf_eval_row` RENAME COLUMN `fixtures` TO `tools`;
