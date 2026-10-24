import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { airbnbUnsynced, addStayHomePhoto, stayAccessFor } from '~/server/domain/stays'
import { isRecord } from '~/server/utils/type-guards'

// Add an image file, or append an explicit asset from the organization's library.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const principal = memberAccessPrincipal(organization, { env, event })
  const access = await stayAccessFor(principal)
  const contentType = event.req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  let photo: unknown
  if (contentType === 'application/json') {
    photo = await readRequiredBody<unknown>(event)
    if (!isRecord(photo)) throw new HTTPError({ statusCode: 422, statusMessage: 'Choose the library photo by its asset_id', data: { code: 'PHOTO_REQUIRED', field: 'asset_id' } })
  } else if (contentType === 'multipart/form-data') {
    photo = (await event.req.formData()).get('image')
  } else {
    throw new HTTPError({ statusCode: 415, statusMessage: 'Send an asset_id as application/json or an image file as multipart/form-data', data: { code: 'UNSUPPORTED_MEDIA_TYPE', field: 'content-type' } })
  }
  const home = await addStayHomePhoto(db, env, access, principal, getRouterParam(event, 'productId') ?? '', photo)
  // Photos are Airbnb's to hold: a home syncing with Airbnb names where to change them there too.
  return jsonResponse({ home, airbnb_unsynced: airbnbUnsynced(home, ['photos']) }, { status: 201 })
})
