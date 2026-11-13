import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { listingMessagingContext } from '~/server/utils/conversation-request'

export default defineHandler(async event => {
  const { memberIds } = await listingMessagingContext(event)
  return jsonResponse({ member_ids: await memberIds() })
})
