import assert from 'node:assert/strict'
import test from 'node:test'
import { stayInstallments } from '~/shared/stay-installments'

function nights(from: string, count: number, price = (_: string) => 5_000) {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)) + index)).toISOString().slice(0, 10)
    return { date, price_minor: price(date) }
  })
}

test('a long stay is paid monthly from its check-in anniversaries, adding up to its total', () => {
  assert.equal(stayInstallments({ check_in_date: '2026-12-01', check_out_date: '2026-12-28', nightly: nights('2026-12-01', 27) }), null)
  // Jan 31 falls on Feb 28 then Mar 31; a weekend surcharge stays in the month it belongs to.
  const stay = { check_in_date: '2027-01-31', check_out_date: '2027-04-15', nightly: nights('2027-01-31', 74, date => new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 7_000 : 5_000) }
  const plan = stayInstallments(stay)!
  assert.deepEqual(plan.map(period => [period.period_start, period.period_end]), [['2027-01-31', '2027-02-28'], ['2027-02-28', '2027-03-31'], ['2027-03-31', '2027-04-15']])
  assert.equal(plan.reduce((sum, period) => sum + period.amount_minor, 0), stay.nightly.reduce((sum, night) => sum + night.price_minor, 0))
})
