import { jsonResponse } from '~/server/utils/api-response'
import { requireWebsiteAccess } from '~/server/utils/tenant-pages-api'
import { listTenantPages, pageTasks } from '~/server/utils/content/pages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireWebsiteAccess(event, organizationId)
  const locale = getQuery(event).locale
  const pages = await listTenantPages(db, organizationId, { locale: typeof locale === 'string' ? locale : null })
  return jsonResponse({ pages, tasks: pageTasks(pages) })
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
