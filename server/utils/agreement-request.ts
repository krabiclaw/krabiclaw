import { HTTPError, type H3Event } from 'nitro'
import { conversationRequest } from '~/server/utils/conversation-request'
import { assertAssignedBookingAccess, joinedMemberPrincipal } from '~/server/utils/member-access'
import type { AgreementViewer } from '~/server/domain/agreements'

/** A booking conversation's agreement request: the conversation's own access, and whether the viewer may change the booking's document. */
export async function agreementRequest(event: H3Event) {
  const request = await conversationRequest(event)
  const { db, env, user, conversation, role, membership } = request
  if (conversation.kind !== 'booking' || !conversation.booking_id) throw new HTTPError({ statusCode: 404, message: 'This conversation has no booking', data: { code: 'BOOKING_NOT_FOUND', field: 'conversation_id' } })
  const canManage = role === 'member' && membership
    ? await assertAssignedBookingAccess(db, { ...joinedMemberPrincipal(membership, { env, event }), bookingId: conversation.booking_id, action: 'update' }).then(() => true, (error: unknown) => {
        if (error instanceof HTTPError && error.statusCode === 404) return false
        throw error
      })
    : false
  const viewer: AgreementViewer = { userId: user.id, verifiedEmail: user.emailVerified ? user.email : null, canManage }
  return { ...request, viewer, actor: { userId: user.id, name: user.name } }
}

export function requireAgreementManager(viewer: AgreementViewer) {
  if (!viewer.canManage) throw new HTTPError({ statusCode: 403, message: 'Only the business can change this booking’s documents', data: { code: 'FORBIDDEN', field: 'conversation_id' } })
}

export function pdfResponse(bytes: Uint8Array<ArrayBuffer>, fileName: string, download: boolean): Response {
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '-')}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}
