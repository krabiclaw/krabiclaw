import type { Price, PriceSelection } from '~/shared/prices'
import { formatMinorAmount, selectPrice } from '~/shared/prices'
import type { ProductVariant } from '~/server/types/products'

/**
 * Render one resolved offer.
 *
 * Null means the caller omits the price element entirely. There is no
 * "Price on request" stand-in: text nobody supplied is not a price.
 */
export function formatProductMoney(price: Price | null, locale?: string): string | null {
  return price ? formatMinorAmount(price.unit_amount, price.currency, locale) : null
}

/**
 * The price a surface shows for one variant, in one currency and location.
 *
 * A thin pass-through to the one selection contract, so a component never
 * reaches into `variant.prices` and invents a rule of its own. It throws on an
 * ambiguous set and returns null when nothing applies — both are the surface's
 * problem to state, not to paper over.
 */
export function formatVariantPrice(variant: ProductVariant, selection: PriceSelection, locale?: string): string | null {
  return formatProductMoney(selectPrice(variant.prices, selection), locale)
}

/** Card prices use the same offer selection as the chosen variant at checkout. */
export function summarizeProductPrices(variants: readonly ProductVariant[], selections: readonly PriceSelection[]) {
  const offers = [...new Map(selections.flatMap(selection => variants.filter(variant => variant.active)
    .flatMap(variant => selectPrice(variant.prices, selection) ?? [])).map(offer => [offer.id, offer])).values()]
  if (!offers.length) return { lowest: null, highest: null, count: 0 }
  if (new Set(offers.map(offer => offer.currency)).size !== 1) throw new Error('A price range requires one currency')
  offers.sort((left, right) => left.unit_amount - right.unit_amount)
  return { lowest: offers[0]!, highest: offers.at(-1)!, count: offers.length }
}

export function formatProductPriceRange(summary: ReturnType<typeof summarizeProductPrices>, locale?: string): string | null {
  if (!summary.lowest || !summary.highest) return null
  const lowest = formatProductMoney(summary.lowest, locale)!
  return summary.lowest.unit_amount === summary.highest.unit_amount ? lowest : `${lowest} – ${formatProductMoney(summary.highest, locale)}`
}
