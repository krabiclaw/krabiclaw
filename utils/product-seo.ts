import type { Product, PublicProduct } from '~/server/types/products'
import { isExperience } from '~/utils/product-presentation'
import { formatProductMoney } from '~/utils/product-money'
import { selectPrice, type Price, type PriceSelection } from '~/shared/prices'
import { DESCRIPTION_MAX_LENGTH, truncateForSeo } from '~/utils/social-metadata'

/**
 * Product-page SEO derived entirely from data the MCP already writes (#SEO dish
 * pages). Nothing here asks an owner to author per-product content: name,
 * description, category, price and location are the only inputs, so every
 * current and future tenant gets the same treatment the moment its catalogue is
 * imported.
 */

/**
 * A catalogue row with no customer-facing price at all — neither a numeric
 * Price nor an explicit `price-note` detail — is a placeholder, not something
 * the business is offering. Those rows still render (owners see their own
 * catalogue as it is) but they canonicalise to the collection index instead of
 * competing with it as a standalone result.
 */
export function isOfferedProduct(product: PublicProduct, selection: PriceSelection): boolean {
  return product.variants.some(variant => selectPrice(variant.prices, selection) !== null)
}

export interface ProductCollectionSibling {
  id: string
  name: string
  slug: string
  /** Its picture, as a card shows it. */
  image_url: string | null
  /** The lowest price on offer where the page is read. */
  price: Price | null
}

/** Links per product page. Bounded so a 60-item collection does not turn every
 *  page into a full menu dump. */
export const COLLECTION_SIBLING_LIMIT = 8

/**
 * Other products in the same collection.
 *
 * The window rotates: it starts at the item after the current one and wraps, so
 * consecutive dishes in a large collection link to overlapping-but-different
 * neighbours. That reaches every item through internal links instead of
 * pointing all of them at the same first eight.
 *
 * `products` is expected in the order the collection page renders, so the list
 * a visitor sees here matches the menu they just came from.
 */
export function selectProductCollectionSiblings(
  products: readonly PublicProduct[],
  product: PublicProduct,
  collectionId: string,
  selection: PriceSelection,
  limit: number = COLLECTION_SIBLING_LIMIT,
): ProductCollectionSibling[] {
  // Siblings share the surface the page is read on: an experience links to
  // experiences, a dish to dishes. A collection holding both would otherwise
  // send a reader to a page that does not exist under this route's name.
  const inCollection = products.filter(candidate =>
    candidate.collections.some(membership => membership.collection_id === collectionId)
    && isExperience(candidate) === isExperience(product)
    && isOfferedProduct(candidate, selection))
  const index = inCollection.findIndex(candidate => candidate.id === product.id)
  const rotated = index === -1
    ? inCollection
    : [...inCollection.slice(index + 1), ...inCollection.slice(0, index)]
  return rotated.slice(0, limit).map(({ id, name, slug, image, variants }) => ({
    id, name, slug, image_url: (image?.kind === 'video' ? image.thumbnail_url : image?.public_url) ?? null,
    price: variants.map(variant => selectPrice(variant.prices, selection)).filter((price): price is Price => price !== null).sort((left, right) => left.unit_amount - right.unit_amount)[0] ?? null,
  }))
}

/** Everything the composed description reads. All of it is product data. */
export type ProductSeoSubject = Pick<Product, 'name' | 'description' | 'variants'>

export interface ProductSeoDescriptionInput {
  /** The product, already localized for the rendering locale. */
  product: ProductSeoSubject
  /** The location this product is sold at, already localized. */
  locationTitle: string
  /** Which offer to quote, if the page quotes one. */
  priceSelection: PriceSelection
}

/** Translator shape supplied by the caller's `useI18n()`. */
export type ProductSeoTranslate = (key: string, named: Record<string, string>) => string

/** Shortest description fragment worth appending to the composed frame. */
const MIN_DETAIL_BUDGET = 8

/** A trailing sentence stop would double up against the template's own. */
function withoutTrailingStop(text: string): string {
  return text.trim().replace(/[.\s]+$/u, '')
}

/**
 * The product's own subject line.
 *
 * One source: the product's description. SEO copy used to be a second
 * editable field on the product AND a field on its page, and the two drifted;
 * page-level SEO now belongs to the canonical document, and this composes from
 * the product's own words. An empty description yields an empty subject line,
 * and the frame below carries the tag on its own — it does not reach for the
 * site blurb, which gave hundreds of dish pages one identical description.
 */
function productSubjectLine(product: ProductSeoSubject): string {
  return withoutTrailingStop(product.description)
}

/**
 * The meta description for a product page, composed from the product's own
 * data. A product page never inherits the site blurb: doing so gave hundreds of
 * Kikuzuki dish pages one identical description.
 *
 * The template frame (name, price, location) is measured first and the
 * product's own subject line gets whatever budget is left, so the
 * distinguishing facts survive truncation instead of being cut off by a long
 * description.
 */
export function composeProductSeoDescription(
  input: ProductSeoDescriptionInput,
  translate: ProductSeoTranslate,
): string {
  // Formatted exactly as the page body formats it, so the tag and the rendered
  // price never disagree.
  const priceLabel = formatProductMoney(
    input.product.variants.flatMap(variant => selectPrice(variant.prices, input.priceSelection) ?? []).at(0) ?? null,
  )
  const named = {
    name: input.product.name.trim(),
    location: input.locationTitle.trim(),
    ...(priceLabel ? { price: priceLabel.trim() } : {}),
  }
  const subject = productSubjectLine(input.product)
  const describedKey = priceLabel
    ? 'saya.product_detail.meta_description_priced'
    : 'saya.product_detail.meta_description'
  const detailBudget = DESCRIPTION_MAX_LENGTH - translate(describedKey, { ...named, detail: '' }).length
  // Under a word's worth of budget the frame alone already fills the tag; adding
  // an ellipsis-only fragment would just be noise.
  const detail = !subject || detailBudget < MIN_DETAIL_BUDGET
    ? ''
    : truncateForSeo(subject, detailBudget) ?? ''
  // A product with nothing of its own to say gets the frame written for that
  // case. Feeding an empty detail into the described frame published the
  // punctuation around it — "Sprite — . THB 320.00 at Kikuzuki Ao Nang."
  const key = detail
    ? describedKey
    : priceLabel
      ? 'saya.product_detail.meta_description_undescribed_priced'
      : 'saya.product_detail.meta_description_undescribed'
  const composed = truncateForSeo(translate(key, { ...named, detail }), DESCRIPTION_MAX_LENGTH)
  if (!composed) throw new Error('Product SEO description composed to an empty string')
  return composed
}

export const DIETARY_SCHEMA_MAP: Record<string, string> = {
  V: 'https://schema.org/VegetarianDiet',
  VG: 'https://schema.org/VeganDiet',
  GF: 'https://schema.org/GlutenFreeDiet',
}

export function extractDietarySchemaUrls(product: PublicProduct): string[] {
  const notes = product.details['dietary_notes']
  if (!Array.isArray(notes)) return []
  return notes
    .filter((note): note is 'V' | 'VG' | 'GF' => note === 'V' || note === 'VG' || note === 'GF')
    .map(tag => DIETARY_SCHEMA_MAP[tag])
    .filter((url): url is string => Boolean(url))
}
