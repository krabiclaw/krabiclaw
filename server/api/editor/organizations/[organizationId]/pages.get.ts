import { jsonResponse } from '~/server/utils/api-response'
import { requireTenantPageWriteAccess } from '~/server/utils/tenant-pages-api'
import { listTenantPages, listPageTasks } from '~/server/utils/content/pages'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db } = await requireTenantPageWriteAccess(event, organizationId)
  const locale = getQuery(event).locale
  const opts = { locale: typeof locale === 'string' ? locale : null }
  const [pages, tasks] = await Promise.all([
    listTenantPages(db, organizationId, opts),
    listPageTasks(db, organizationId, opts),
  ])
  return jsonResponse({ pages, tasks })
})
import { defineHandler } from 'nitro';
import { getQuery, getRouterParam  } from 'nitro/h3';
