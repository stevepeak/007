import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  describeTriggerEvents,
  enforceOutputContract,
  type TriggerRegistry,
} from './trigger-registry'

// A host registry with one contract-bearing event (chat) and one without.
const triggers: TriggerRegistry = {
  chat_message: {
    description: 'New chat message',
    inputSchema: z.object({ userText: z.string() }),
    outputContractSchema: z.object({ text: z.string() }),
  },
  ping: {
    description: 'A contract-less event',
    inputSchema: z.object({ ok: z.boolean() }),
  },
}

describe('enforceOutputContract', () => {
  test('passes and returns output satisfying the contract', () => {
    expect(
      enforceOutputContract(triggers, 'chat_message', { text: 'hi' }),
    ).toEqual({ text: 'hi' })
  })

  test('throws when the output violates the contract', () => {
    expect(() => {
      return enforceOutputContract(triggers, 'chat_message', { notText: 1 })
    }).toThrow(/does not satisfy the 'chat_message' trigger contract/)
  })

  test('throws when a contract-required run produced no output', () => {
    expect(() => {
      return enforceOutputContract(triggers, 'chat_message', undefined)
    }).toThrow()
  })

  test('passes through untouched when the trigger declares no contract', () => {
    const out = { anything: true }
    expect(enforceOutputContract(triggers, 'ping', out)).toBe(out)
  })

  test('passes through for the built-in manual trigger', () => {
    expect(enforceOutputContract(triggers, 'manual', 42)).toBe(42)
  })
})

describe('describeTriggerEvents', () => {
  test('surfaces the output contract as JSON Schema for the editor', () => {
    const options = describeTriggerEvents(triggers)
    const chat = options.find((o) => o.kind === 'chat_message')
    expect(chat?.outputContract).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    })
    const ping = options.find((o) => o.kind === 'ping')
    expect(ping?.outputContract).toBeUndefined()
  })

  // A trigger input is what a caller PASSES, so a defaulted field is optional
  // to it — the output side would list it as required.
  test('describes the trigger input from the side a caller passes', () => {
    const [option] = describeTriggerEvents({
      queued: {
        description: 'Queued job',
        inputSchema: z.object({ id: z.string(), priority: z.number().default(0) }),
      },
    })
    expect(option.inputSchema).toMatchObject({ required: ['id'] })
  })
})
