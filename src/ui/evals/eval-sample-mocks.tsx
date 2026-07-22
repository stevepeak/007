import { Check, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  EvalFixtures,
  ToolOption,
  WfEvalTargetKind,
} from '../../server/protocol'
import {
  isPlainObject,
  sampleFromSchema,
  validateAgainstSchema,
} from '../autoform/json-schema-provider'
import { useWfComponents } from '../context'
import { useAgent, useTools } from '../hooks'
import { ToolIcon } from '../tool-icon'

// Per-sample tool fixtures: a pinned output a tool returns under `simulate`, so a
// run is deterministic and side-effect-free (e.g. a memory/search tool returns a
// fixed value instead of executing). Stored in row.fixtures keyed by toolId — one
// canned output per tool. The target agent is the goal's; only agent targets
// today, so workflow "Mock Nodes" is a placeholder until workflow targets ship.
export function MockToolsPanel({
  targetId,
  targetKind,
  fixtures,
  addOpen,
  onAddOpenChange,
  onChange,
}: {
  targetId: string
  targetKind: WfEvalTargetKind
  fixtures: EvalFixtures
  /** Whether the add-mock tool picker is open (its trigger is in the header). */
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
  onChange: (next: EvalFixtures) => void
}) {
  if (targetKind !== 'agent') {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        Node mocks arrive with workflow targets.
      </p>
    )
  }
  return (
    <AgentToolMocks
      targetId={targetId}
      fixtures={fixtures}
      addOpen={addOpen}
      onAddOpenChange={onAddOpenChange}
      onChange={onChange}
    />
  )
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function previewOutput(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function AgentToolMocks({
  targetId,
  fixtures,
  addOpen,
  onAddOpenChange,
  onChange,
}: {
  targetId: string
  fixtures: EvalFixtures
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
  onChange: (next: EvalFixtures) => void
}) {
  const detail = useAgent(targetId)
  const toolsQuery = useTools()

  // Which tool's output editor is open (a toolId; null = none).
  const [editing, setEditing] = useState<string | null>(null)

  const toolIds =
    detail.data?.currentVersion?.config.toolIds ??
    detail.data?.draft?.config.toolIds ??
    []
  const byId = useMemo(
    () => new Map((toolsQuery.data ?? []).map((t) => [t.id, t])),
    [toolsQuery.data],
  )
  const agentTools = useMemo(
    () =>
      toolIds
        .map((id) => byId.get(id))
        .filter((t): t is ToolOption => !!t && t.kind === 'ai-tool'),
    [toolIds, byId],
  )

  const mockedIds = Object.keys(fixtures)
  const available = agentTools.filter((t) => !mockedIds.includes(t.id))

  const save = (toolId: string, output: Record<string, unknown>) => {
    onChange({ ...fixtures, [toolId]: output })
    setEditing(null)
  }
  const remove = (toolId: string) => {
    const next = { ...fixtures }
    delete next[toolId]
    onChange(next)
    if (editing === toolId) setEditing(null)
  }

  if (!targetId) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        This goal has no target agent yet — set one on the goal to mock its tools.
      </p>
    )
  }
  if (detail.isLoading || toolsQuery.isLoading) {
    return <p className="px-1 py-1 text-xs text-neutral-400">Loading tools…</p>
  }
  if (agentTools.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        The target agent has no tools to mock.
      </p>
    )
  }

  const editingTool = editing ? byId.get(editing) : undefined

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-neutral-400">
        Pin a tool&apos;s output so this sample runs deterministically — under
        simulate the tool returns your canned value instead of executing.
      </p>

      {mockedIds.length > 0 ? (
        <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
          {mockedIds.map((toolId) => {
            const tool = byId.get(toolId)
            // Warn (but don't block) when a saved mock no longer matches the
            // tool's output schema — mirrors the editor's warn-but-allow check.
            const mismatch =
              tool &&
              !validateAgainstSchema(tool.outputSchema, fixtures[toolId]).ok
            return (
              <div key={toolId} className="flex items-start gap-2 px-4 py-3">
                <ToolIcon icon={tool?.icon} className="mt-0.5 size-5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-neutral-800">
                      {tool?.name ?? toolId}
                    </span>
                    {!tool ? (
                      <span className="shrink-0 text-xs text-amber-600">
                        (not in agent)
                      </span>
                    ) : mismatch ? (
                      <span
                        className="shrink-0 text-xs text-amber-600"
                        title="This mock doesn't match the tool's output schema."
                      >
                        (off-schema)
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-neutral-400">
                    {previewOutput(fixtures[toolId])}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(toolId)}
                  className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
                >
                  Edit
                </button>
                <button
                  type="button"
                  aria-label="Remove mock"
                  onClick={() => remove(toolId)}
                  className="text-neutral-300 transition hover:text-neutral-600"
                >
                  <X className="size-4" />
                </button>
              </div>
            )
          })}
        </div>
      ) : null}

      {editingTool ? (
        <div className="space-y-3 rounded-lg border border-neutral-200 p-4">
          <div className="flex items-center gap-2">
            <ToolIcon icon={editingTool.icon} className="size-5" />
            <span className="text-sm font-medium text-neutral-800">
              {editingTool.name}
            </span>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="ml-auto text-xs font-medium text-neutral-500 hover:text-neutral-800"
            >
              Cancel
            </button>
          </div>
          <MockOutputEditor
            key={editingTool.id}
            schema={editingTool.outputSchema}
            initial={asRecord(fixtures[editingTool.id])}
            onSave={(output) => save(editingTool.id, output)}
          />
        </div>
      ) : (
        <MockToolPicker
          tools={available}
          open={addOpen}
          onPick={(toolId) => {
            setEditing(toolId)
            onAddOpenChange(false)
          }}
          onClose={() => onAddOpenChange(false)}
        />
      )}
    </div>
  )
}

// A raw-JSON editor for a tool's mocked output, seeded from the tool's output
// schema so the author starts from its shape (`{ "memories": [{ "id":
// "<string>", … }] }`) rather than a bare `{}`. It validates live against that
// schema and *warns* on a mismatch but never blocks the save (a mock may be
// deliberately malformed to test error handling) — only unparseable JSON, or a
// non-object, blocks. Remounted per tool by its `key`, so the seed is computed
// once from `initial`/the schema.
function MockOutputEditor({
  schema,
  initial,
  onSave,
}: {
  schema: ToolOption['outputSchema']
  initial: Record<string, unknown> | undefined
  onSave: (output: Record<string, unknown>) => void
}) {
  const { Button, Label, Textarea } = useWfComponents()
  const [text, setText] = useState(() => {
    const seed =
      initial && Object.keys(initial).length > 0
        ? initial
        : (sampleFromSchema(schema) ?? {})
    try {
      return JSON.stringify(seed, null, 2)
    } catch {
      return '{}'
    }
  })

  // Live parse + validate: a JSON/shape error blocks the save; schema mismatches
  // are surfaced as non-blocking warnings.
  const { object, jsonError, warnings } = useMemo(() => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { object: null, jsonError: 'Output must be valid JSON.', warnings: [] }
    }
    if (!isPlainObject(parsed)) {
      return {
        object: null,
        jsonError: 'Output must be a JSON object.',
        warnings: [],
      }
    }
    return {
      object: parsed,
      jsonError: null,
      warnings: validateAgainstSchema(schema, parsed).errors,
    }
  }, [text, schema])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (object) onSave(object)
  }
  function onKeyDown(e: React.KeyboardEvent<HTMLFormElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.requestSubmit()
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={onKeyDown} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="mock-output">Output (JSON)</Label>
        <Textarea
          id="mock-output"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
        />
      </div>
      {jsonError ? (
        <p className="text-xs text-red-600">{jsonError}</p>
      ) : warnings.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-700">
            Doesn&apos;t match the tool&apos;s output schema — you can still save
            it.
          </p>
          <ul className="mt-1 list-disc pl-4 text-[11px] text-amber-600">
            {warnings.slice(0, 6).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button type="submit" disabled={!object}>
        <Check className="size-4" />
        Save mock
      </Button>
    </form>
  )
}

// The agent's tools not yet mocked, shown when the header's "Add mock" trigger
// is toggled on (`open`). Picking one opens its output editor (dedupe by toolId
// enforces one mock per tool). Renders inline (in normal flow) rather than as an
// absolute popover, so it can't be clipped by the StepFlow card's
// `overflow-hidden`.
function MockToolPicker({
  tools,
  open,
  onPick,
  onClose,
}: {
  tools: ToolOption[]
  open: boolean
  onPick: (toolId: string) => void
  onClose: () => void
}) {
  if (!open) return null

  if (tools.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        Every tool the agent uses is already mocked.
      </p>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-neutral-500">
          Pick a tool to mock
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-medium text-neutral-500 hover:text-neutral-800"
        >
          Cancel
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {tools.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-neutral-50"
          >
            <ToolIcon icon={t.icon} className="size-5" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-800">
                {t.name}
              </span>
              {t.description ? (
                <span className="block truncate text-xs text-neutral-400">
                  {t.description}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
