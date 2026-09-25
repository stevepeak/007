-- Attribution lookups on wf_run_step: "which runs used this agent / this tool".
--
-- Both queries (listAgentCalls, listToolInvocations) identify a step by an id
-- that lives inside the untyped `meta` JSON, so before these indexes SQLite had
-- to read every row of the table to evaluate the json_extract: ~44k rows read
-- and 200-950ms per call, on a 43k-row table, to return a page of 20.
--
-- SQLite can index a deterministic EXPRESSION, so no new column or backfill is
-- needed. `started_at` is the second key because both lookups order by it, which
-- lets the index serve the ORDER BY as well as the seek.
--
-- The two json_extract indexes are hand-written: drizzle-kit 0.31 mangles an
-- expression index (it splits on the comma inside the call), so they are absent
-- from schema-runs.ts on purpose — see the note there before touching them.
CREATE INDEX `wf_run_step_node_idx` ON `wf_run_step` (`node_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `wf_run_step_agent_idx` ON `wf_run_step` (json_extract("meta", '$.agentId'), `started_at`);--> statement-breakpoint
CREATE INDEX `wf_run_step_tool_idx` ON `wf_run_step` (json_extract("meta", '$.toolId'), `started_at`);
