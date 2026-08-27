import { describe, expect, test } from 'bun:test'

import {
  ITEM_TITLE_MAX_LENGTH,
  iterationItemLabel,
  iterationItemListLabel,
  iterationItemTitle,
  itemTitleTokens,
} from './item-title'

// The one rule the whole feature rests on: a title that cannot be resolved must
// degrade to the item's NUMBER, never to a blank. Every surface that lists items
// calls through here, so a template pointed at a field the list doesn't have has
// to leave the run viewer exactly as readable as it was before titles existed.

describe('iterationItemTitle', () => {
  test('reads a field off the item', () => {
    expect(iterationItemTitle('${title}', { title: 'Chocolate Mousse' })).toBe(
      'Chocolate Mousse',
    )
  })

  test('reads a DOTTED path, which a prompt variable cannot', () => {
    // The reason this doesn't reuse `interpolateUserText`: the shared
    // prompt-variable grammar is `[\w-]+`, so `${recipe.name}` isn't a token
    // there at all and would survive as literal text.
    expect(
      iterationItemTitle('${recipe.name}', { recipe: { name: 'Bavarois' } }),
    ).toBe('Bavarois')
  })

  test('indexes into an array, the same as a binding ref', () => {
    expect(
      iterationItemTitle('${rows.0.label}', { rows: [{ label: 'First' }] }),
    ).toBe('First')
  })

  test('mixes literal text around the tokens', () => {
    expect(
      iterationItemTitle('${course} — ${name}', {
        course: 'Dessert',
        name: 'Tarte',
      }),
    ).toBe('Dessert — Tarte')
  })

  test('no template means numbering', () => {
    expect(iterationItemTitle('', { title: 'x' })).toBeNull()
    expect(iterationItemTitle(undefined, { title: 'x' })).toBeNull()
    expect(iterationItemTitle('   ', { title: 'x' })).toBeNull()
  })

  test('a template pointing at a missing field falls back, not blank', () => {
    // The failure mode that matters. An author typing `${name}` over a list of
    // `{ title }` gets "Item 3" back — the same label as before — rather than a
    // column of empty rows that look like a broken run viewer.
    expect(iterationItemTitle('${name}', { title: 'Tarte' })).toBeNull()
  })

  test('a partially resolved template is treated as resolved', () => {
    // One token landing is enough to tell items apart, which is the whole job.
    expect(
      iterationItemTitle('${course}: ${name}', { name: 'Tarte' }),
    ).toBe(': Tarte')
  })

  test('pure literal text is not a title', () => {
    // It would name every item identically — strictly worse than numbering
    // them, since the numbers at least distinguish.
    expect(iterationItemTitle('Recipe', { title: 'Tarte' })).toBeNull()
  })

  test('an item that is a bare string has no fields to read', () => {
    expect(iterationItemTitle('${title}', 'Chocolate Mousse')).toBeNull()
  })

  test('numbers and booleans render; objects and arrays do not', () => {
    expect(iterationItemTitle('#${n}', { n: 7 })).toBe('#7')
    // A title reading `{"a":1}` is noise. Falling back to "Item 3" is not.
    expect(iterationItemTitle('${x}', { x: { a: 1 } })).toBeNull()
    expect(iterationItemTitle('${x}', { x: [1, 2] })).toBeNull()
  })

  test('built-ins fill in only where the item has no such field', () => {
    expect(
      iterationItemTitle('${index} of ${total}', {}, { index: 2, total: 12 }),
    ).toBe('3 of 12')
    // The item's own data is the subject and always wins — an item that has an
    // `index` field means that field, not the loop position.
    expect(
      iterationItemTitle('${index}', { index: 'A7' }, { index: 2, total: 12 }),
    ).toBe('A7')
  })

  test('collapses whitespace so a multi-line value stays one line', () => {
    expect(
      iterationItemTitle('${desc}', { desc: 'two\n\n  lines' }),
    ).toBe('two lines')
  })

  test('truncates a runaway value rather than reflowing every list', () => {
    const long = 'a'.repeat(500)

    const title = iterationItemTitle('${desc}', { desc: long })

    expect(title).toHaveLength(ITEM_TITLE_MAX_LENGTH)
    expect(title?.endsWith('…')).toBe(true)
  })
})

describe('itemTitleTokens', () => {
  test('lists the distinct paths a template reads', () => {
    expect(itemTitleTokens('${a} ${b.c} ${a}')).toEqual(['a', 'b.c'])
  })

  test('ignores malformed tokens', () => {
    expect(itemTitleTokens('${a b} ${}')).toEqual([])
  })
})

describe('labels', () => {
  test('an unnamed item is numbered, in both forms', () => {
    expect(iterationItemLabel(null, 29)).toBe('Item 30')
    expect(iterationItemListLabel(null, 29)).toBe('Item 30')
  })

  test('the list form keeps the total when there is no name', () => {
    // Exactly what these lists read before titles existed, so a workflow whose
    // author sets no template is untouched by the feature.
    expect(iterationItemListLabel(null, 29, 34)).toBe('Item 30 / 34')
  })

  test('a named item is bare in the crumb and numbered in a list', () => {
    expect(iterationItemLabel('Tarte', 29)).toBe('Tarte')
    // The number survives in lists: "the 30th of 34" is how someone came
    // looking, and counting dropdown rows to find it is the friction the title
    // exists to remove. The total drops — it is on the container row already.
    expect(iterationItemListLabel('Tarte', 29, 34)).toBe('30. Tarte')
  })

  test('a whitespace-only title is not a name', () => {
    expect(iterationItemLabel('   ', 4)).toBe('Item 5')
    expect(iterationItemListLabel('   ', 4, 9)).toBe('Item 5 / 9')
  })
})
