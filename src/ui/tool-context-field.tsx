import type { ToolContextField } from '../server/protocol'

import { useWfComponents } from './context'

// One host-declared context input — the ambient run scope a tool is given rather
// than something the agent decides (which client, which chat thread). Shared by
// the tool playground (which collects every declared field) and the agent
// playground (which collects only what its live tools declare they need), so the
// two read identically.

export function ContextField({
  field,
  value,
  disabled,
  required,
  onChange,
}: {
  field: ToolContextField
  value: string
  disabled?: boolean
  /**
   * Marks the field as required beyond the host's own `field.required` — the
   * agent playground derives this per run from the live tools' `requiresContext`.
   */
  required?: boolean
  onChange: (value: string) => void
}) {
  const { Input, Label } = useWfComponents()
  const id = `tool-ctx-${field.key}`
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {required || field.required ? (
          <span className="ml-0.5 text-red-500">*</span>
        ) : null}
      </Label>
      {field.description ? (
        <p className="text-xs text-neutral-500">{field.description}</p>
      ) : null}
      <Input
        id={id}
        value={value}
        disabled={disabled}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm"
      />
    </div>
  )
}
