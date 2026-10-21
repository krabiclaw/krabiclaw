import type { StayAmenity, StayCancellationPolicy, StayLongTermCancellationPolicy, StayPropertyType, StayPropertyTypeGroup, StayListingType, StayPropertySizeUnit } from '~/shared/stay-listing'
import type { ResolvedMediaAsset } from '~/server/utils/media-asset-manager'
import type { Price, PriceInput } from '~/shared/prices'
import type { ProductDetails, ProductDetailsPatch, ProductKind } from '~/shared/product-details'
import type { SocialImageSource } from '~/utils/social-metadata'

export type ProductSource = 'manual' | 'template' | 'ai' | 'import' | 'copy'

/** One buyable configuration. A product with no options still has one. */
export interface ProductVariant {
  id: string
  product_id: string
  name: string
  sku: string | null
  active: boolean
  sort_order: number
  /** Which value this variant selects for each of the product's options. */
  option_values: Record<string, string>
  prices: Price[]
}

export interface ProductOptionValue {
  id: string
  value: string
  sort_order: number
}

export interface ProductOption {
  id: string
  name: string
  sort_order: number
  values: ProductOptionValue[]
}

/** Site publication state. Absent from the map means the site does not carry it. */
export interface ProductPublication {
  organization_id: string
  published: boolean
}

/** Where the product is offered, and under what controls. */
export interface ProductLocation {
  location_id: string
  active: boolean
  published: boolean
}

export interface Collection {
  id: string
  organization_id: string
  location_id: string | null
  name: string
  slug: string
  description: string | null
  /** The section's own picture, its `image` placement; null when it has none, never another owner's. */
  image: ResolvedMediaAsset | null
  sort_order: number
  created_at: string
  updated_at: string
  created_by: string
  updated_by: string
}

/** What generating this product's occurrences starts from. Sessions keep their own. */
export type ProductBookingConfig = Pick<import('~/server/utils/availability').ProductBookingConfigRecord, 'duration_minutes' | 'default_capacity' | 'confirmation_mode' | 'online_payment_required' | 'held_online' | 'scheduling_mode' | 'assigned_member_id' | 'assigned_team_id'>

/**
 * A place to stay: the one location it is at and its stay settings. Times are
 * local HH:MM in that location's timezone.
 */
export interface ProductStayConfig {
  location_id: string
  check_in_time: string
  check_out_time: string
  max_guests: number
  min_nights: number
  /** What the home is: Airbnb's property group and a type in it, both or neither; null when the host has not said. */
  property_type_group: StayPropertyTypeGroup | null
  property_type: StayPropertyType | null
  listing_type: StayListingType | null
  /** Floors are one-based. Null means the host has not said. */
  total_floors: number | null
  listing_floor: number | null
  year_built: number | null
  /** The authored indoor area and its unit, both populated or both null. */
  property_size: number | null
  property_size_unit: StayPropertySizeUnit | null
  /** 0 is a studio. null when the host has not said. */
  bedrooms: number | null
  beds: number | null
  /** Whole and half baths, such as 3.5. */
  bathrooms: number | null
  /** The amenity codes the home offers, in catalog order; empty offers none. */
  amenities: StayAmenity[]
  /** For stays shorter than 28 nights. Shown to guests; it does not refund by itself. */
  cancellation_policy: StayCancellationPolicy | null
  /** For stays of 28 nights or more. */
  long_term_cancellation_policy: StayLongTermCancellationPolicy | null
  /** Who looks after the home: their stays are what an assigned member sees. */
  assigned_member_id: string | null
  assigned_team_id: string | null
}

/** What a home is and offers; unsaid when a home is created without them. */
export type StayListingField = 'property_type_group' | 'property_type' | 'listing_type' | 'total_floors' | 'listing_floor' | 'year_built' | 'property_size' | 'property_size_unit' | 'bedrooms' | 'beds' | 'bathrooms' | 'amenities' | 'cancellation_policy' | 'long_term_cancellation_policy'
export type ProductStayConfigInput = Omit<ProductStayConfig, StayListingField> & Partial<Pick<ProductStayConfig, StayListingField>>

/** Who looks after a product: workspace state the public site never carries. */
export type StaffAssignment = 'assigned_member_id' | 'assigned_team_id'

/** Membership of one product in one collection, carrying its position there. */
export interface CollectionMembership {
  collection_id: string
  sort_order: number
}

/**
 * Catalog identity. Publication, location, pricing, grouping, stock and
 * booking are relationships hanging off this, never columns on it, so the same
 * product can appear on two sites at two prices without being duplicated.
 */
export interface Product {
  kind: ProductKind
  id: string
  organization_id: string
  name: string
  slug: string
  description: string
  /** Merchant sale-enable control. Not visibility, not stock. */
  active: boolean
  order_url: string | null
  /** Stripe `unit_label`: a unit noun such as 'person'. Never pricing prose. */
  unit_label: string | null
  marketing_features: string[]
  /** Validated string-to-string annotations. No domain behavior reads this. */
  metadata: Record<string, string>
  tax_code: string | null
  options: ProductOption[]
  variants: ProductVariant[]
  /** Typed descriptive attributes, keyed by '<namespace>.<key>'. */
  details: ProductDetails
  publications: ProductPublication[]
  locations: ProductLocation[]
  collections: CollectionMembership[]
  /**
   * Non-null exactly when this product takes bookings.
   *
   * The existence of the configuration row is the capability — not a vertical,
   * not a type, not a non-null duration. Every surface reads it from here, so
   * the CMS and the public page cannot disagree about whether a product is
   * bookable or about the defaults its sessions are generated from.
   */
  booking: ProductBookingConfig | null
  /** Non-null exactly when this product is a place to stay (kind `stay`). */
  stay: ProductStayConfig | null
  /**
   * The source page this product owns, or null when it has none. The binding
   * is the page's root `product_id`; translations inherit it. A product's
   * Page content is this document, edited through the shared page editor.
   */
  page: ProductPage | null
  image: ResolvedMediaAsset | null
  gallery: ResolvedMediaAsset[]
  media: ResolvedMediaAsset[]
  social_image: SocialImageSource | null
  source: ProductSource
  created_at: string
  updated_at: string
  created_by: string
  updated_by: string
}

/** The page a product owns: its source document's id, public path and title. */
export interface ProductPage {
  id: string
  path: string
  title: string
}

export interface ProductVariantInput {
  id?: string
  name: string
  sku?: string | null
  active?: boolean
  sort_order?: number
  /** option id -> option value id. Must answer every option exactly once. */
  option_values?: Record<string, string>
  prices?: PriceInput[]
}

export interface ProductOptionInput {
  id?: string
  name: string
  sort_order?: number
  values: { id?: string; value: string; sort_order?: number }[]
}

export interface CreateProductInput {
  kind: ProductKind
  name: string
  description?: string
  active?: boolean
  order_url?: string | null
  unit_label?: string | null
  marketing_features?: string[]
  metadata?: Record<string, string>
  tax_code?: string | null
  options?: ProductOptionInput[]
  /** Omitted means one default variant is created. */
  variants?: ProductVariantInput[]
  details?: ProductDetails
  source?: ProductSource
  /** Required for kind `stay` and refused for every other kind. */
  stay?: ProductStayConfigInput
}

/** Existing identities accept partial fields; a new entry must supply its required fields. */
export type ProductVariantPatchInput = Omit<Partial<ProductVariantInput>, 'prices'> & {
  prices?: Partial<PriceInput>[]
  /** Merge preserves unmentioned prices. Replace removes prices omitted from the supplied list. */
  prices_mode?: 'merge' | 'replace'
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'source' | 'variants' | 'stay' | 'details'>> & {
  /** The Product updated_at from the caller's read; a stale snapshot refuses the entire edit. */
  expected_updated_at?: string
  /** Stay settings to change. The location a home is at is fixed when it is created. */
  stay?: Partial<Omit<ProductStayConfig, 'location_id'>>
  variants?: ProductVariantPatchInput[]
  /** Merge preserves unmentioned variants. Replace removes variants omitted from the supplied list. */
  variants_mode?: 'merge' | 'replace'
} & ({
  /** Merge preserves unmentioned facts; null explicitly removes a named fact. */
  details_mode: 'merge'
  details: ProductDetailsPatch
} | {
  /** Omitted or replace replaces the detail map, retaining featured unless supplied. */
  details_mode?: 'replace'
  details?: ProductDetails
})

export interface SetProductPublicationInput {
  organization_id: string
  published: boolean
}

export interface SetProductLocationInput {
  location_id: string
  active?: boolean
  published?: boolean
}

export interface CreateCollectionInput {
  location_id?: string | null
  name: string
  description?: string | null
  sort_order?: number
}

export interface UpdateCollectionInput {
  name?: string
  description?: string | null
  sort_order?: number
}

/** The complete intended membership and order. Partial orders are rejected. */
export interface SetCollectionProductsInput {
  collection_id: string
  product_ids: string[]
  expected_product_ids?: string[]
  /** Source removals append to this collection, atomically, under both complete ordered snapshots. */
  move_to?: { collection_id: string; expected_product_ids: string[] }
}

export interface ReorderCollectionsInput {
  organization_id: string
  location_id?: string | null
  collection_ids: string[]
  expected_collection_ids?: string[]
}

export type ReconcileProductInput = CreateProductInput & { product_id?: string }

/**
 * The public surfaces a catalog reaches guests through.
 *
 * Four, because guests read four different things: a restaurant's dishes
 * are its Menu, anything a guest books a seat on is an Experience, a place a
 * guest sleeps is a Place to stay, and the goods a merchant sells are
 * Products. One Product model, named on the page the way the customer says it.
 */
export type ProductSurface = 'menu' | 'products' | 'experiences' | 'stays'

/** The surfaces whose items have a page of the site's own, named by the item's slug alone. */
export type SiteProductSurface = 'experiences' | 'stays'

export interface ProductPresentation {
  feature: 'products'
  collectionPath: '/menu' | '/products' | '/services' | '/experiences' | '/stays' | '/schedule'
  locationCollectionSegment: ProductSurface
  productPath: (_locationSlug: string, _productSlug: string) => string
  collectionLabel: 'Menu' | 'Products' | 'Experiences' | 'Consultations' | 'Services' | 'Places to stay'
  itemLabel: 'Dish' | 'Product' | 'Experience' | 'Service' | 'Place to stay'
  // English plurals are irregular enough here ("Dish" -> "Dishes",
  // "Collection" -> "Collections") that appending an "s" produces visible typos.
  itemLabelPlural: 'Dishes' | 'Products' | 'Experiences' | 'Services' | 'Places to stay'
  collectionGroupLabel: 'Section' | 'Collection'
  collectionGroupLabelPlural: 'Sections' | 'Collections'
  /**
   * What this surface's items are, in schema.org's vocabulary: dishes are
   * MenuItems, goods are Products, a bookable experience is an Event and a
   * place to stay is an Accommodation.
   */
  structuredDataType: 'MenuItem' | 'Product' | 'Event' | 'Accommodation'
}

/** A product as the public site serves it: everything but who on the team looks after it. */
export type PublicProduct<T extends Product = Product> = Omit<T, 'booking' | 'stay'> & {
  booking: Omit<ProductBookingConfig, StaffAssignment> | null
  stay: Omit<ProductStayConfig, StaffAssignment> | null
}
