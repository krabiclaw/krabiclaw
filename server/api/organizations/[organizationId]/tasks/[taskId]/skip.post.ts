import { defineHandler, HTTPError } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { closeTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

// A note and photos arrive as a form, photos as `photos` parts in order; a note alone may be JSON.
export default defineHandler(async (event) => {
  const { db, env, viewer } = await taskRouteContext(event)
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  const form = multipart ? await event.req.formData() : null
  const body = form ? null : await readStrictBody<{ note?: unknown }>(event, { note: 'nullable-string' })
  const photos = form
    ? await Promise.all(form.getAll('photos').map(async (part) => {
        if (!(part instanceof File)) throw new HTTPError({ statusCode: 422, statusMessage: 'Each photos part must be a file', data: { code: 'INVALID_PHOTO', field: 'photos' } })
        return { bytes: new Uint8Array(await part.arrayBuffer()), filename: part.name || 'photo' }
      }))
    : []
  const note = form ? form.get('note') ?? undefined : body!.note
  return jsonResponse({ task: await closeTask(db, await viewer(), routeId(event, 'taskId'), { status: 'skipped', note, photos, env }) })
})
