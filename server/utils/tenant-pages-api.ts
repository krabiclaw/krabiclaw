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

const managedOrganization = {
  sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, workspaceManagementRoles)} THEN ${BATCH_VIEWER.organization} END`,
}

export function prepareTenantPageEditor(variantId: string) {
  const plan = prepareTenantPageEditorSnapshot(variantId, managedOrganization, true)
  return {
    queries: plan.queries,
    async read(rows: D1Result[], organization: DashboardOrganizationRow, env: CloudflareEnv) {
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

export async function requireTenantPageWriteAccess(event: H3Event, organizationId: string, statements: BatchQuery[] = []) {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, message: 'Database unavailable' })
  const queries = (membership: BatchQuery) => [membership, ...statements.map(query => withViewer(membership, query))]
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
  if (!isOrganizationWideRole(organization.role)) throw new HTTPError({ statusCode: 404, message: 'Not found or access denied' })
  return { env, db, organization, userId: session.user.id, rows }
}

export async function readTenantPageEditor(event: H3Event, organizationId: string, variantId: string) {
  const plan = prepareTenantPageEditor(variantId)
  const { rows, organization, env } = await requireTenantPageWriteAccess(event, organizationId, plan.queries)
  const result = await plan.read(rows, organization, env)
  if (!result) throw new HTTPError({ statusCode: 404, message: 'Tenant page variant not found' })
  return result
}

export async function readTenantPageUpdate(event: H3Event, organizationId: string, variantId: string) {
  const plan = prepareTenantPageEditorSnapshot(variantId, managedOrganization)
  const context = await requireTenantPageWriteAccess(event, organizationId, plan.queries)
  const snapshot = plan.read(context.rows)
  if (!snapshot) throw new HTTPError({ statusCode: 404, message: 'Tenant page variant not found' })
  return { ...context, snapshot }
}
