import { getGuestRequest } from '~/server/domain/requests'
import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'

// Canonical guest-thread operation endpoint (issue #442 Locked Decision #8). Every
// state-mutating guest-thread action — confirm/cancel/complete/resolve/reopen/reply —
// flows through here. The inbox must never call source-specific editor endpoints
// directly.
import { jsonResponse } from '~/server/utils/api-response'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { assertAssignedBookingAccess, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { getGuestThreadDetail } from '~/server/domain/guest-threads/detail'
import { executeGuestThreadOperation, GUEST_THREAD_ACTIONS } from '~/server/domain/guest-threads/operations'
import { publishDashboardInvalidation } from '~/server/cloudflare/guest-inbox-events'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const threadId = getRouterParam(event, 'threadId')
  const action = getRouterParam(event, 'action')
  if (!organizationId || !threadId || !action) return jsonResponse({ error: 'Missing params', code: 'VALIDATION_ERROR', field: 'params' }, { status: 400 })
  if (!GUEST_THREAD_ACTIONS.has(action)) return jsonResponse({ error: `Unknown action "${action}"`, code: 'UNKNOWN_ACTION', field: 'action' }, { status: 400 })

  const { env, db, session, organization } = await requireOrganizationMembership(event, organizationId)

  const thread = await getGuestRequest(db, threadId, organizationId)
  if (!thread) return jsonResponse({ error: 'Thread not found', code: 'THREAD_NOT_FOUND', field: 'threadId' }, { status: 404 })
  await assertAssignedBookingAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), requestId: thread.id })

  // A reply with photos arrives as a form, its photos as `photos` parts in the
  // order they were chosen; every other operation is JSON.
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  const form = multipart ? await event.req.formData() : null
  const body = form ? null : await readBody<unknown>(event)
  const field = (name: string) => {
    const value = form ? form.get(name) : body && typeof body === 'object' && name in body ? Reflect.get(body, name) : undefined
    return typeof value === 'string' ? value : undefined
  }
  const photos = form
    ? await Promise.all(form.getAll('photos').filter((part): part is File => part instanceof File)
        .map(async part => ({ bytes: new Uint8Array(await part.arrayBuffer()), filename: part.name || 'photo' })))
    : []
  const headerKey = (event.req.headers.get('idempotency-key')) || (event.req.headers.get('x-idempotency-key'))
  const idempotencyKey = field('idempotencyKey') || headerKey || undefined

  if (!idempotencyKey) {
    return jsonResponse({ error: 'Idempotency key is required', code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotencyKey' }, { status: 400 })
  }

  const outcome = await executeGuestThreadOperation(db, {
    threadId,
    organizationId,
    action,
    actorUserId: session.user.id,
    financialWritesAllowed: await roleAllows({ ...organization.membership, permissions: { payments: ['refund'] } }),
    body: field('body'),
    reason: field('reason'),
    photos,
    idempotencyKey,
    env,
  })

  if (outcome.ok || outcome.reason === 'delivery_failed') {
    const changedThread = outcome.ok ? outcome.thread : thread
    const invalidations = [
      publishDashboardInvalidation(env, {
        eventId: crypto.randomUUID(),
        type: 'thread.changed',
        organizationId: changedThread.organization_id,
        locationId: changedThread.location_id,
        threadId: changedThread.id,
        occurredAt: new Date().toISOString(),
      }),
    ]
    if (['reply', 'confirm', 'reject', 'cancel', 'complete'].includes(action)) {
      invalidations.push(publishDashboardInvalidation(env, {
        eventId: crypto.randomUUID(),
        type: 'delivery.changed',
        organizationId: changedThread.organization_id,
        locationId: changedThread.location_id,
        threadId: changedThread.id,
        occurredAt: new Date().toISOString(),
      }))
    }
    // The change is not done until the open inboxes have been told about it.
    await Promise.all(invalidations)
  }

  if (outcome.ok === false) {
    if (outcome.reason === 'thread_not_found' || outcome.reason === 'source_not_found') {
      return jsonResponse({ error: 'Thread not found', code: 'THREAD_NOT_FOUND', field: 'threadId' }, { status: 404 })
    }
    if (outcome.reason === 'invalid_transition') {
      return jsonResponse({ error: outcome.message, code: 'INVALID_TRANSITION', field: 'action' }, { status: 409 })
    }
    if (outcome.reason === 'no_guest_email') {
      return jsonResponse({ error: 'This guest has no email on file', code: 'NO_GUEST_EMAIL', field: 'guest.email' }, { status: 400 })
    }
    if (outcome.reason === 'guest_invite_required') {
      return jsonResponse({ error: outcome.message, code: outcome.code, field: outcome.field }, { status: outcome.status })
    }
    if (outcome.reason === 'empty_body') {
      return jsonResponse({ error: 'Write a message or add a photo', code: 'EMPTY_MESSAGE', field: 'body' }, { status: 400 })
    }
    if (outcome.reason === 'invalid_photo') {
      return jsonResponse({ error: outcome.message, code: 'INVALID_PHOTO', field: 'photos' }, { status: 400 })
    }
    if (outcome.reason === 'missing_idempotency_key') {
      return jsonResponse({ error: 'Idempotency key is required', code: 'MISSING_IDEMPOTENCY_KEY', field: 'idempotencyKey' }, { status: 400 })
    }
    if (outcome.reason === 'delivery_failed') {
      return jsonResponse({ ...outcome, error: outcome.message }, { status: outcome.status })
    }
    throw new HTTPError({ statusCode: 500, message: 'Guest-thread operation returned an unhandled outcome', data: { code: 'INVALID_OPERATION_OUTCOME', field: 'outcome.reason' } })
  }

  const detail = await getGuestThreadDetail(db, threadId, organizationId)
  return jsonResponse({ thread: detail, availableActions: outcome.availableActions }, { status: outcome.status })
})
