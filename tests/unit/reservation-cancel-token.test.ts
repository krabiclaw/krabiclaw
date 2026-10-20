import assert from 'node:assert/strict'
import test from 'node:test'
import { createReplayableReservationCancelToken, hashReservationCancelToken } from '../../server/utils/reservation-cancel-token.ts'

test('operator creation replay recovers the same cancellation capability without storing plaintext', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-20T00:00:00.000Z') })
  const first = await createReplayableReservationCancelToken('local-signing-secret', 'tenant-one:request-one')
  t.mock.timers.tick(86400000)
  const retry = await createReplayableReservationCancelToken('local-signing-secret', 'tenant-one:request-one')
  assert.equal(first.token, retry.token)
  assert.equal(await hashReservationCancelToken(first.token), await hashReservationCancelToken(retry.token))
  const otherRequest = await createReplayableReservationCancelToken('local-signing-secret', 'tenant-one:request-two')
  const otherTenant = await createReplayableReservationCancelToken('local-signing-secret', 'tenant-two:request-one')
  const otherSecret = await createReplayableReservationCancelToken('another-signing-secret', 'tenant-one:request-one')
  for (const other of [otherRequest, otherTenant, otherSecret]) assert.notEqual(first.token, other.token)
  await assert.rejects(createReplayableReservationCancelToken('', 'request-one'), /signing secret/)
})
