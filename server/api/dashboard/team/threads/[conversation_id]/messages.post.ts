import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { sendTeamMessage } from '~/server/domain/team-messages'

// A message with photos arrives as a form, its photos as `photos` parts in the
// order they were chosen, the way a guest reply does; a text message is JSON.
export default defineHandler(async (event) => {
  const { env, db, session, organization } = await getDashboardMemberContext(event, {})
  const access = memberAccessPrincipal(organization, { env, event })
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  const form = multipart ? await event.req.formData() : null
  const body = form ? null : await readStrictBody<{ body?: unknown; idempotency_key?: unknown }>(event, { body: 'string', idempotency_key: 'string' })
  const formText = (name: string) => form?.get(name) ?? undefined
  const photos = form
    ? await Promise.all(form.getAll('photos').map(async (part) => {
        if (!(part instanceof File)) throw new HTTPError({ statusCode: 422, statusMessage: 'Each photos part must be a file', data: { code: 'INVALID_PHOTO', field: 'photos' } })
        return { bytes: new Uint8Array(await part.arrayBuffer()), filename: part.name || 'photo' }
      }))
    : []
  const result = await sendTeamMessage(env, db, access, getRouterParam(event, 'conversation_id') ?? '', {
    body: form ? formText('body') : body!.body,
    photos,
    idempotency_key: form ? formText('idempotency_key') : body!.idempotency_key,
    senderName: session.user.name,
  })
  return jsonResponse({ message: result.message }, { status: result.created ? 201 : 200 })
})
