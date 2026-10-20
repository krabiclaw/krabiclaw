export interface BlawbyRateResult {
  percentage: number
  rate: number
  standardRate: number
}

export const PRICING_CALCULATOR_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'array',
        description: 'Household size, 250% income limit, 350% income limit, 400% income limit, in that order.',
        items: { type: ['number', 'string', 'null'] },
      },
    },
  },
} as const

export function parsePricingAmount(value: unknown) {
  const amount = Number(String(value ?? '').replace(/[^0-9.]/g, ''))
  return Number.isFinite(amount) ? amount : 0
}

export function calculateSlidingScaleRate(input: {
  householdSize: number
  income: number
  period: 'annual' | 'monthly'
  rows: unknown[][]
  rates?: { standard: number; at250: number; at350: number; at400: number }
}): BlawbyRateResult {
  const rates = input.rates ?? { standard: 320, at250: 160, at350: 215, at400: 240 }
  const size = Math.min(8, Math.max(1, Math.trunc(input.householdSize)))
  const row = input.rows.find(candidate => Number(candidate[0]) === size) ?? input.rows[size - 1] ?? []
  const annualIncome = Math.max(0, Number.isFinite(input.income) ? input.income : 0) * (input.period === 'monthly' ? 12 : 1)
  const limit250 = parsePricingAmount(row[1])
  const limit350 = parsePricingAmount(row[2])
  const limit400 = parsePricingAmount(row[3])

  if (annualIncome <= limit250) return { percentage: 50, rate: rates.at250, standardRate: rates.standard }
  if (annualIncome <= limit350) return { percentage: 33, rate: rates.at350, standardRate: rates.standard }
  if (annualIncome <= limit400) return { percentage: 25, rate: rates.at400, standardRate: rates.standard }
  return { percentage: 0, rate: rates.standard, standardRate: rates.standard }
}
