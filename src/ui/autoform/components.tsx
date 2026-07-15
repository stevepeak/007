import type {
  ArrayElementWrapperProps,
  ArrayWrapperProps,
  AutoFormFieldComponents,
  AutoFormFieldProps,
  AutoFormUIComponents,
  FieldWrapperProps,
  ObjectWrapperProps,
} from '@autoform/react'
import { Plus, X } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { useController } from 'react-hook-form'

import { cn } from '../cn'
import { useWfComponents } from '../context'

// AutoForm is headless: it walks the parsed schema and defers every piece of
// rendering to the components handed in here. We map that contract onto the
// SDK's INJECTED primitives (`useWfComponents()`), so a host that themes the
// SDK with its shadcn set gets a themed AutoForm for free — no shadcn import in
// the SDK. Field components read/write react-hook-form via `useController`.
//
// Controls store RAW values (a number as a string, an object as JSON text);
// `coerceValues` turns them into typed args at submit time. That keeps
// intermediate keystrokes (a lone "-", a half-typed JSON object) from throwing.

function RequiredMark({ required }: { required?: boolean }) {
  return required ? <span className="ml-0.5 text-red-500">*</span> : null
}

function TypeHint({ type }: { type: string }) {
  if (type !== 'json' && type !== 'number') return null
  return (
    <span className="ml-1.5 font-mono text-[11px] font-normal text-neutral-400">
      {type}
    </span>
  )
}

// --- Field components (keyed by ParsedField.type in wfFormComponents) ---------

function StringField({ id, inputProps }: AutoFormFieldProps) {
  const { Input } = useWfComponents()
  const { field } = useController({ name: id })
  const { ref: _ref, ...bind } = field
  return <Input id={id} {...inputProps} {...bind} value={bind.value ?? ''} />
}

function TextareaField({ id, inputProps }: AutoFormFieldProps) {
  const { Textarea } = useWfComponents()
  const { field } = useController({ name: id })
  const { ref: _ref, ...bind } = field
  return (
    <Textarea id={id} rows={4} {...inputProps} {...bind} value={bind.value ?? ''} />
  )
}

function NumberField({ id, inputProps }: AutoFormFieldProps) {
  const { Input } = useWfComponents()
  const { field } = useController({ name: id })
  const { ref: _ref, ...bind } = field
  return (
    <Input
      id={id}
      type="number"
      {...inputProps}
      {...bind}
      value={bind.value ?? ''}
      // Store the raw string; `coerceValues` converts to a number on submit.
      onChange={(e) => bind.onChange(e.target.value)}
    />
  )
}

function BooleanField({ id, inputProps }: AutoFormFieldProps) {
  const { field } = useController({ name: id })
  return (
    <input
      id={id}
      type="checkbox"
      className="size-4 rounded border-neutral-300"
      {...inputProps}
      name={field.name}
      checked={!!field.value}
      onBlur={field.onBlur}
      onChange={(e) => field.onChange(e.target.checked)}
    />
  )
}

function SelectField({ id, inputProps, parsedField }: AutoFormFieldProps) {
  const { field } = useController({ name: id })
  const { ref: _ref, ...bind } = field
  const options = parsedField.options ?? []
  return (
    <select
      id={id}
      className="w-full rounded-md border border-neutral-300 bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-neutral-500"
      {...inputProps}
      {...bind}
      value={bind.value ?? ''}
    >
      <option value="">{parsedField.required ? 'Select…' : '(use default)'}</option>
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  )
}

function JsonField({ id, inputProps }: AutoFormFieldProps) {
  const { Textarea } = useWfComponents()
  const { field } = useController({ name: id })
  const { ref: _ref, ...bind } = field
  return (
    <Textarea
      id={id}
      rows={4}
      spellCheck={false}
      placeholder="JSON"
      className="font-mono text-xs"
      {...inputProps}
      {...bind}
      value={bind.value ?? ''}
    />
  )
}

// --- Layout / wrapper components ---------------------------------------------

function Form({ className, children, ...props }: ComponentProps<'form'>) {
  return (
    <form className={cn('space-y-4', className)} {...props}>
      {children}
    </form>
  )
}

function FieldWrapper({
  label,
  error,
  children,
  id,
  parsedField,
}: FieldWrapperProps) {
  const { Label } = useWfComponents()
  const description = parsedField.fieldConfig?.description
  const hasLabel = label !== '' && label != null
  return (
    <div className="space-y-1.5">
      {hasLabel ? (
        <Label htmlFor={id}>
          {label}
          <RequiredMark required={parsedField.required} />
          <TypeHint type={parsedField.type} />
        </Label>
      ) : null}
      {description ? (
        <p className="text-xs text-neutral-500">
          {description as ReactNode}
        </p>
      ) : null}
      {children}
      {error ? <ErrorMessage error={String(error)} /> : null}
    </div>
  )
}

function ErrorMessage({ error }: { error: string }) {
  return <p className="text-xs text-red-600">{error}</p>
}

function SubmitButton({ children }: { children: ReactNode }) {
  const { Button } = useWfComponents()
  return <Button type="submit">{children}</Button>
}

function ObjectWrapper({ label, children, parsedField }: ObjectWrapperProps) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-neutral-200 p-3">
      <legend className="px-1 text-xs font-medium text-neutral-500">
        {label}
        <RequiredMark required={parsedField.required} />
      </legend>
      {children}
    </fieldset>
  )
}

function ArrayWrapper({
  label,
  error,
  children,
  inputProps,
  onAddItem,
  parsedField,
}: ArrayWrapperProps) {
  const { Button } = useWfComponents()
  // AutoForm slips a `key` into inputProps for the legend ref target — strip it
  // so React doesn't warn about spreading `key`.
  const { key: _key, ...legendProps } = inputProps ?? {}
  return (
    <fieldset className="space-y-2 rounded-lg border border-neutral-200 p-3">
      <legend
        className="px-1 text-xs font-medium text-neutral-500"
        {...legendProps}
      >
        {label}
        <RequiredMark required={parsedField.required} />
      </legend>
      {error ? <ErrorMessage error={String(error)} /> : null}
      <div className="space-y-2">{children}</div>
      <Button type="button" variant="outline" size="sm" onClick={onAddItem}>
        <Plus className="size-3.5" />
        Add item
      </Button>
    </fieldset>
  )
}

function ArrayElementWrapper({
  children,
  onRemove,
  index,
}: ArrayElementWrapperProps) {
  const { Button } = useWfComponents()
  return (
    <div className="flex items-start gap-2 rounded-md border border-neutral-100 bg-neutral-50/50 p-2">
      <div className="min-w-0 flex-1">{children}</div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onRemove}
        title={`Remove item ${index + 1}`}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  )
}

export const wfUiComponents: AutoFormUIComponents = {
  Form,
  FieldWrapper,
  ErrorMessage,
  SubmitButton,
  ObjectWrapper,
  ArrayWrapper,
  ArrayElementWrapper,
}

export const wfFormComponents: AutoFormFieldComponents = {
  string: StringField,
  textarea: TextareaField,
  number: NumberField,
  boolean: BooleanField,
  select: SelectField,
  json: JsonField,
  // Any field type we didn't map (dates, unions, …) degrades to a JSON editor.
  fallback: JsonField,
}
