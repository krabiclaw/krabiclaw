import { HTTPError, type H3Event } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { closeTask, getTask, taskViewer } from '~/server/domain/tasks'
import { MAX_MESSAGE_PHOTOS, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'

/** The organization a task route names, and the caller as its domain reads them. */
export async function taskRouteContext(event: H3Event) {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organization_id is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'organization_id' } })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  return { db, env, principal, viewer: () => taskViewer(principal) }
}

export function routeId(event: H3Event, name: 'task_id'): string {
  const id = getRouterParam(event, name)
  if (!id) throw new HTTPError({ statusCode: 400, message: `${name} is required`, data: { code: 'ID_REQUIRED', field: name } })
  return id
}

export async function taskReadResponse(event: H3Event) {
  const { db, viewer } = await taskRouteContext(event)
  return jsonResponse({ task: await getTask(db, await viewer(), routeId(event, 'task_id')) }, { headers: { 'cache-control': 'private, no-store' } })
}

export async function taskCloseResponse(event: H3Event, status: 'done' | 'skipped') {
  const { db, env, viewer } = await taskRouteContext(event)
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  let note: unknown
  let photos: MessagePhoto[] = []
  if (multipart) {
    const form = await event.req.formData()
    if ([...form.keys()].some(key => key !== 'note' && key !== 'photos') || form.getAll('note').length > 1) {
      throw new HTTPError({ statusCode: 400, message: 'Send one note and its photos', data: { code: 'INVALID_BODY', field: 'body' } })
    }
    const files = form.getAll('photos')
    if (files.length > MAX_MESSAGE_PHOTOS || files.some(file => !(file instanceof File) || file.size > MAX_IMAGE_BYTES)) {
      throw new HTTPError({ statusCode: 422, message: 'Each photo must be a file of at most 10 MB. Send no more than ten photos.', data: { code: 'INVALID_PHOTO', field: 'photos' } })
    }
    photos = await Promise.all((files as File[]).map(async file => ({ bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name })))
    note = form.get('note')
  } else {
    const body = await readStrictBody<{ note?: string | null }>(event, { note: 'nullable-string' })
    note = body.note
  }
  return jsonResponse({ task: await closeTask(db, await viewer(), routeId(event, 'task_id'), { status, env, note, photos }) })
}
