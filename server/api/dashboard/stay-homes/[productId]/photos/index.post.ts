import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { addStayHomePhoto, stayAccessFor } from '~/server/domain/stays'

// Add a photo to a place to stay: a multipart form whose `image` part is the file.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const access = await stayAccessFor(principal)
  if (!event.req.headers.get('content-type')?.startsWith('multipart/form-data')) {
    throw new HTTPError({ statusCode: 415, statusMessage: 'Send the photo as multipart/form-data', data: { code: 'UNSUPPORTED_MEDIA_TYPE', field: 'content-type' } })
  }
  const form = await event.req.formData()
  return jsonResponse({ home: await addStayHomePhoto(db, env, access, principal, getRouterParam(event, 'productId') ?? '', form.get('image')) }, { status: 201 })
})
