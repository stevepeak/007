import {
  BRANCH_OPERATORS,
  branchOperatorTakesValue,
  type BranchOperator,
} from '../../engine'
import { cn } from '../cn'
import { Popover } from '../popover'

// How each Branch operator reads. The glyph is what the collapsed trigger shows
// — a predicate is read far more often than it is changed, so the field it sits
// in should be the width of a symbol, not of the widest operator name. The name
// still appears beside the glyph in the open list, which is where the author is
// actually choosing.
export const BRANCH_OPERATOR_META: Record<
  BranchOperator,
  { glyph: string; label: string }
> = {
  is_empty: { glyph: '∅', label: 'is empty' },
  is_not_empty: { glyph: '!∅', label: 'is not empty' },
  equals: { glyph: '=', label: 'equals' },
  not_equals: { glyph: '!=', label: 'not equals' },
  contains: { glyph: 'has', label: 'contains' },
  greater_than: { glyph: '>', label: 'greater than' },
  less_than: { glyph: '<', label: 'less than' },
}

/**
 * The Branch predicate picker: one small glyph button that drops down the seven
 * operators. Replaces a full-width `<select>`, which spent a whole row on a
 * value the author sets once and left no room beside it for the operand — the
 * two halves of a single sentence ("kind = image") now sit on one line.
 */
export function BranchOperatorSelect({
  value,
  onChange,
}: {
  value: BranchOperator
  onChange: (operator: BranchOperator) => void
}) {
  const meta = BRANCH_OPERATOR_META[value]
  return (
    <Popover
      className="relative shrink-0"
      panelClassName="border-border bg-popover absolute left-0 z-50 mt-1 w-44 rounded-md border p-1 shadow-lg"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Condition: ${meta.label}`}
          onClick={toggle}
          className={cn(
            'border-input hover:bg-accent flex h-9 min-w-9 items-center justify-center rounded-md border px-2 font-mono text-sm transition',
            open && 'bg-accent',
          )}
        >
          {meta.glyph}
        </button>
      )}
    >
      {({ close }) => (
        <div role="listbox">
          {BRANCH_OPERATORS.map((op) => {
            const selected = op === value
            return (
              <button
                key={op}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(op)
                  close()
                }}
                className={cn(
                  'hover:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition',
                  selected && 'bg-accent',
                )}
              >
                <span className="text-muted-foreground w-7 shrink-0 text-center font-mono">
                  {BRANCH_OPERATOR_META[op].glyph}
                </span>
                <span>{BRANCH_OPERATOR_META[op].label}</span>
                {!branchOperatorTakesValue(op) ? (
                  <span className="text-muted-foreground ml-auto text-[10px]">
                    no value
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      )}
    </Popover>
  )
}
