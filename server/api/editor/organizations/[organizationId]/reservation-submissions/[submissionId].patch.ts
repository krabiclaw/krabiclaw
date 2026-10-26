// PATCH /api/editor/organizations/[organizationId]/reservation-submissions/[submissionId]
//
// Delegates to the same canonical guest-thread operation service the dashboard inbox
// uses (issue #442 Locked Decision #4), so both surfaces share one state-mutation +
// ledger-append path rather than forking editor-specific logic.
import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { assertResourceAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'
import { queryFirst } from '~/server/db'
import { executeGuestThreadOperation } from '~/server/domain/guest-threads/operations'
import { publishDashboardInvalidation } from '~/server/cloudflare/guest-inbox-events'

const STATUS_TO_ACTION = { cancelled: 'cancel' } as const

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  const submissionId = getRouterParam(event, 'submissionId')
  if (!organizationId || !submissionId) return jsonResponse({ error: 'Missing params' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })

  // The table held is its own row: it carries the location and the status this
  // endpoint is about, and the thread carries the conversation.
  const submission = await queryFirst<{ location_id: string; status: string; updated_at: string }>(db, `
    SELECT res.location_id, res.status, r.updated_at
      FROM requests r JOIN reservations res ON res.request_id = r.id
     WHERE r.kind = 'reservation' AND r.id = ? AND r.organization_id = ? LIMIT 1`, [submissionId, organizationId])
  if (!submission) return jsonResponse({ error: 'Reservation not found' }, { status: 404 })

  await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), resourceLocationId: submission.location_id })

  const body = await readBody(event) as { status?: unknown }
  const status = cleanString(body.status, 20)
  const action = Object.hasOwn(STATUS_TO_ACTION, status) ? STATUS_TO_ACTION[status as keyof typeof STATUS_TO_ACTION] : undefined
  if (!action) {
    return jsonResponse({ error: 'Invalid status. Must be cancelled' }, { status: 400 })
  }


  const outcome = await executeGuestThreadOperation(db, {
    threadId: submissionId, organizationId, action, actorUserId: session.user.id, env, idempotencyKey: `editor:reservation:${submissionId}:${submission.status}:${submission.updated_at}:${action}`, })

  if (!outcome.ok) {
    if (outcome.reason === 'thread_not_found' || outcome.reason === 'source_not_found') {
      return jsonResponse({ error: 'Reservation not found' }, { status: 404 })
    }
    if (outcome.reason === 'invalid_transition') {
      return jsonResponse({ error: outcome.message }, { status: 409 })
    }
    return jsonResponse({ error: 'Reservation update failed' }, { status: 400 })
  }

  await publishDashboardInvalidation(env, {
    eventId: crypto.randomUUID(), type: 'thread.changed', organizationId: outcome.thread.organization_id, locationId: outcome.thread.location_id, threadId: outcome.thread.id, occurredAt: new Date().toISOString(), })

  return jsonResponse({ updated: true, submission_id: submissionId, status })
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
