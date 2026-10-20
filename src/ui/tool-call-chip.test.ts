import { describe, expect, test } from 'bun:test'

import { isDelegationToolId } from './tool-call-chip'

describe('isDelegationToolId', () => {
  test('matches the synthesized delegation tools', () => {
    expect(isDelegationToolId({ toolId: 'spawn_researcher' })).toBe(true)
    expect(isDelegationToolId({ toolId: 'await_subagents' })).toBe(true)
    expect(isDelegationToolId({ toolId: 'check_subagents' })).toBe(true)
  })

  test('leaves ordinary tool ids alone', () => {
    expect(isDelegationToolId({ toolId: 'web_search' })).toBe(false)
    expect(isDelegationToolId({ toolId: 'respawn_job' })).toBe(false)
    expect(isDelegationToolId({ toolId: 'subagents_list' })).toBe(false)
  })
})
