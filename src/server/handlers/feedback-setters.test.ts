import { beforeEach, describe, expect, test } from 'bun:test'

import type { WfDb } from '../../storage/client'
import { getFeedbackForSubjects, upsertFeedback } from '../../storage/data'
import { freshDb } from '../../storage/db-test-helpers'

import { buildFeedbackHandlers } from './feedback'
import { testHandlerCtx, testHandlerOptions } from './handler-test-helpers'
import { NotFoundError } from './shared'

// The triage setters update an existing row; a subject nobody rated is a 404,
// not a silent `ok`.

describe('feedback triage setters', () => {
  let db: WfDb
  const h = buildFeedbackHandlers(testHandlerOptions())
  beforeEach(async () => {
    db = freshDb()
    await upsertFeedback(db, { subjectId: 's1', rating: 'down' })
  })

  test('acknowledge and note an existing row', async () => {
    await h.setFeedbackAcknowledged(
      testHandlerCtx(db, { subjectId: 's1', acknowledged: true }),
    )
    await h.setFeedbackInternalNote(
      testHandlerCtx(db, { subjectId: 's1', note: '  looked into it  ' }),
    )
    const [row] = await getFeedbackForSubjects(db, ['s1'])
    expect(row.ackAt).not.toBeNull()
    expect(row.internalNote).toBe('looked into it')
  })

  test('an unknown subject is NotFound', async () => {
    await expect(
      h.setFeedbackAcknowledged(
        testHandlerCtx(db, { subjectId: 'nope', acknowledged: true }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      h.setFeedbackInternalNote(
        testHandlerCtx(db, { subjectId: 'nope', note: 'x' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
