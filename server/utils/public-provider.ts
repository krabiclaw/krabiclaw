import { HTTPError } from 'nitro'
import { sessionMemberSql } from './provider-allocation'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { PUBLISHED_PROFILE_SQL, type PublicProvider } from '~/shared/member-scheduling'

/** The published profile of a host member, when it has one. */
function publishedHostProfiles(db: DbClient, organizationId: string, memberId: string): Promise<PublicProvider[]> {
  return queryAll<PublicProvider>(db, `SELECT ms.public_name name, ms.public_photo_url photo_url, ms.public_bio bio
    FROM member_scheduling ms WHERE ms.organization_id=? AND ${PUBLISHED_PROFILE_SQL} AND ms.member_id=?`,
  [organizationId, memberId])
}

/**
 * Who hosts an offering, as guests see them: the experience or consultation's
 * host, or the stay's "looked after by". With a selected session whose host's
 * hours are the schedule, it is that session's member.
 */
export async function publicProductHosts(db: DbClient, organizationId: string, productId: string, sessionId?: unknown): Promise<PublicProvider[]> {
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) throw new HTTPError({ statusCode: 400, message: 'Session ID must be a nonempty string' })
  const host = await queryFirst<{ member_id: string | null; scheduling_mode: string | null }>(db, `
    SELECT assigned_member_id member_id, scheduling_mode FROM product_booking_configs WHERE product_id=? AND organization_id=?
    UNION ALL SELECT assigned_member_id, NULL FROM product_stay_configs WHERE product_id=? AND organization_id=?`, [productId, organizationId, productId, organizationId])
  if (sessionId !== undefined) {
    const session = await queryFirst<{ member_id: string | null }>(db, `SELECT ${sessionMemberSql('s')} member_id FROM product_sessions s WHERE s.id=? AND s.product_id=? AND s.organization_id=?`, [sessionId, productId, organizationId])
    if (!session) throw new HTTPError({ statusCode: 404, message: 'Session not found for this offering' })
    if (host?.scheduling_mode === 'provider' && session.member_id) return publishedHostProfiles(db, organizationId, session.member_id)
  }
  if (!host?.member_id) return []
  return publishedHostProfiles(db, organizationId, host.member_id)
}

/** A guest-facing offering is published only with a host whose profile guests can see. */
export async function hasPublishedHost(db: DbClient, organizationId: string, host: { assigned_member_id: string | null } | null): Promise<boolean> {
  return Boolean(host?.assigned_member_id && (await publishedHostProfiles(db, organizationId, host.assigned_member_id)).length)
}

export async function assertPublishedHost(db: DbClient, organizationId: string, host: { assigned_member_id: string | null } | null): Promise<void> {
  if (!await hasPublishedHost(db, organizationId, host)) throw new HTTPError({ statusCode: 409, statusMessage: 'Choose a host with a published profile before publishing. Guests see who hosts it.', data: { code: 'HOST_REQUIRED', field: 'host' } })
}
