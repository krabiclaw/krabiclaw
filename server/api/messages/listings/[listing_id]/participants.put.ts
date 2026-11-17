import { listingAccessLevels, type StoredListingAccess } from '~/utils/organization-access'
import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { listingAccessContext } from '~/server/utils/conversation-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { setListingAccess } from '~/server/domain/conversation-participants'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { listingId, env, db, principal, grants } = await listingAccessContext(event)
  const { member_id: memberId, access } = await readStrictBody<{ member_id?: string; access?: StoredListingAccess | null }>(event, { member_id: 'string', access: 'nullable-string' })
  if (!memberId || access === undefined || (access !== null && access !== 'messaging' && !Object.hasOwn(listingAccessLevels, access))) {
    throw new HTTPError({ statusCode: 422, message: 'Select a member and listing access level', data: { code: 'INVALID_LISTING_ACCESS' } })
  }
  await setListingAccess(db, env, principal, { listingId, memberId, access })
  return jsonResponse({ grants: await grants() })
})
