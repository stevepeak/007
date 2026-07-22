import type {
  ButtonHTMLAttributes,
  FC,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

import { cn } from './cn'

// UI primitives are INJECTED. The SDK's components render these from context, so
// a host (1121law) passes its own shadcn/design-system components via
// `WfSdkProvider components={{...}}` and everything themes consistently. A
// neutral Tailwind default set ships for standalone use. New primitives are
// added here as components need them (additive).

export type WfButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive'
  size?: 'sm' | 'md'
}
export type WfBadgeProps = { children: ReactNode; className?: string }
export type WfInputProps = InputHTMLAttributes<HTMLInputElement>
export type WfLabelProps = LabelHTMLAttributes<HTMLLabelElement>
export type WfTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>
export type WfSelectProps = SelectHTMLAttributes<HTMLSelectElement>
export type WfCheckboxProps = InputHTMLAttributes<HTMLInputElement>

export type WfComponents = {
  Button: FC<WfButtonProps>
  Badge: FC<WfBadgeProps>
  Input: FC<WfInputProps>
  Label: FC<WfLabelProps>
  Textarea: FC<WfTextareaProps>
  Select: FC<WfSelectProps>
  Checkbox: FC<WfCheckboxProps>
}

const buttonVariants: Record<NonNullable<WfButtonProps['variant']>, string> = {
  default: 'bg-neutral-900 text-white hover:bg-neutral-800',
  outline: 'border border-neutral-300 bg-transparent hover:bg-neutral-100',
  ghost: 'bg-transparent hover:bg-neutral-100',
  destructive: 'bg-red-600 text-white hover:bg-red-500',
}

const DefaultButton: FC<WfButtonProps> = ({
  variant = 'default',
  size = 'md',
  className,
  ...props
}) => (
  <button
    className={cn(
      'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
      size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3.5 text-sm',
      buttonVariants[variant],
      className,
    )}
    {...props}
  />
)

const DefaultBadge: FC<WfBadgeProps> = ({ children, className }) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700',
      className,
    )}
  >
    {children}
  </span>
)

const DefaultInput: FC<WfInputProps> = ({ className, ...props }) => (
  <input
    className={cn(
      'h-9 w-full rounded-md border border-neutral-300 bg-transparent px-3 text-sm outline-none focus:border-neutral-500',
      className,
    )}
    {...props}
  />
)

const DefaultLabel: FC<WfLabelProps> = ({ className, ...props }) => (
  <label
    className={cn('text-sm font-medium text-neutral-700', className)}
    {...props}
  />
)

const DefaultTextarea: FC<WfTextareaProps> = ({ className, ...props }) => (
  <textarea
    className={cn(
      'w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-neutral-500',
      className,
    )}
    {...props}
  />
)

const DefaultSelect: FC<WfSelectProps> = ({ className, ...props }) => (
  <select
    className={cn(
      'h-9 w-full rounded-md border border-neutral-300 bg-transparent px-2 text-sm outline-none focus:border-neutral-500',
      className,
    )}
    {...props}
  />
)

const DefaultCheckbox: FC<WfCheckboxProps> = ({ className, ...props }) => (
  <input
    type="checkbox"
    className={cn('size-4 rounded border-neutral-300', className)}
    {...props}
  />
)

export const defaultComponents: WfComponents = {
  Button: DefaultButton,
  Badge: DefaultBadge,
  Input: DefaultInput,
  Label: DefaultLabel,
  Textarea: DefaultTextarea,
  Select: DefaultSelect,
  Checkbox: DefaultCheckbox,
}
