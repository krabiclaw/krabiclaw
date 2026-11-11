import type { H3Event } from 'nitro'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export async function requireTenantPageWriteAccess(event: H3Event, organizationId: string) {
  // Site-wide access, asserted once. This used to ask for context access and then
  // for organization-wide access, which is two reads of the same member row for
  // one answer: organization-wide is the stricter of the two — context passes on
  // any of its assigned locations; organization-wide requires an org-wide role —
  // so anything the context check would refuse, this refuses too, with the same
  // 404.
  const { env, db, organization, session } = await requireOrganizationAccess(event, organizationId)
  return { env, db, organization, userId: session.user.id }
}
