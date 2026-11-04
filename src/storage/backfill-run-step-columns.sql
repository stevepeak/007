-- Fills wf_run_step's promoted columns on rows recorded before migration 0043.
-- Run by hand over rowid ranges, replacing :from and :to; D1 cannot rewrite the
-- whole table in one request. Safe to re-run: every value derives from `meta`.
-- Must agree with stepColumnsFromMeta (run-step-columns.test.ts enforces it).
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
WHERE `rowid` BETWEEN :from AND :to;
