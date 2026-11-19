import { HTTPError, type H3Event } from 'nitro'
import type { BatchQuery } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { prepareTenantPageEditorSnapshot } from '~/server/utils/content/pages'
import { readDashboardMemberResources, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, isOrganizationWideRole } from '~/server/utils/member-access'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { roleMatchesSql, workspaceManagementRoles } from '~/utils/organization-access'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'

export const websiteEditorOrganization = {
  sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, workspaceManagementRoles)} THEN ${BATCH_VIEWER.organization} END`,
}

export function prepareTenantPageEditor(variantId: string) {
  const plan = prepareTenantPageEditorSnapshot(variantId, websiteEditorOrganization, true)
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

export async function requireWebsiteAccess(event: H3Event, organizationId: string, statements: BatchQuery[] = []) {
  const context = await readDashboardMemberResources(event, organizationId, statements)
  if (!isOrganizationWideRole(context.organization.role)) throw new HTTPError({ statusCode: 404, message: 'Not found or access denied' })
  return context
}

export async function readTenantPageEditor(event: H3Event, organizationId: string, variantId: string) {
  const plan = prepareTenantPageEditor(variantId)
  const { rows, organization, env } = await requireWebsiteAccess(event, organizationId, plan.queries)
  const result = await plan.read(rows, organization, env)
  if (!result) throw new HTTPError({ statusCode: 404, message: 'Tenant page variant not found' })
  return result
}

export async function readTenantPageUpdate(event: H3Event, organizationId: string, variantId: string) {
  const plan = prepareTenantPageEditorSnapshot(variantId, websiteEditorOrganization)
  const context = await requireWebsiteAccess(event, organizationId, plan.queries)
  const snapshot = plan.read(context.rows)
  if (!snapshot) throw new HTTPError({ statusCode: 404, message: 'Tenant page variant not found' })
  return { ...context, snapshot }
}
