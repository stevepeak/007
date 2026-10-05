import { describe, expect, mock, test } from 'bun:test'

import { runRoomStub } from './room-address'

function fakeNamespace() {
  const ns = {
    idFromName: mock((n: string) => `id:${n}`),
    get: mock((id: string) => ({ id })),
    jurisdiction: mock(),
  }
  const scoped = {
    idFromName: mock((n: string) => `eu:${n}`),
    get: mock((id: string) => ({ id })),
  }
  ns.jurisdiction.mockReturnValue(scoped)
  return { ns, scoped }
}

describe('runRoomStub', () => {
  test('addresses the plain namespace when no jurisdiction is set', () => {
    const { ns } = fakeNamespace()
    const stub = runRoomStub({ RUN_ROOM: ns as never }, 'r1')
    expect(ns.jurisdiction).not.toHaveBeenCalled()
    expect(stub as unknown).toEqual({ id: 'id:r1' })
  })

  test('scopes the namespace to the configured jurisdiction', () => {
    const { ns, scoped } = fakeNamespace()
    const stub = runRoomStub(
      { RUN_ROOM: ns as never, RUN_ROOM_JURISDICTION: 'eu' },
      'r1',
    )
    expect(ns.jurisdiction).toHaveBeenCalledWith('eu')
    expect(scoped.idFromName).toHaveBeenCalledWith('r1')
    expect(stub as unknown).toEqual({ id: 'eu:r1' })
  })

  test('throws on an unknown jurisdiction rather than falling back', () => {
    const { ns } = fakeNamespace()
    expect(() => { return runRoomStub({ RUN_ROOM: ns as never, RUN_ROOM_JURISDICTION: 'mars' }, 'r1') },
    ).toThrow(/RUN_ROOM_JURISDICTION/)
  })
})
