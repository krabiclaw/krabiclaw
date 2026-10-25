import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { createPost } from '~/server/utils/post-management'
import { PostValidationError } from '~/shared/posts'
import { assertResourceAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { loadMemberOrganizationRow } from '~/server/utils/location-access'

/** The dashboard's create: the same draft, the same idempotency, as create_post. */
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organizationId')
  if (!organizationId) return jsonResponse({ error: 'Organization ID required' }, { status: 400 })

  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const { idempotency_key: idempotencyKey, ...fields } = await readStrictBody<Record<string, unknown> & { idempotency_key: string }>(event, {
    idempotency_key: 'string', title: 'unknown', body: 'unknown', slug: 'unknown', media: 'unknown',
    location_id: 'unknown', visibility: 'unknown', call_to_action: 'unknown',
  })

  const organization = await loadMemberOrganizationRow(event, db, env, organizationId, session.user.id)
  if (!organization) return jsonResponse({ error: 'Organization not found or access denied' }, { status: 404 })

  const targetLocationId = typeof fields.location_id === 'string' && fields.location_id ? fields.location_id : null
  await assertResourceAccess(db, { ...memberAccessPrincipal(organization.membership, { env, event }), resourceLocationId: targetLocationId })

  try {
    const { post, replayed } = await createPost(db, env, organization.id, { post: fields, idempotencyKey }, session.user.id)
    return jsonResponse({ success: true, post, replayed }, { status: replayed ? 200 : 201 })
  } catch (error) {
    if (error instanceof PostValidationError) return jsonResponse({ error: error.message, ...(error.data ? { data: error.data } : {}) }, { status: error.statusCode })
    throw error
  }
})
