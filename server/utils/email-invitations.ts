import { APIError } from 'better-auth'
import { HTTPError } from 'nitro'
import { queryFirst, type DbClient } from '~/server/db'

// Better Auth email invitations, as the person they name sees them before
// signing in. The invitation id is the capability: it reaches only the address
// the invitation was sent to.

type InvitationRow = { email: string; role: string | null; status: string; expires_at: number; organization_name: string }

function refuse(statusCode: number, code: string, message: string): never {
  throw new HTTPError({ statusCode, message, data: { code, field: 'invitationId' } })
}

/**
 * Who an invitation is for, which workspace and role, and when it expires.
 * An unknown one is 404; one already answered, withdrawn or expired is 410,
 * each with its code.
 */
export async function describeEmailInvitation(db: DbClient, invitationId: string): Promise<{ email: string; organization: { name: string }; role: string; expiresAt: string }> {
  const invitation = await queryFirst<InvitationRow>(db, `
    SELECT i.email, i.role, i.status, i."expiresAt" AS expires_at, o.name AS organization_name
    FROM invitation i JOIN organization o ON o.id = i."organizationId"
    WHERE i.id = ?`, [invitationId])
  if (!invitation) refuse(404, 'INVITATION_NOT_FOUND', 'This invitation does not exist')
  if (invitation.status === 'accepted') refuse(410, 'INVITATION_ACCEPTED', 'This invitation has already been accepted')
  if (invitation.status === 'rejected') refuse(410, 'INVITATION_REJECTED', 'This invitation was declined')
  if (invitation.status === 'canceled') refuse(410, 'INVITATION_CANCELED', 'This invitation was withdrawn')
  if (invitation.status !== 'pending') throw new Error(`Invitation ${invitationId} has unknown status ${invitation.status}`)
  if (invitation.expires_at * 1000 <= Date.now()) refuse(410, 'INVITATION_EXPIRED', 'This invitation has expired')
  if (!invitation.role) throw new Error(`Invitation ${invitationId} has no role`)
  return {
    email: invitation.email,
    organization: { name: invitation.organization_name },
    role: invitation.role,
    expiresAt: new Date(invitation.expires_at * 1000).toISOString(),
  }
}

/**
 * Someone invited by email answers the invitation before starting a business
 * of their own, so a person invited to join one cannot set up a second, empty
 * one by mistake.
 */
export async function assertNoPendingInvitation(db: DbClient, email: string): Promise<void> {
  const pending = await queryFirst<{ organization_name: string }>(db, `
    SELECT o.name AS organization_name
    FROM invitation i JOIN organization o ON o.id = i."organizationId"
    WHERE lower(i.email) = lower(?) AND i.status = 'pending' AND i."expiresAt" > unixepoch()
    ORDER BY i."createdAt" DESC LIMIT 1`, [email])
  if (pending) {
    throw new APIError('FORBIDDEN', {
      code: 'PENDING_INVITATION',
      message: `You have been invited to join ${pending.organization_name}. Accept or decline that invitation from the email it came in before creating a business.`,
    })
  }
}
