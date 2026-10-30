import { jsonResponse } from '~/server/utils/api-response'
import { createQa } from '~/server/utils/location-qa'
import { requireOrganizationAccess } from '~/server/utils/location-access'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })
  const { db, organization, session } = await requireOrganizationAccess(event, organizationId)
  const body = await readBody<{
    question?: string
    answer?: string | null
    question_author?: string | null
    is_owner_answer?: boolean
    sort_order?: number
    status?: 'published' | 'hidden'
    page_path?: string | null
  }>(event)
  const result = await createQa(db, {
    organizationId: organization.id, locationId: null, pagePath: body?.page_path ?? null, }, {
    question: body?.question ?? '', answer: body?.answer, question_author: body?.question_author, is_owner_answer: body?.is_owner_answer, sort_order: body?.sort_order, status: body?.status, }, session.user)
  return jsonResponse(result.data, { status: result.status })
})
import { defineHandler } from 'nitro';
import { getRouterParam, readBody  } from 'nitro/h3';
