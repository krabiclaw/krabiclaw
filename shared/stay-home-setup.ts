import { changeNightPrice } from './bookings'
import { majorAmountToMinor } from './prices'
import type { CurrencyCode } from './currencies'
import { z } from 'zod'

export const STAY_WEEKEND_ADJUSTMENT_MIN = -99
export const STAY_WEEKEND_ADJUSTMENT_MAX = 999

/** The entered price and adjustment are converted once to the stored nightly rates. */
export function staySetupNightlyRates(base: string, currency: CurrencyCode, adjustment = 0) {
  const basePrice = majorAmountToMinor(base.trim().replace(',', '.'), currency)
  if (basePrice < 1) throw new RangeError('Enter a positive base price')
  if (!Number.isInteger(adjustment) || adjustment < STAY_WEEKEND_ADJUSTMENT_MIN || adjustment > STAY_WEEKEND_ADJUSTMENT_MAX) {
    throw new RangeError(`Enter a weekend adjustment from ${STAY_WEEKEND_ADJUSTMENT_MIN}% to ${STAY_WEEKEND_ADJUSTMENT_MAX}%`)
  }
  const weekendPrice = changeNightPrice(basePrice, adjustment)
  if (!Number.isSafeInteger(weekendPrice) || weekendPrice < 1) throw new RangeError('Enter an adjustment that gives a valid weekend price')
  return { basePrice, weekendPrice }
}

export const STAY_SETUP_TITLE_LIMIT = 50
export const STAY_SETUP_DESCRIPTION_LIMIT = 500

const choice = z.object({ value: z.string(), label: z.string(), icon: z.string() })
const field = z.object({ key: z.string(), label: z.string(), required: z.boolean() })
const count = z.object({ key: z.string(), label: z.string(), min: z.number(), max: z.number(), step: z.number() })
const actionStep = z.object({ title: z.string(), action: z.string(), detail: z.string().optional() })
const ids = ['address-search', 'address', 'property', 'access', 'pin', 'visibility', 'rooms', 'amenities', 'photos', 'title', 'highlights', 'description', 'booking', 'pricing', 'discounts', 'disclosures'] as const
const draftAnswers = z.record(z.string(), z.union([z.string(), z.number()]))
export const stayHomeDraftInput = z.object({
  step: z.enum(ids),
  answers: draftAnswers,
  amenities: z.array(z.string()),
  photo_ids: z.array(z.string().trim().min(1)),
  idempotency_key: z.string().trim().min(1).max(200),
})
export type StayHomeDraftInput = z.infer<typeof stayHomeDraftInput>

const step = z.discriminatedUnion('id', [
  actionStep.extend({ id: z.literal('highlights'), choices: z.array(choice), max_selections: z.number().int().positive() }),
  actionStep.extend({ id: z.literal('booking'), counts: z.array(count) }),
  actionStep.extend({ id: z.literal('address-search'), search_placeholder: z.string(), manual_label: z.string() }),
  actionStep.extend({ id: z.literal('pricing'), fields: z.array(field.extend({ detail: z.string().optional() })), currency: z.string(), currency_symbol: z.string(), counts: z.array(count) }),
  actionStep.extend({ id: z.literal('discounts'), choices: z.array(choice.extend({ detail: z.string(), suggested_percent: z.number().int() })), counts: z.array(count) }),
  actionStep.extend({ id: z.literal('disclosures'), fields: z.array(field.extend({ detail_key: z.string() })), max_length: z.number().int().positive() }),
  z.object({ id: z.literal('address'), title: z.string(), action: z.string(), fields: z.array(field) }),
  z.object({ id: z.literal('property'), title: z.string(), action: z.string(),
    choices: z.array(choice) }),
  z.object({ id: z.literal('access'), title: z.string(), action: z.string(), choices: z.array(choice.extend({ detail: z.string() })) }),
  z.object({ id: z.literal('pin'), title: z.string(), action: z.string() }),
  z.object({ id: z.literal('visibility'), title: z.string(), action: z.string() }),
  z.object({ id: z.literal('amenities'), title: z.string(), action: z.string(), groups: z.array(z.object({ label: z.string(), choices: z.array(choice.extend({ symbol: z.string() })) })) }),
  z.object({ id: z.literal('photos'), title: z.string(), action: z.string(), max_photos: z.number().int().positive() }),
  z.object({ id: z.literal('rooms'), title: z.string(), action: z.string(),
    counts: z.array(count) }),
  z.object({ id: z.enum(['title', 'description']), title: z.string(), action: z.string(), name_label: z.string(), max_length: z.number().int().positive() }),
])

export const stayHomeSetupResponse = z.union([
  z.object({ steps: z.array(step).nonempty(), defaults: draftAnswers, exit_label: z.string(), back_label: z.string(), draft: stayHomeDraftInput.omit({ photo_ids: true }).extend({
    photos: z.array(z.object({ asset_id: z.string(), public_url: z.string() })), revision: z.string(), finishing: z.literal(true).optional(),
  }).nullable() }),
  z.object({ next: z.enum(ids), suggested_description: z.string().optional() }).strip(),
  z.object({ home: z.object({ product_id: z.string(), live: z.literal(false) }), to: z.string() }),
  z.object({ to: z.string() }),
])

export type StayHomeSetupResponse = z.infer<typeof stayHomeSetupResponse>
