import { defineHandler } from 'nitro'
import { staffAccessWritesEnabled } from '~/server/domain/listing-access'
import { jsonResponse } from '~/server/utils/api-response'
import { listingAccessContext } from '~/server/utils/conversation-request'

export default defineHandler(async event => {
  const { env, grants } = await listingAccessContext(event)
  return jsonResponse({ grants: await grants(), staff_access_writes: staffAccessWritesEnabled(env) })
})
