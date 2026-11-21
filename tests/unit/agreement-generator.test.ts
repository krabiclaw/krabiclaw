import test from 'node:test'
import assert from 'node:assert/strict'
import { generateAgreementPdf } from '~/shared/agreement-generator'
import { calculateMonthlyPaymentSchedule } from '~/shared/agreements'

test('generateAgreementPdf creates valid PDF and accurately pre-positions signature fields', async () => {
  const result = await generateAgreementPdf({
    kind: 'stay',
    businessName: 'Blawby Property Management',
    counterpartyKey: 'user:harold',
    counterpartyName: 'Harold Webber',
    counterpartyEmail: 'harold@example.com',
    hostKey: 'user:host',
    hostName: 'Host Manager',
    propertyOrMatter: '908 Islander Way, Chattanooga, TN',
    termType: 'fixed',
    startDate: '2026-12-01',
    endDate: '2027-11-30',
    monthlyRentMinor: 150000,
    depositMinor: 150000,
    currency: 'USD',
  })

  assert.ok(result.bytes.byteLength > 1000, 'PDF bytes should be non-empty')
  assert.equal(result.fileName, 'stay-agreement.pdf')
  assert.equal(result.fields.length, 4, 'Should generate 4 fields (2 signature, 2 date)')

  const haroldSig = result.fields.find(f => f.signer_key === 'user:harold' && f.kind === 'signature')
  assert.ok(haroldSig, 'Harold signature field should exist')
  assert.ok(haroldSig.x > 0 && haroldSig.x < 1)
  assert.ok(haroldSig.y > 0 && haroldSig.y < 1)
  assert.ok(haroldSig.width > 0 && haroldSig.width < 1)
  assert.ok(haroldSig.height > 0 && haroldSig.height < 1)
})

test('calculateMonthlyPaymentSchedule correctly creates installment periods and tracks paid status', () => {
  const schedule = calculateMonthlyPaymentSchedule(
    '2026-01-01',
    '2026-04-01',
    150000, // $1,500/mo
    300000, // $3,000 paid so far
    '2026-02-15T00:00:00.000Z',
  )

  assert.equal(schedule.length, 3, 'Should produce 3 monthly periods')
  assert.equal(schedule[0]?.period, 1)
  assert.equal(schedule[0]?.amount_minor, 150000)
  assert.equal(schedule[0]?.paid_minor, 150000)
  assert.equal(schedule[0]?.status, 'paid')

  assert.equal(schedule[1]?.period, 2)
  assert.equal(schedule[1]?.amount_minor, 150000)
  assert.equal(schedule[1]?.paid_minor, 150000)
  assert.equal(schedule[1]?.status, 'paid')

  assert.equal(schedule[2]?.period, 3)
  assert.equal(schedule[2]?.amount_minor, 150000)
  assert.equal(schedule[2]?.paid_minor, 0)
  assert.equal(schedule[2]?.status, 'upcoming')
})
