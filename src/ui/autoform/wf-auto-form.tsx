import { AutoForm } from '@autoform/react/react-hook-form'
import type { KeyboardEvent, ReactNode } from 'react'
import { useMemo, useState } from 'react'

import type { JsonSchema } from '../../server/protocol'
import { useWfComponents } from '../context'
import { wfFormComponents, wfUiComponents } from './components'
import {
  coerceValues,
  isPlainObject,
  JsonSchemaProvider,
} from './json-schema-provider'

// The playground form. Give it a JSON Schema and an `onSubmit`; it renders the
// fields with AutoForm (themed via the SDK's injected primitives), coerces the
// raw control values into typed args, and owns the submit button so both the
// tool and agent playgrounds share one styled Run affordance and one place for
// ⌘/Ctrl+Enter. When a schema has no renderable object fields (e.g. a tool that
// declares no input schema), it falls back to a raw-JSON editor.

export type WfAutoFormProps = {
  /** JSON Schema (converted from Zod on the server). Undefined → raw JSON. */
  schema: JsonSchema | undefined
  /** Receives the coerced args once the form validates. */
  onSubmit: (values: Record<string, unknown>) => void
  /** Disable every field + the button (e.g. while a run is in flight). */
  disabled?: boolean
  /** Show the pending label + keep the button pressed-out. */
  pending?: boolean
  submitLabel: string
  pendingLabel?: string
  submitIcon?: ReactNode
  /** External gating (e.g. required context not yet filled). */
  submitDisabled?: boolean
  submitTitle?: string
  /** Label for the raw-JSON fallback editor. */
  emptyLabel?: ReactNode
}

function schemaSignature(schema: JsonSchema | undefined): string {
  try {
    return JSON.stringify(schema ?? null)
  } catch {
    return String(schema)
  }
}

export function WfAutoForm({
  schema,
  onSubmit,
  disabled,
  pending,
  submitLabel,
  pendingLabel = 'Running…',
  submitIcon,
  submitDisabled,
  submitTitle,
  emptyLabel = 'Arguments (JSON)',
}: WfAutoFormProps) {
  const { Button, Label, Textarea } = useWfComponents()
  const signature = schemaSignature(schema)
  // Rebuild (and remount AutoForm) whenever the schema changes so the form
  // resets to the new fields/defaults.
  const provider = useMemo(
    () => new JsonSchemaProvider(schema),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signature],
  )

  const [error, setError] = useState<string | null>(null)
  const [rawJson, setRawJson] = useState('{}')

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.requestSubmit()
    }
  }

  function handleFields(values: Record<string, unknown>) {
    const result = coerceValues(values, provider.getFields())
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    onSubmit(result.data)
  }

  function handleRawJson(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = rawJson.trim()
    if (!trimmed) {
      setError(null)
      onSubmit({})
      return
    }
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (!isPlainObject(parsed)) {
        throw new Error('Arguments must be a JSON object.')
      }
      setError(null)
      onSubmit(parsed)
    } catch (err) {
      setError(
        err instanceof SyntaxError
          ? 'Arguments must be valid JSON.'
          : (err as Error).message,
      )
    }
  }

  const submit = (
    <div className="space-y-2">
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      <Button
        type="submit"
        disabled={disabled || pending || submitDisabled}
        title={submitTitle}
      >
        {submitIcon}
        {pending ? pendingLabel : submitLabel}
      </Button>
    </div>
  )

  // A disabled <fieldset> is the simplest way to disable every generated
  // control at once (AutoForm has no form-level `disabled`).
  return (
    <fieldset disabled={disabled} className="m-0 min-w-0 space-y-4 border-0 p-0">
      {provider.hasFields ? (
        <AutoForm
          key={signature}
          schema={provider}
          uiComponents={wfUiComponents}
          formComponents={wfFormComponents}
          formProps={{ onKeyDown }}
          onSubmit={(values) => handleFields(values)}
        >
          {submit}
        </AutoForm>
      ) : (
        <form onSubmit={handleRawJson} onKeyDown={onKeyDown} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wf-raw-args">{emptyLabel}</Label>
            <Textarea
              id="wf-raw-args"
              value={rawJson}
              onChange={(e) => setRawJson(e.target.value)}
              rows={6}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>
          {submit}
        </form>
      )}
    </fieldset>
  )
}
