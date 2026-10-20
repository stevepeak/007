import { describe, expect, test } from 'bun:test'

import { nodeStatusFrameClass } from './node-renderers-shared'

describe('nodeStatusFrameClass', () => {
  const accent = 'border-l-fuchsia-400'

  test('a running node glows', () => {
    expect(nodeStatusFrameClass({ status: 'running', accent })).toContain(
      'wf-node-glow',
    )
  })

  test('invalid or failed reads red and drops the accent', () => {
    for (const cls of [
      nodeStatusFrameClass({ invalid: true, status: 'running', accent }),
      nodeStatusFrameClass({ status: 'failed', accent }),
    ]) {
      expect(cls).toContain('border-l-rose-500')
      expect(cls).not.toContain(accent)
      expect(cls).not.toContain('wf-node-glow')
    }
  })

  test('otherwise keeps the kind accent, dimming a skipped node', () => {
    expect(nodeStatusFrameClass({ status: undefined, accent })).toBe(accent)
    expect(nodeStatusFrameClass({ status: 'skipped', accent })).toBe(
      `${accent} opacity-60`,
    )
  })
})
