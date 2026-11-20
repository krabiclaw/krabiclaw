import { HTTPError } from 'nitro'
import { execute, queryFirst, type DbClient } from '~/server/db'
import { stayHomeDraftInput, type StayHomeDraftInput } from '~/shared/stay-home-setup'
import { hydrateMediaAssetRefs, mediaAssetRefsQuery, resolveMediaAssetRefs, type MediaAsset } from '~/server/utils/media-asset-manager'
import { creationDedupeKey, creationRequestHash } from '~/server/utils/organization-events'
import type { ViewerTerms } from '~/server/utils/member-access'
import { organizationFeaturesFromRow, organizationFeaturesQuery } from '~/server/utils/cms-capabilities'
import { parsePostalAddress } from '~/utils/postal-address'
import { isCurrencyCode } from '~/shared/currencies'
import { STAY_SETUP_DESCRIPTION_LIMIT, STAY_SETUP_TITLE_LIMIT, STAY_WEEKEND_ADJUSTMENT_MIN, STAY_WEEKEND_ADJUSTMENT_MAX, type StayHomeSetupResponse } from '~/shared/stay-home-setup'
import { STAY_AMENITIES, STAY_AMENITY_GROUPS, STAY_LISTING_TYPES, STAY_PROPERTY_TYPE_GROUPS, STAY_PROPERTY_TYPES } from '~/shared/stay-listing'
import { MAX_ORDERED_MEDIA_ASSETS } from '~/shared/media-placement-contract'
import { MAX_STAY_NIGHTS, STAY_DIRECT_DISCOUNTS } from '~/shared/bookings'
import { STAY_SAFETY_FIELDS, STAY_SAFETY_DETAILS_LIMIT } from '~/shared/stay-safety'

const propertyChoices = Object.entries(STAY_PROPERTY_TYPES).map(([value, { label, icon }]) => ({
  value,
  label: value === 'house' ? 'House' : value === 'apartment' ? 'Apartment' : label,
  icon,
}))
const prominentTypes = ['house', 'apartment']
const typesByName = propertyChoices.filter(choice => !prominentTypes.includes(choice.value)).sort((a, b) => a.label.localeCompare(b.label, 'en'))
export const propertyGroups = Object.entries(STAY_PROPERTY_TYPE_GROUPS)

export const highlightChoices = [
  { value: 'peaceful', label: 'Peaceful', icon: 'i-lucide-leaf', line: 'Slow down and unwind in a peaceful setting.' },
  { value: 'unique', label: 'Unique', icon: 'i-lucide-sparkles', line: 'Make yourself at home somewhere a little different.' },
  { value: 'family_friendly', label: 'Family-friendly', icon: 'i-lucide-users', line: 'Bring the whole family and enjoy time together.' },
  { value: 'stylish', label: 'Stylish', icon: 'i-lucide-armchair', line: 'Enjoy a thoughtfully styled place to stay.' },
  { value: 'central', label: 'Central', icon: 'i-lucide-map-pin', line: 'Stay in a central spot with easy access to the area.' },
  { value: 'spacious', label: 'Spacious', icon: 'i-lucide-expand', line: 'Settle in with plenty of room to spread out.' },
]
export const disclosures = (['exterior_security_cameras', 'noise_decibel_monitors', 'weapons_on_property'] as const).map(key => ({
  key, label: STAY_SAFETY_FIELDS[key].name, required: false, detail_key: STAY_SAFETY_FIELDS[key].detailsKey,
}))
const priceFields = [
  { key: 'base_price', label: 'Base price', required: true },
  { key: 'weekend_adjustment', label: 'Weekend adjustment', detail: 'Friday and Saturday nights', required: false },
]
const weekendCount = { key: 'weekend_adjustment', label: 'Weekend adjustment', min: STAY_WEEKEND_ADJUSTMENT_MIN, max: STAY_WEEKEND_ADJUSTMENT_MAX, step: 1 }
export const suggestedDiscounts = { last_minute_percent: 7, weekly_percent: 10, monthly_percent: 20 } satisfies Record<keyof typeof STAY_DIRECT_DISCOUNTS, number>
export const stayHomeSetupSteps = [
  { id: 'address-search', title: 'Enter your address', action: 'Next', search_placeholder: 'Search for an address', manual_label: 'Enter address manually' },
  { id: 'address', title: 'Confirm your address', action: 'Next', fields: [
    { key: 'country', label: 'Country or region', required: true },
    { key: 'address', label: 'Street address', required: true },
    { key: 'city', label: 'City or town', required: true },
    { key: 'state', label: 'State or region', required: false },
    { key: 'zip_code', label: 'Postal code', required: false },
    { key: 'timezone', label: 'Time zone', required: true },
  ] },
  { id: 'property', title: 'Which of these best describes your place?', action: 'Next',
    choices: [...prominentTypes.map(type => propertyChoices.find(choice => choice.value === type)!), ...typesByName] },
  { id: 'access', title: 'What space will guests have?', action: 'Next', choices: Object.entries(STAY_LISTING_TYPES).map(([value, type]) => ({
    value, label: value === 'private_room' ? 'Private room' : type.label, detail: type.description,
    icon: value === 'entire_place' ? 'i-lucide-house' : value === 'private_room' ? 'i-lucide-door-closed' : 'i-lucide-bed-double',
  })) },
  { id: 'pin', title: 'Is the pin in the right spot?', action: 'Next' },
  { id: 'visibility', title: 'Choose how guests see your location', action: 'Next' },
  { id: 'rooms', title: 'Share some basics about your place', action: 'Next', counts: [
    { key: 'max_guests', label: 'Guests', min: 1, max: 99, step: 1 },
    { key: 'bedrooms', label: 'Bedrooms', min: 0, max: 50, step: 1 },
    { key: 'beds', label: 'Beds', min: 0, max: Number.MAX_SAFE_INTEGER, step: 1 },
    { key: 'bathrooms', label: 'Bathrooms', min: 0, max: 50, step: 0.5 },
  ] },
  { id: 'amenities', title: 'Tell guests what your place offers', action: 'Next',
    groups: Object.values(STAY_AMENITY_GROUPS).map(group => ({
      label: group.label, choices: group.amenities.map(value => ({ value, label: STAY_AMENITIES[value].label, icon: STAY_AMENITIES[value].icon, symbol: STAY_AMENITIES[value].symbol })),
    })) },
  { id: 'photos', title: 'Add photos of your place', action: 'Next', max_photos: MAX_ORDERED_MEDIA_ASSETS },
  { id: 'title', title: 'Give your listing a title', action: 'Next', name_label: 'Listing title', max_length: STAY_SETUP_TITLE_LIMIT },
  { id: 'highlights', title: 'What stands out about your place?', detail: 'Choose up to two highlights to start your description.', action: 'Next',
    choices: highlightChoices.map(({ value, label, icon }) => ({ value, label, icon })), max_selections: 2 },
  { id: 'description', title: 'Write your listing description', action: 'Next', name_label: 'Listing description', max_length: STAY_SETUP_DESCRIPTION_LIMIT },
  { id: 'booking', title: 'Set a minimum stay', detail: 'Applies to this listing.', action: 'Next',
    counts: [{ key: 'min_nights', label: 'Minimum nights', min: 1, max: MAX_STAY_NIGHTS, step: 1 }] },
  { id: 'pricing', title: 'Now, set your prices', action: 'Next', fields: priceFields, counts: [weekendCount] },
  { id: 'discounts', title: 'Add discounts', detail: 'Optional. The largest eligible discount applies on your website.', action: 'Next',
    choices: Object.entries(STAY_DIRECT_DISCOUNTS).map(([value, { label, detail }]) => ({ value, label, detail, icon: 'i-lucide-percent', suggested_percent: suggestedDiscounts[value as keyof typeof suggestedDiscounts] })),
    counts: Object.keys(STAY_DIRECT_DISCOUNTS).map(key => ({ key, label: '%', min: 1, max: 99, step: 1 })) },
  { id: 'disclosures', title: 'Share safety details', detail: 'Guests see these details before they book.', action: 'Finish',
    fields: disclosures, max_length: STAY_SAFETY_DETAILS_LIMIT },
] satisfies (Exclude<Extract<StayHomeSetupResponse, { steps: unknown }>['steps'][number], { id: 'pricing' }> | { id: 'pricing'; title: string; action: string; fields: typeof priceFields; counts: typeof weekendCount[] })[] // Currency is resolved per workspace.

type Scope = { id: string; memberId: string }
type Draft = StayHomeDraftInput & { revision: string; finishHash?: string }

export const stayHomeDraftChanged = () => new HTTPError({ statusCode: 409, message: 'Your home setup changed. Reopen it to continue.', data: { code: 'STAY_HOME_DRAFT_CHANGED' } })

export async function readStayHomeSetupDraft(db: DbClient, organization: Scope) {
  const row = await queryFirst<{ payload_json: string; revision: string }>(db, 'SELECT payload_json, revision FROM stay_home_setup_drafts WHERE organization_id = ? AND member_id = ?', [organization.id, organization.memberId])
  return readSetupDraft(row)
}

function readSetupDraft(row: { payload_json: string; revision: string } | null | undefined) {
  if (!row) return null
  const payload = JSON.parse(row.payload_json)
  return { ...stayHomeDraftInput.parse(payload), revision: row.revision, finishHash: typeof payload.finishHash === 'string' ? payload.finishHash : undefined }
}

export type StayHomeSetupLocation = { id: string; address: string | null; timezone: string | null; latitude: number | null; longitude: number | null; stay_map_sharing: 'general' | 'specific' }

// The onboarding location is the address the owner has already supplied for their first home.
export function stayHomeSetupAddressDefaults(main: StayHomeSetupLocation | null | undefined) {
  const postal = parsePostalAddress(main?.address)
  return {
    address: postal?.addressLines.join(', ') ?? '',
    city: postal?.locality ?? '',
    state: postal?.administrativeArea ?? '',
    country: postal?.regionCode ?? '',
    zip_code: postal?.postalCode ?? '',
    timezone: main?.timezone ?? '',
  }
}

export function prepareStayHomeSetup(viewer: ViewerTerms) {
  const org = { sql: viewer.organization }
  const draft = `SELECT payload_json, revision FROM stay_home_setup_drafts WHERE organization_id = ${viewer.organization} AND member_id = ${viewer.member}`
  const photos = mediaAssetRefsQuery(org, { sql: `SELECT value FROM json_each((SELECT payload_json FROM (${draft})), '$.photo_ids')` })
  return {
    queries: [
      organizationFeaturesQuery(org),
      { query: `SELECT timezone, default_currency FROM organization WHERE id = ${viewer.organization}`, params: [] },
      { query: `SELECT id, address, timezone, latitude, longitude, stay_map_sharing FROM business_locations
        WHERE organization_id = ${viewer.organization} AND slug = 'main' AND status = 'active'
          AND NOT EXISTS (SELECT 1 FROM product_stay_configs WHERE organization_id = ${viewer.organization})`, params: [] },
      { query: draft, params: [] }, photos,
    ],
    read([features, workspaceRows, mainRows, draftRows, photoRows]: D1Result[]): Extract<StayHomeSetupResponse, { steps: unknown }> {
      if (!organizationFeaturesFromRow(features!.results[0] as Parameters<typeof organizationFeaturesFromRow>[0]).includes('stays')) throw new HTTPError({ statusCode: 422, message: 'This business has no places to stay', data: { code: 'STAYS_REQUIRED' } })
      const workspace = workspaceRows!.results[0] as { timezone: string | null; default_currency: string } | undefined
      if (!isCurrencyCode(workspace?.default_currency)) throw new Error('Workspace is missing its pricing currency')
      const currency = workspace.default_currency
      const main = mainRows!.results[0] as StayHomeSetupLocation | undefined
      const current = readSetupDraft(draftRows!.results[0] as Parameters<typeof readSetupDraft>[0])
      let draft: Extract<StayHomeSetupResponse, { steps: unknown }>['draft'] = null
      if (current) {
        const { photo_ids, finishHash, ...saved } = current
        draft = { ...saved, photos: resolveMediaAssetRefs(photoRows!.results as MediaAsset[], { refs: photo_ids.map(asset_id => ({ asset_id })), allowedKinds: ['image'], fieldName: 'photos' }).map(({ asset_id, public_url }) => ({ asset_id, public_url })), ...(finishHash ? { finishing: true } : {}) }
      }
      return {
        steps: stayHomeSetupSteps.map(step => step.id === 'pricing' ? { ...step, currency, currency_symbol: new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(part => part.type === 'currency')!.value } : step),
        defaults: { ...stayHomeSetupAddressDefaults(main),
          ...(main ? { location_id: main.id } : {}), ...(main?.latitude != null && main.longitude != null ? { latitude: main.latitude, longitude: main.longitude } : {}), stay_map_sharing: main?.stay_map_sharing ?? 'general', timezone: main?.timezone || workspace.timezone || '', min_nights: 1, max_guests: 1, bedrooms: 0, beds: 0, bathrooms: 0 },
        exit_label: 'Save & exit', back_label: 'Back', draft,
      }
    },
  }
}

export async function stayHomeDraftPhotos(db: DbClient, organizationId: string, ids: string[]) {
  const assets = await hydrateMediaAssetRefs(db, { organizationId, refs: ids.map(asset_id => ({ asset_id })), allowedKinds: ['image'], fieldName: 'photos' })
  return assets.map(({ asset_id, public_url }) => ({ asset_id, public_url }))
}

export async function writeStayHomeSetupDraft(db: DbClient, organization: Scope, input: StayHomeDraftInput, current: Draft | null, finish = false) {
  const finishHash = finish ? await creationRequestHash({ ...input, amenities: [...input.amenities].sort() }) : undefined
  if (current?.finishHash) {
    if (finishHash === current.finishHash) return current.revision
    throw stayHomeDraftChanged()
  }
  const revision = finish && current ? current.revision : crypto.randomUUID()
  const payload = JSON.stringify({ ...input, finishHash })
  const result = current
    ? await execute(db, `UPDATE stay_home_setup_drafts SET payload_json = ?, revision = ?
        WHERE organization_id = ? AND member_id = ? AND revision = ? AND json_type(payload_json, '$.finishHash') IS NULL`,
      [payload, revision, organization.id, organization.memberId, current.revision])
    : await execute(db, `INSERT INTO stay_home_setup_drafts (payload_json, revision, organization_id, member_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(organization_id, member_id) DO NOTHING`, [payload, revision, organization.id, organization.memberId])
  if (result.meta.changes !== 1) throw stayHomeDraftChanged()
  return revision
}

export async function clearStayHomeSetupDraft(db: DbClient, organization: Scope, revision: string) {
  await execute(db, 'DELETE FROM stay_home_setup_drafts WHERE organization_id = ? AND member_id = ? AND revision = ?', [organization.id, organization.memberId, revision])
}

export async function reopenUncommittedStayHomeSetupDraft(db: DbClient, organization: Scope, revision: string, idempotencyKey: string) {
  await execute(db, `UPDATE stay_home_setup_drafts SET payload_json = json_remove(payload_json, '$.finishHash')
    WHERE organization_id = ? AND member_id = ? AND revision = ?
      AND NOT EXISTS (SELECT 1 FROM activity_entries WHERE dedupe_key IN (?, ?))`, [organization.id, organization.memberId, revision,
    creationDedupeKey('location', organization.id, idempotencyKey), creationDedupeKey('product', organization.id, idempotencyKey)])
}
