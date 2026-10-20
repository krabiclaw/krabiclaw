import { defineHandler } from 'nitro'
import { getRouterParam, readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { activateOnboardingDraft } from '~/server/utils/onboarding-apply'
import { activateSessionOrganization } from '~/server/utils/session-organization'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })
  const draftId = getRouterParam(event, 'draftId')
  if (!draftId) return jsonResponse({ error: 'Draft id is required' }, { status: 400 })
  const body = await readBody(event) as { expectedUpdatedAt?: unknown }
  if (typeof body?.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) return jsonResponse({ error: 'Saved draft revision is required' }, { status: 400 })
  const result = await activateOnboardingDraft(env, env.DB, {
    userId: session.user.id,
    draftId,
    expectedUpdatedAt: body.expectedUpdatedAt,
    origin: event.req,
    activateSession: organizationId => activateSessionOrganization(event, env, organizationId),
  })
  return jsonResponse({ success: true, ...result })
})
