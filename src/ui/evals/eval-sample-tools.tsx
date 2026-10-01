import { ChevronDown, Radio, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'

import type {
  AgentConfig,
  EvalToolMode,
  EvalToolSetting,
  EvalTools,
  ToolOption,
  WfEvalTargetKind,
} from '../../server/protocol'
import { toolSetting, withToolSetting } from '../../server/protocol'
import { cn } from '../cn'
import { useAgent, useTools } from '../hooks'
import { toolChip } from '../tool-appearance'
import { ToolIcon } from '../tool-icon'
import { Tooltip } from '../tooltip'

import { MockOutputEditor } from './eval-sample-mocks'

// A Sample's TOOLS — one row per tool the target actually has, each settled on
// its own.
//
// It used to be a single tri-state for the whole sample (Mocked / None / Live),
// with a separate "Add mock" flow underneath that asked you to pick a tool from
// a list before you could pin anything. Two problems, both from the same cause:
// the question has a per-tool answer and was being asked once. An agent that
// searches AND reads memory had to answer for both at once — pinning the search
// result meant pinning the memory lookup, and grading against live retrieval
// meant giving up determinism everywhere. And a tool you had not "added" was
// invisible here, so the set of tools that would actually run was something you
// inferred rather than read.
//
// Now every tool is listed, every tool is mocked by default, and its mock starts
// from the tool's own output schema — so there is nothing to add, only something
// to edit.
//
// Write tools are neutralized whatever a row says. An eval never writes.

export function SampleToolsEditor({
  targetId,
  targetKind,
  value,
  onChange,
}: {
  targetId: string
  targetKind: WfEvalTargetKind
  value: EvalTools
  onChange: (next: EvalTools) => void
}) {
  if (targetKind !== 'agent') {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        Node mocks arrive with workflow targets.
      </p>
    )
  }
  return <AgentToolList targetId={targetId} value={value} onChange={onChange} />
}

function AgentToolList({
  targetId,
  value,
  onChange,
}: {
  targetId: string
  value: EvalTools
  onChange: (next: EvalTools) => void
}) {
  const detail = useAgent(targetId)
  const toolsQuery = useTools()
  // Which tool's mock editor is open (a toolId; null = none). One at a time —
  // a column of open JSON editors stops being a list of tools.
  const [editing, setEditing] = useState<string | null>(null)

  const toolIds = useMemo(() => {
    // Generation agents only. A decision agent has no `toolIds` at all, and
    // `useTargetHasTools` already answers `false` for one, so this list is
    // never rendered against it — the guard keeps that true structurally
    // rather than by coincidence of call order.
    if (detail.data?.agent.kind !== 'generation') return []
    const config = (detail.data.currentVersion?.config ??
      detail.data.draft?.config) as AgentConfig | undefined
    return config?.toolIds ?? []
  }, [detail.data])

  const byId = useMemo(
    () => new Map((toolsQuery.data ?? []).map((t) => [t.id, t])),
    [toolsQuery.data],
  )

  // The agent's own tools, plus any tool this sample still has a setting for.
  // A pin left behind by a tool the agent has since dropped is dead weight, and
  // dropping it from the list would be the second time it disappeared quietly.
  const rows = useMemo(() => {
    const ids = [...toolIds]
    for (const id of Object.keys(value.byTool)) {
      if (!ids.includes(id)) ids.push(id)
    }
    return ids.map((id) => ({
      id,
      tool: byId.get(id),
      orphaned: !toolIds.includes(id),
    }))
  }, [toolIds, value.byTool, byId])

  if (!targetId) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        This goal has no target agent yet — set one on the goal to configure its
        tools.
      </p>
    )
  }
  // Not a QueryState ladder: the states here are domain gates (no target set,
  // target has no tools) interleaved with two queries that must BOTH land, and
  // neither query's data is what the body renders.
  if (detail.isLoading || toolsQuery.isLoading) {
    return <p className="px-1 py-1 text-xs text-neutral-400">Loading tools…</p>
  }
  if (rows.length === 0) {
    return (
      <p className="px-1 py-1 text-xs text-neutral-400">
        The target agent has no tools.
      </p>
    )
  }

  const setMode = (toolId: string, mode: EvalToolMode) => {
    // The pinned output rides along through a trip to Live and back: it is the
    // author's work, and switching a toggle to see what happens shouldn't cost
    // it.
    onChange(withToolSetting(value, toolId, { ...toolSetting(value, toolId), mode }))
  }
  const setOutput = (toolId: string, output: unknown) => {
    onChange(
      withToolSetting(value, toolId, { ...toolSetting(value, toolId), output }),
    )
    setEditing(null)
  }
  const clearOutput = (toolId: string) => {
    const { output: _dropped, ...rest } = toolSetting(value, toolId)
    onChange(withToolSetting(value, toolId, rest))
  }

  return (
    <div className="space-y-3">
      <p className="px-1 text-xs text-neutral-400">
        Every tool is mocked by default, starting from its own output schema —
        edit one to pin the result this sample replays, or switch it to Live to
        let it hit real data.
      </p>

      <div className="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-200">
        {rows.map(({ id, tool, orphaned }) => (
          <ToolRow
            key={id}
            toolId={id}
            tool={tool}
            orphaned={orphaned}
            setting={toolSetting(value, id)}
            open={editing === id}
            onOpenChange={(open) => setEditing(open ? id : null)}
            onModeChange={(mode) => setMode(id, mode)}
            onOutputChange={(output) => setOutput(id, output)}
            onClear={() => clearOutput(id)}
          />
        ))}
      </div>
    </div>
  )
}

// One tool's row: what it is, how it behaves, and — expanded — the result it
// returns. The behavior control depends on what the tool DECLARES, because two
// of the three answers aren't the author's to give: a write tool is neutralized
// by `simulate` whatever this says, and a tool that declares no side effect at
// all is never intercepted, so it runs for real in every sample. Showing a
// Mocked/Live toggle on either would be offering a choice that isn't taken.
function ToolRow({
  toolId,
  tool,
  orphaned,
  setting,
  open,
  onOpenChange,
  onModeChange,
  onOutputChange,
  onClear,
}: {
  toolId: string
  tool: ToolOption | undefined
  orphaned: boolean
  setting: EvalToolSetting
  open: boolean
  onOpenChange: (open: boolean) => void
  onModeChange: (mode: EvalToolMode) => void
  onOutputChange: (output: unknown) => void
  onClear: () => void
}) {
  const mockable = tool?.sideEffect === 'read'
  const expandable = mockable && setting.mode === 'mocked'
  return (
    <div className={cn(open && 'bg-neutral-50/60')}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center overflow-hidden rounded',
            toolChip(tool?.color ?? null),
          )}
        >
          <ToolIcon
            icon={tool?.icon}
            iconName={tool?.iconName}
            iconUrl={tool?.iconUrl}
            className="size-3.5"
          />
        </span>
        <button
          type="button"
          disabled={!expandable}
          onClick={() => onOpenChange(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default"
        >
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-sm text-neutral-800">
                {tool?.name ?? toolId}
              </span>
              {orphaned ? (
                <span
                  className="shrink-0 text-xs text-amber-600"
                  title="This sample has a setting for a tool the agent no longer has. It is never read."
                >
                  (not in agent)
                </span>
              ) : null}
            </span>
            <span className="block truncate text-[11px] text-neutral-400">
              <ToolRowHint tool={tool} setting={setting} />
            </span>
          </span>
        </button>

        {mockable ? (
          <ModeToggle value={setting.mode} onChange={onModeChange} />
        ) : tool ? (
          <StaticBehavior write={tool.sideEffect === 'write'} />
        ) : null}

        {expandable ? (
          <button
            type="button"
            aria-label={open ? 'Collapse mock' : 'Edit mock'}
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
            className="shrink-0 text-neutral-300 transition hover:text-neutral-500"
          >
            <ChevronDown
              className={cn('size-4 transition', open && 'rotate-180')}
            />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
      </div>

      {open && expandable ? (
        <div className="border-t border-neutral-100 bg-white px-4 py-4">
          <MockOutputEditor
            key={toolId}
            schema={tool?.outputSchema}
            initial={asRecord(setting.output)}
            onSave={onOutputChange}
            onClear={setting.output === undefined ? undefined : onClear}
          />
        </div>
      ) : null}
    </div>
  )
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** The one line under a tool's name: what it will actually return. */
function ToolRowHint({
  tool,
  setting,
}: {
  tool: ToolOption | undefined
  setting: EvalToolSetting
}) {
  if (!tool) return <>Not in the tool catalog — this setting is never read.</>
  if (tool.sideEffect === 'write') {
    return <>Write tool — neutralized in every sample.</>
  }
  if (!tool.sideEffect) {
    return <>Declares no side effect, so it is never intercepted.</>
  }
  if (setting.mode === 'live') return <>Executes against real data.</>
  if (setting.output === undefined) {
    return <>Nothing pinned yet — returns an empty result.</>
  }
  return <>{previewOutput(setting.output)}</>
}

function previewOutput(v: unknown): string {
  try {
    const s = JSON.stringify(v) ?? ''
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  } catch {
    return String(v)
  }
}

const MODES: { mode: EvalToolMode; label: string; icon: typeof Wrench }[] = [
  { mode: 'mocked', label: 'Mocked', icon: Wrench },
  { mode: 'live', label: 'Live', icon: Radio },
]

function ModeToggle({
  value,
  onChange,
}: {
  value: EvalToolMode
  onChange: (mode: EvalToolMode) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-neutral-200 bg-white p-0.5">
      {MODES.map((m) => {
        const Icon = m.icon
        const on = m.mode === value
        return (
          <button
            key={m.mode}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(m.mode)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition',
              on
                ? m.mode === 'live'
                  ? 'bg-sky-100 text-sky-700'
                  : 'bg-violet-100 text-violet-700'
                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600',
            )}
          >
            <Icon className="size-3" />
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

/** For the tools whose behavior the sample doesn't get to choose. */
function StaticBehavior({ write }: { write: boolean }) {
  return (
    <Tooltip
      side="bottom"
      content={
        write
          ? 'An eval never writes: this tool is neutralized and returns { simulated: true }.'
          : 'Only tools that declare sideEffect: "read" are intercepted. This one executes for real in every sample — classify it in the registry to mock it.'
      }
    >
      <span className="shrink-0 rounded bg-neutral-100 px-2 py-1 text-[11px] font-medium text-neutral-500">
        {write ? 'Never runs' : 'Always runs'}
      </span>
    </Tooltip>
  )
}

/**
 * Whether the Sample's target has any tools for this card to configure.
 *
 * "Tools" is both halves of it: the agent's registry tools AND its delegation
 * targets, whose `spawn_*` / `await_subagents` tools are synthesized at run
 * time. An agent with neither has nothing for this card to list.
 *
 * `null` while the agent is still loading — the caller renders nothing yet
 * rather than flashing a card in and back out.
 */
export function useTargetHasTools(
  targetId: string,
  targetKind: WfEvalTargetKind,
): boolean | null {
  const detail = useAgent(targetId)
  // A workflow target's tools live on its nodes, not on one agent config, so we
  // can't resolve them here. Keep the card: its body explains that workflow node
  // mocks aren't built yet.
  if (targetKind !== 'agent') return true
  if (!targetId) return false
  // A hook returning a tri-state answer (yes / no / still resolving), not a
  // rendered ladder — `null` here means "don't decide yet", which is why the
  // caller can't use QueryState either.
  if (detail.isLoading) return null
  // A decision agent calls nothing — the Tools card would be a question with
  // no answer, exactly as it is for a generation agent with an empty tool list.
  if (detail.data?.agent.kind !== 'generation') return false
  const config = (detail.data.currentVersion?.config ??
    detail.data.draft?.config) as AgentConfig | undefined
  if (!config) return false
  return (
    config.toolIds.length > 0 || (config.subAgents?.targets.length ?? 0) > 0
  )
}
