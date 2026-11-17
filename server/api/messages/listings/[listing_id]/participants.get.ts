import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { listingAccessContext } from '~/server/utils/conversation-request'

export default defineHandler(async event => {
  const { grants } = await listingAccessContext(event)
  return jsonResponse({ grants: await grants() })
})
