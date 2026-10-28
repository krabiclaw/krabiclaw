/**
 * What an Airbnb listing's import is made of, in the words both the dashboard
 * and the iOS app show: the fields Airbnb leaves out that a host supplies, the
 * home types Channex accepts, and the stages an import passes through. The
 * server reads the same lists, so the copy a host sees names what the import
 * actually asks for.
 */

export const DETAIL_FIELDS = ['timezone', 'email', 'phone', 'country', 'state', 'city', 'address', 'zipCode', 'propertyType'] as const
export type DetailField = typeof DETAIL_FIELDS[number]

export const DETAIL_FIELD_TITLES: Readonly<Record<DetailField, string>> = {
  timezone: 'Time zone',
  email: 'Contact email',
  phone: 'Contact phone',
  country: 'Country code (e.g. US)',
  state: 'State or region',
  city: 'City',
  address: 'Street address',
  zipCode: 'Postal code',
  propertyType: 'Home type',
}

export const PROPERTY_TYPES = ['apartment', 'holiday_home', 'villa', 'chalet', 'lodge'] as const
export type AirbnbPropertyType = typeof PROPERTY_TYPES[number]

export const PROPERTY_TYPE_LABELS: Readonly<Record<AirbnbPropertyType, string>> = {
  apartment: 'Apartment', holiday_home: 'House', villa: 'Villa', chalet: 'Chalet', lodge: 'Lodge',
}

/**
 * A listing's import, stage by stage. Through `draft` it builds the home and
 * its Channex property and nothing syncs with Airbnb: a draft is free on every
 * plan. Activate moves a draft to `mapping`, where the plan is checked before
 * Channex maps the listing; from there the home is live.
 */
export const IMPORT_STAGES = ['property', 'room', 'rate', 'inventory', 'verify_inventory', 'content', 'draft', 'mapping', 'activate', 'reservations', 'messages', 'complete'] as const
export type ImportStage = typeof IMPORT_STAGES[number]

/** What a stage in progress is doing, as the app tells the host. */
export function importStageTitle(stage: ImportStage): string {
  switch (stage) {
    case 'property': case 'room': case 'rate': return 'Setting up your home…'
    case 'inventory': case 'verify_inventory': return 'Copying and checking your calendar…'
    case 'content': return 'Bringing over your photos and description…'
    case 'draft': return 'Saved as a draft'
    case 'mapping': case 'activate': return 'Connecting your listing with Airbnb…'
    case 'reservations': return 'Requesting your reservations…'
    case 'messages': return 'Connecting guest messages…'
    case 'complete': return 'Your home is ready'
  }
}

/** An import past preparing but short of draft or complete: a sync that stopped part-way, finished when applied again. */
export function isInterruptedStage(stage: ImportStage): boolean {
  return stage !== 'draft' && stage !== 'complete'
}
