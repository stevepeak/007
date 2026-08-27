import { resolvePath } from './binding'

// ---------------------------------------------------------------------------
// Naming one item of a fan-out
// ---------------------------------------------------------------------------
//
// A durable iteration turns a list into N runs, and every surface that lists
// them — the run viewer's breadcrumb, the sibling picker, the activity feed,
// the per-item picker — could only ever call them "Item 1", "Item 2". That is
// the position, not the thing: sweeping a 34-recipe upload for the one that
// failed means opening items until you recognise one.
//
// So an iteration carries an `itemTitle` template, and each item resolves it
// against ITS OWN value. `${title}` on a list of recipe tasks reads
// "Chocolate Mousse" where the index read "Item 12".
//
// WHY THIS IS NOT `interpolateUserText`. The `${…}` grammar shared by prompts,
// progress notes and tool status labels is deliberately flat — `[\w-]+`, no
// dots — because it addresses a bag of run VARIABLES. An item is a value, not a
// bag, and reaching into it is exactly what the editor's bindings already do
// through a dotted path. Widening the shared grammar to allow dots would make
// `${a.b}` a variable everywhere, including in agent prompts where it is
// currently literal text an author can type without consequence. So this uses
// the BINDING path language instead — the same `resolvePath` every `ref` in the
// graph resolves through, so `${recipe.name}` and `${items.0.label}` mean here
// exactly what they mean in the inspector's field pickers.

/**
 * A `${path}` token: one or more `[\w-]+` segments joined by dots.
 *
 * No escape handling, unlike `PROMPT_VARIABLE_RE`: that exists because prompt
 * bodies round-trip through a Markdown serializer that escapes `_`. A title
 * template is a plain input and never sees one.
 */
export const ITEM_TITLE_TOKEN_RE = /\$\{([\w-]+(?:\.[\w-]+)*)\}/g

/**
 * How much of a resolved title is kept. It lands in a breadcrumb, a dropdown
 * row and a one-line feed label, and it is filled from arbitrary run data — a
 * template pointed at the wrong field can produce a paragraph. Truncating is
 * better than letting one item's description reflow every list it appears in.
 */
export const ITEM_TITLE_MAX_LENGTH = 80

/** Distinct paths a title template references, in order. Powers editor hints. */
export function itemTitleTokens(template: string): string[] {
  const seen = new Set<string>()
  for (const m of template.matchAll(ITEM_TITLE_TOKEN_RE)) {
    if (m[1]) seen.add(m[1])
  }
  return [...seen]
}

/** Render one resolved value as title text. Objects are deliberately NOT
 *  JSON-stringified — a title reading `{"a":1,…}` is noise where a blank
 *  falls back to the item number, which at least means something. */
function titleText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

/**
 * The title for ONE item of an iteration, or null to fall back to its number.
 *
 * Null — not an empty string — is the answer whenever the template is absent or
 * resolves to nothing, so every caller can use {@link iterationItemLabel} and
 * none of them has to decide what a blank label means. An author pointing the
 * template at a field the items don't have gets "Item 3" back, exactly as
 * before the feature; a partially-resolved template ("Recipe: " with an empty
 * `${name}`) is likewise treated as nothing rather than shown half-filled.
 *
 * Built-ins `index` (1-based, matching what every list here displays) and
 * `total` fill in only when the item has no such field of its own — the item's
 * own data is the subject and always wins.
 */
export function iterationItemTitle(
  template: string | null | undefined,
  item: unknown,
  position?: { index: number; total?: number },
): string | null {
  const raw = template?.trim()
  if (!raw) return null

  let resolvedAny = false
  const filled = raw.replaceAll(ITEM_TITLE_TOKEN_RE, (_m, path: string) => {
    let value = resolvePath(item, path)
    if (value === undefined && position && !path.includes('.')) {
      if (path === 'index') value = position.index + 1
      else if (path === 'total' || path === 'n') value = position.total
    }
    const text = titleText(value).replaceAll(/\s+/g, ' ').trim()
    if (text) resolvedAny = true
    return text
  })

  // A template of pure literal text ("Recipe") names every item identically,
  // which is worse than numbering them — so a title has to have resolved at
  // least one token from the item to count.
  if (!resolvedAny) return null
  const title = filled.replaceAll(/\s+/g, ' ').trim()
  if (!title) return null
  return title.length > ITEM_TITLE_MAX_LENGTH
    ? `${title.slice(0, ITEM_TITLE_MAX_LENGTH - 1).trimEnd()}…`
    : title
}

/**
 * What to CALL an item. The single fallback rule, so the breadcrumb, the
 * sibling picker, the activity feed and the per-item picker can never disagree
 * about whether a given item has a name.
 */
export function iterationItemLabel(
  title: string | null | undefined,
  index: number,
): string {
  return title?.trim() || `Item ${index + 1}`
}

/**
 * The same name, numbered, for surfaces that render items as a LIST — the
 * sibling picker, the activity feed. A named item still needs its position
 * there: "the 30th of 34" is how someone came looking, and counting rows in a
 * dropdown to find it is exactly the friction the title is meant to remove.
 *
 * An UNNAMED item keeps the exact label these lists carried before titles
 * existed, `total` and all, so a workflow whose author sets no template reads
 * precisely as it did. A named one drops the total instead of stacking
 * "30. Chocolate Mousse / 34" — the count is on the container row above it,
 * and the name is the thing being scanned for.
 */
export function iterationItemListLabel(
  title: string | null | undefined,
  index: number,
  total?: number,
): string {
  const named = title?.trim()
  if (named) return `${index + 1}. ${named}`
  return total != null ? `Item ${index + 1} / ${total}` : `Item ${index + 1}`
}
