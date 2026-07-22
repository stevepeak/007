import { useQuery } from '@tanstack/react-query'

import { useWfClient } from './context'
import { keys, useWfMutation } from './hooks-shared'

export function useTools() {
  const client = useWfClient()
  return useQuery({ queryKey: keys.tools, queryFn: () => client.listTools() })
}

export function useToolContextFields() {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.toolContextFields,
    queryFn: () => client.listToolContextFields(),
  })
}

export function useToolInvocations(toolId: string, limit?: number) {
  const client = useWfClient()
  return useQuery({
    queryKey: keys.toolInvocations(toolId, limit),
    queryFn: () => client.listToolInvocations({ toolId, limit }),
    enabled: !!toolId,
  })
}

// Playground — run one tool FOR REAL against scratch args. Not cached (each run
// is a one-off, deliberate action); the detail page reads `data`/`isPending`
// straight off the mutation. On success the tool's invocation list is
// invalidated so the fresh call shows up in "recent calls".
export function useRunToolPreview(toolId: string) {
  return useWfMutation(
    (
      client,
      input: {
        toolId: string
        args: Record<string, unknown>
        context?: Record<string, string>
      },
    ) => client.runToolPreview(input),
    () => [keys.toolInvocationsAll(toolId)],
  )
}
