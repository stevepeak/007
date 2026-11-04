-- The backfill and the DROP INDEX statements are hand-written: drizzle-kit emits
-- neither, and 0036's expression indexes are absent from schema-runs.ts. The
-- backfill must agree with stepColumnsFromMeta (run-step-columns.test.ts enforces
-- it) and is split by rowid because one UPDATE over every row outruns D1's
-- per-statement time limit.
ALTER TABLE `wf_run_step` ADD `agent_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `tool_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `model_id` text;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `wf_run_step` ADD `output_tokens` integer;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 0;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 1;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 2;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 3;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 4;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 5;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 6;--> statement-breakpoint
UPDATE `wf_run_step` SET
  `agent_id` = CASE WHEN json_type(`meta`, '$.agentId') = 'text' THEN json_extract(`meta`, '$.agentId') END,
  `tool_id` = CASE WHEN json_type(`meta`, '$.toolId') = 'text' THEN json_extract(`meta`, '$.toolId') END,
  `model_id` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.model'), '')
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN NULLIF(json_extract(`meta`, '$.modelId'), '')
  END,
  `input_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.inputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.inputTokens'), 0)
  END,
  `output_tokens` = CASE
    WHEN json_type(`meta`, '$.steps') = 'array' AND json_type(`meta`, '$.totalUsage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.totalUsage.outputTokens'), 0)
    WHEN json_type(`meta`, '$.questionIds') = 'array' AND json_type(`meta`, '$.usage') IS NOT NULL
      THEN COALESCE(json_extract(`meta`, '$.usage.outputTokens'), 0)
  END
WHERE `rowid` % 8 = 7;--> statement-breakpoint
DROP INDEX IF EXISTS `wf_run_step_agent_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `wf_run_step_tool_idx`;--> statement-breakpoint
CREATE INDEX `wf_run_step_agent_id_idx` ON `wf_run_step` (`agent_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `wf_run_step_tool_id_idx` ON `wf_run_step` (`tool_id`,`started_at`);
