import { HTTPError, type H3Event } from 'nitro'
import { executeBatch, type BatchQuery } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { dashboardSessionUserQuery, getAuthSession, type CloudflareEnv, type DashboardAuthRead } from '~/server/utils/auth'
import { prepareTenantPageEditorSnapshot } from '~/server/utils/content/pages'
import { dashboardOrganizationFrom, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, isOrganizationWideRole, membershipByIdQuery, withViewer } from '~/server/utils/member-access'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { roleMatchesSql, workspaceManagementRoles } from '~/utils/organization-access'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
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

export function prepareTenantPageEditor(variantId: string, env: CloudflareEnv) {
  const plan = prepareTenantPageEditorSnapshot(variantId, {
    sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, workspaceManagementRoles)} THEN ${BATCH_VIEWER.organization} END`,
  }, true)
  return {
    queries: plan.queries,
    async read(rows: D1Result[], organization: DashboardOrganizationRow) {
      if (!isOrganizationWideRole(organization.role)) return null
      const snapshot = plan.read(rows)
      if (!snapshot) return null
      const origin = snapshot.publicPath && organization.public_url
        && organization.status === 'active' && organization.onboarding_status === 'active'
        ? tenantOrganizationOrigin({
          platformDomain: env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
          freeOrganizationDomain: env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '',
          subdomain: organization.subdomain ?? '',
          canonicalDomain: organization.public_url,
        }) : null
      const secret = previewSecretOf(env)
      return {
        page: snapshot.page,
        public_url: origin && snapshot.publicPath ? new URL(snapshot.publicPath, origin).href : null,
        preview_token: secret ? await createPreviewToken(secret, organization.id, Date.now() + PREVIEW_TOKEN_TTL_MS) : null,
      }
    },
  }
}

export async function readTenantPageEditor(event: H3Event, organizationId: string, variantId: string) {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, message: 'Database unavailable' })
  const plan = prepareTenantPageEditor(variantId, env)
  const queries = (membership: BatchQuery) => [membership, ...plan.queries.map(query => withViewer(membership, query))]
  const auth: DashboardAuthRead = {
    queries: token => queries(membershipByIdQuery(organizationId, dashboardSessionUserQuery(token))),
  }
  const session = await getAuthSession(event, env, { document: auth, forwardCookies: true })
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required' })
  const [viewer, ...rows] = auth.results ?? await executeBatch(
    db, queries(membershipByIdQuery(organizationId, session.user.id)), { operation: 'Read the authorized page editor' },
  )
  const organization = dashboardOrganizationFrom(viewer!.results[0])
  if (organization.userId !== session.user.id) throw new Error('Page editor membership does not match the Better Auth session')
  const result = await plan.read(rows, organization)
  if (!result) throw new HTTPError({ statusCode: 404, message: 'Tenant page variant not found' })
  return result
}
