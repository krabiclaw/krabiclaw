import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { listingMessagingContext } from '~/server/utils/conversation-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { setListingMessagingAccess } from '~/server/domain/conversation-participants'

export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { listingId, env, db, principal, memberIds } = await listingMessagingContext(event)
  const { member_id: memberId, allowed } = await readStrictBody<{ member_id?: string; allowed?: boolean }>(event, { member_id: 'string', allowed: 'boolean' })
  if (!memberId || typeof allowed !== 'boolean') throw new HTTPError({ statusCode: 422, message: 'Select a member and whether they may message guests', data: { code: 'INVALID_LISTING_MESSAGING_GRANT', field: 'member_id' } })
  await setListingMessagingAccess(db, env, principal, { listingId, memberId, allowed })
  return jsonResponse({ member_ids: await memberIds() })
})
