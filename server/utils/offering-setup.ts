import { HTTPError } from 'nitro'
import type { OfferingSetupAnswer, OfferingSetupField, OfferingSetupResponse } from '~/shared/offering-setup'
import { queryFirst, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { productEditorPath } from '~/server/utils/dashboard-links'
import { creationDedupeKey, readCreationRecord } from '~/server/utils/organization-events'
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'

export interface OfferingSetupContext {
  db: DbClient
  env: CloudflareEnv
  organizationId: string
  orgSlug: string
  actorId: string
  principal: MemberAccessPrincipal
}

export const invalidOfferingAnswer = (message: string) => new HTTPError({ statusCode: 400, statusMessage: message, data: { code: 'INVALID_OFFERING_ANSWER' } })
export const offeringSetupChanged = () => new HTTPError({ statusCode: 409, statusMessage: 'Setup changed. Reopen it to continue.', data: { code: 'OFFERING_SETUP_CHANGED' } })
export const offeringToday = (orgSlug: string) => `/dashboard/${encodeURIComponent(orgSlug)}`

export function offeringDestination(orgSlug: string, productId: string, locationId?: string): OfferingSetupResponse {
  return { to: productEditorPath(orgSlug, productId, locationId), product_id: productId, ...(locationId ? { location_id: locationId } : {}) }
}

export function offeringScreen(input: {
  id: string
  title: string
  detail?: string
  fields: OfferingSetupField[]
  index: number
  total: number
  backTo: string
  exitTo: string
  revision?: string
}): OfferingSetupResponse {
  return {
    step: {
      id: input.id, title: input.title, ...(input.detail ? { detail: input.detail } : {}),
      fields: input.fields, position: input.index + 1, total: input.total,
      next_label: input.index + 1 === input.total ? 'Finish' : 'Next',
    },
    ...(input.revision ? { revision: input.revision } : {}),
    back_to: input.backTo, exit_to: input.exitTo, back_label: 'Back', exit_label: 'Save & exit',
  }
}

export function offeringField(key: string, label: string, kind: OfferingSetupField['kind'], value = '', properties: Partial<OfferingSetupField> = {}): OfferingSetupField {
  return { key, label, kind, value, ...properties }
}

export function currencySymbol(currency: string): string {
  const formatted = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
  return formatted.formatToParts(0).find(part => part.type === 'currency')!.value
}

export function offeringTimezone(value = ''): OfferingSetupField {
  const choices = [...new Set([value, ...TIMEZONE_OPTIONS])].filter(Boolean)
    .map(zone => ({ value: zone, label: timezoneLabel(zone) }))
  return offeringField('timezone', 'Time zone', 'timezone', value, { choices })
}

export function submittedValue(answer: OfferingSetupAnswer, key: string): string {
  return answer.values[key]?.trim() ?? ''
}


/** A deliberate restart after deletion is a new creation; retries share that key. */
export async function offeringProductCreation(db: DbClient, organizationId: string, baseKey: string) {
  let key = baseKey
  for (;;) {
    const creation = await readCreationRecord(db, creationDedupeKey('product', organizationId, key))
    if (!creation) return { key, productId: undefined }
    if (await queryFirst(db, 'SELECT 1 FROM products WHERE organization_id = ? AND id = ?', [organizationId, creation.entityId])) {
      return { key, productId: creation.entityId }
    }
    key = `${baseKey}:after:${creation.entityId}`
  }
}
