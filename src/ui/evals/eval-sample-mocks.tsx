import { Check, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { ToolOption } from '../../server/protocol'
import {
  isPlainObject,
  sampleFromSchema,
  validateAgainstSchema,
} from '../autoform/json-schema-provider'
import { CodeEditor } from '../code/code-editor'
import { formatJson, parseJson } from '../code/json'
import { useWfComponents } from '../context'

// The mock a tool returns for one Sample: a pinned output it yields under
// `simulate`, so a run is deterministic and side-effect free. Owned per tool by
// the tool list in `eval-sample-tools.tsx` — which is why nothing here picks a
// tool or keeps a fixture record. This is one tool's result, nothing else.

// A JSON editor for a tool's mocked output, seeded from the tool's output schema
// so the author starts from its shape (`{ "memories": [{ "id": "<string>", … }] }`)
// rather than a bare `{}`. Syntax-highlighted as it is typed, and validated on
// every keystroke: JSON that doesn't parse (or isn't an object) BLOCKS the save,
// so a malformed fixture can never reach the row — the engine would hand the
// model whatever survived the round trip, and a mock nobody can read is a run
// nobody can explain. A schema *mismatch* only warns: a mock may be deliberately
// off-shape to test the agent's error handling.
//
// Remounted per tool by its `key`, so the seed is computed once from
// `initial`/the schema.
export function MockOutputEditor({
  schema,
  initial,
  onSave,
  onClear,
}: {
  schema: ToolOption['outputSchema']
  initial: Record<string, unknown> | undefined
  onSave: (output: Record<string, unknown>) => void
  /** Unpin — back to the template, and `{}` at run time. Omitted = nothing pinned. */
  onClear?: () => void
}) {
  const { Button, Label } = useWfComponents()
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
    const parsed = parseJson(text)
    if (!parsed.ok) {
      return {
        object: null,
        jsonError: `Invalid JSON — ${parsed.error}`,
        warnings: [],
      }
    }
    if (!isPlainObject(parsed.value)) {
      return {
        object: null,
        jsonError: 'Output must be a JSON object.',
        warnings: [],
      }
    }
    return {
      object: parsed.value,
      jsonError: null,
      warnings: validateAgainstSchema(schema, parsed.value).errors,
    }
  }, [text, schema])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // Guarded twice on purpose: the button is disabled, but Cmd+Enter submits
    // the form directly.
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
        <CodeEditor
          id="mock-output"
          language="json"
          value={text}
          onChange={setText}
          onBlur={() => {
            // Re-indent what parses, once the author stops typing. Pasted output
            // arrives minified more often than not, and reformatting on every
            // keystroke would move the caret out from under them.
            const next = formatJson(text)
            if (next !== null) setText(next)
          }}
          rows={10}
          invalid={jsonError ? 'error' : false}
        />
      </div>
      {jsonError ? (
        <p className="text-xs text-red-600">{jsonError}</p>
      ) : warnings.length > 0 ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs font-medium text-amber-700">
            Doesn&apos;t match the tool&apos;s output schema — you can still
            save it.
          </p>
          <ul className="mt-1 list-disc pl-4 text-[11px] text-amber-600">
            {warnings.slice(0, 6).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={!object}>
          <Check className="size-4" />
          Save mock
        </Button>
        {onClear ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            <Undo2 className="size-4" />
            Unpin
          </Button>
        ) : null}
      </div>
    </form>
  )
}
