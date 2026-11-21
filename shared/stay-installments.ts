import { LONG_TERM_STAY_NIGHTS } from './stay-cancellation.ts'

/**
 * How a long stay is paid (#1907): as Airbnb bills stays of 28 nights or more,
 * monthly. Each period runs from a monthly anniversary of check-in to the next
 * (a check-in on the 31st falls on each month's last day), and its amount is
 * the nightly prices of its own nights, so the payments add up exactly to the
 * stay's total. The first is paid at checkout; each later one is due on its
 * period's first day.
 */
export interface StayInstallment {
  /** First night of the period, YYYY-MM-DD. */
  period_start: string
  /** The day after its last night: the next period's start, or checkout. */
  period_end: string
  amount_minor: number
}

function addMonths(date: string, months: number, day: number): string {
  const [year, month] = date.split('-').map(Number) as [number, number]
  const target = new Date(Date.UTC(year, month - 1 + months, 1))
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(day, last))
  return target.toISOString().slice(0, 10)
}

/** The stay's monthly payments, or null when it is shorter than a long stay and is paid at once. */
export function stayInstallments(stay: { check_in_date: string; check_out_date: string; nightly: ReadonlyArray<{ date: string; price_minor: number }> }): StayInstallment[] | null {
  if (stay.nightly.length < LONG_TERM_STAY_NIGHTS) return null
  const day = Number(stay.check_in_date.slice(8, 10))
  const periods: StayInstallment[] = []
  for (let index = 0, start = stay.check_in_date; start < stay.check_out_date; index++) {
    const next = addMonths(stay.check_in_date, index + 1, day)
    const end = next < stay.check_out_date ? next : stay.check_out_date
    const amount = stay.nightly.filter(night => night.date >= start && night.date < end).reduce((sum, night) => sum + night.price_minor, 0)
    periods.push({ period_start: start, period_end: end, amount_minor: amount })
    start = end
  }
  const total = stay.nightly.reduce((sum, night) => sum + night.price_minor, 0)
  if (periods.reduce((sum, period) => sum + period.amount_minor, 0) !== total) throw new Error('A stay’s monthly payments do not add up to its total')
  // A stay that fits in one month, or has a month with nothing to charge, is paid at once.
  if (periods.length < 2 || periods.some(period => period.amount_minor === 0)) return null
  return periods
}

/** A checkout's frozen plan: its periods, or null (or, from before monthly stays, absent) for a stay paid at once. */
export function isStayInstallments(value: unknown): value is StayInstallment[] | null | undefined {
  return value === null || value === undefined || (Array.isArray(value) && value.length > 1 && value.every(period => typeof period === 'object' && period !== null
    && typeof (period as StayInstallment).period_start === 'string' && typeof (period as StayInstallment).period_end === 'string'
    && Number.isSafeInteger((period as StayInstallment).amount_minor) && (period as StayInstallment).amount_minor > 0))
}

/** What the guest pays at checkout under the plan it froze: the first month, or the whole stay. */
export function stayCheckoutAmount(stay: { total_minor: number }, installments: StayInstallment[] | null | undefined): number {
  return installments?.[0]!.amount_minor ?? stay.total_minor
}
