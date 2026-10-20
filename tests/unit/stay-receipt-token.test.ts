import assert from 'node:assert/strict'
import test from 'node:test'
import { createReplayableReservationCancelToken } from '../../server/utils/reservation-cancel-token.ts'
import { createStayReceiptToken, verifyStayReceiptToken } from '../../server/utils/stay-receipt-token.ts'

test('a stay receipt has a signed expiry fixed at 30 days after creation, including on retries', async t => {
  const createdAt = '2026-10-20T00:00:00.000Z'
  t.mock.timers.enable({ apis: ['Date'], now: new Date(createdAt) })
  const first = await createStayReceiptToken('receipt-secret', 'stay-one', createdAt)
  assert.equal(first.expiresAt, '2026-11-19T00:00:00.000Z')
  t.mock.timers.tick(86400000)
  assert.deepEqual(await createStayReceiptToken('receipt-secret', 'stay-one', createdAt), first)
  t.mock.timers.setTime(Date.parse(first.expiresAt) - 1)
  assert.equal(await verifyStayReceiptToken('receipt-secret', 'stay-one', first.token), true)
  t.mock.timers.tick(1)
  assert.equal(await verifyStayReceiptToken('receipt-secret', 'stay-one', first.token), false)
  t.mock.timers.tick(1)
  assert.equal(await verifyStayReceiptToken('receipt-secret', 'stay-one', first.token), false)
})

test('stay receipts reject forged expiries, signatures, other stays, other secrets and cancellation capabilities', async () => {
  const { token } = await createStayReceiptToken('receipt-secret', 'stay-one', new Date().toISOString())
  const [expiry, signature] = token.split('.')
  const forgedExpiry = `${Number(expiry) + 86400000}.${signature}`
  const forgedSignature = `${expiry}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`
  const cancellation = await createReplayableReservationCancelToken('receipt-secret', 'stay-one')
  for (const invalid of ['', 'forged', `${expiry}.`, `NaN.${signature}`, `${token}.extra`, forgedExpiry, forgedSignature, cancellation.token]) {
    assert.equal(await verifyStayReceiptToken('receipt-secret', 'stay-one', invalid), false)
  }
  assert.equal(await verifyStayReceiptToken('receipt-secret', 'stay-two', token), false)
  assert.equal(await verifyStayReceiptToken('other-secret', 'stay-one', token), false)
  await assert.rejects(createStayReceiptToken('', 'stay-one', new Date().toISOString()), /signing secret/)
  await assert.rejects(createStayReceiptToken('receipt-secret', 'stay-one', 'invalid'), /creation time/)
})
