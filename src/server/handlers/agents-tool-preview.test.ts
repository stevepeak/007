import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../../storage/client'
import {
  setConnectorToolEnabled,
  upsertConnector,
  upsertConnectorTools,
} from '../../storage/data/connectors'
import { freshDb } from '../../storage/db-test-helpers'

import { buildAgentHandlers } from './agents'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'

// The tool playground accepts exactly what `listTools` advertises: host tools
// and enabled connector tools. Anything else is refused before the host hook
// builds live deps.

describe('runToolPreview — which tools it accepts', () => {
  let db: WfDb
  const ran: string[] = []
  beforeEach(async () => {
    db = freshDb()
    ran.length = 0
    await upsertConnector(db, { id: 'acme', label: 'Acme', url: 'https://acme.example/mcp' })
    await upsertConnectorTools(db, 'acme', [
      {
        name: 'search',
        description: 'search',
        inputSchema: { type: 'object' },
        sideEffect: 'read',
        schemaHash: 'h',
      },
    ])
  })

  const run = (toolId: string) => {
    const h = buildAgentHandlers(
      testHandlerOptions({
        config: { toolRegistry: new Map() },
        runToolPreview: async (input) => {
          ran.push(input.toolId)
          return { output: null, args: input.args, durationMs: 0 }
        },
      }),
    )
    return h.runToolPreview(testHandlerCtx(db, { toolId, args: {} }))
  }

  test('runs an enabled connector tool', async () => {
    await setConnectorToolEnabled(db, { toolId: 'mcp:acme:search', enabled: true })
    await run('mcp:acme:search')
    expect(ran).toEqual(['mcp:acme:search'])
  })

  test('refuses a connector tool nobody enabled', async () => {
    await expect(run('mcp:acme:search')).rejects.toThrow('is not registered')
    expect(ran).toEqual([])
  })

  test('refuses an unknown id', async () => {
    await expect(run('nope')).rejects.toThrow('is not registered')
    expect(ran).toEqual([])
  })
})
