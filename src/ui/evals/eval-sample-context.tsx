import { useMemo } from 'react'

import type {
  AgentConfig,
  EvalTools,
  ToolContextField,
  ToolOption,
  WfEvalTargetKind,
} from '../../server/protocol'
import { toolSetting } from '../../server/protocol'
import { useWfComponents } from '../context'
import { useAgent, useToolContextFields, useTools } from '../hooks'
import { useCommittedField } from '../use-committed-field'

// A Sample's tool CONTEXT — the ambient scope (which client, firm, chat thread)
// its live tools read from their run deps rather than from arguments. The same
// bag the agent playground collects, asked for by the same rule: only tools that
// actually EXECUTE in this sample count. A mocked read and a neutralized write
// touch nothing, so their scope would be a question with no answer.

/**
 * Whether a tool executes for real in an eval of this sample. Writes are always
 * neutralized; reads run only when set to Live; an unclassified tool is never
 * intercepted, so it always runs.
 */
function executes(args: { tool: ToolOption; tools: EvalTools }): boolean {
  const { tool, tools } = args
  if (tool.sideEffect === 'write') return false
  if (tool.sideEffect === 'read') {
    return toolSetting(tools, tool.id).mode === 'live'
  }
  return true
}

/**
 * The host context fields this sample has to fill: the union of what its
 * executing tools declare via `requiresContext`. A workflow target's tools are
 * spread across nodes we don't resolve here, so it is offered every field.
 */
function useNeededContext(args: {
  targetId: string
  targetKind: WfEvalTargetKind
  tools: EvalTools
}): { fields: ToolContextField[]; required: Set<string> } {
  const { targetId, targetKind, tools } = args
  const fieldsQuery = useToolContextFields()
  const toolsQuery = useTools()
  const detail = useAgent(targetId)

  return useMemo(() => {
    const all = fieldsQuery.data ?? []
    if (targetKind !== 'agent') return { fields: all, required: new Set() }
    const config =
      detail.data?.agent.kind === 'generation'
        ? ((detail.data.currentVersion?.config ??
            detail.data.draft?.config) as AgentConfig | undefined)
        : undefined
    const byId = new Map((toolsQuery.data ?? []).map((t) => [t.id, t]))
    const required = new Set<string>()
    for (const id of config?.toolIds ?? []) {
      const tool = byId.get(id)
      if (!tool || !executes({ tool, tools })) continue
      for (const key of tool.requiresContext ?? []) required.add(key)
    }
    return { fields: all.filter((f) => required.has(f.key)), required }
  }, [fieldsQuery.data, toolsQuery.data, detail.data, targetKind, tools])
}

export function SampleContextEditor({
  targetId,
  targetKind,
  tools,
  value,
  onChange,
}: {
  targetId: string
  targetKind: WfEvalTargetKind
  tools: EvalTools
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  const { Input } = useWfComponents()
  const allFields = useToolContextFields().data
  const needed = useNeededContext({ targetId, targetKind, tools })
  const field = useCommittedField(value, onChange, JSON.stringify)

  // A value the sample already holds stays visible even once no live tool
  // needs it — it is still sent with the run, so it must not be invisible.
  const fields = useMemo(() => {
    const out = [...needed.fields]
    for (const f of allFields ?? []) {
      if (!out.includes(f) && (value[f.key] ?? '') !== '') out.push(f)
    }
    return out
  }, [needed.fields, allFields, value])

  if (fields.length === 0) return null

  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-neutral-400">
        Context — the scope live tools run in. Not seen by the agent.
      </p>
      {fields.map((f) => {
        const required = needed.required.has(f.key)
        const missing = required && (field.value[f.key] ?? '').trim() === ''
        return (
          <div key={f.key} className="flex items-center gap-2">
            <span
              title={f.description}
              className="w-40 shrink-0 truncate rounded bg-neutral-100 px-2 py-1.5 text-xs text-neutral-600"
            >
              {f.label}
              {required ? <span className="ml-0.5 text-red-500">*</span> : null}
            </span>
            <Input
              value={field.value[f.key] ?? ''}
              placeholder={missing ? 'required by a live tool' : f.placeholder}
              onChange={(e) => {
                const next = { ...field.value, [f.key]: e.target.value }
                if (!e.target.value) delete next[f.key]
                return field.onChange(next)
              }}
              onBlur={field.onBlur}
              className="h-8 flex-1 font-mono text-xs"
            />
          </div>
        )
      })}
    </div>
  )
}
