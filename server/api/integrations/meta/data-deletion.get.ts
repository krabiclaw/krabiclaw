import { defineHandler } from 'nitro';
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { verifyJWT } from 'better-auth/crypto'
import { remainingMetaSubjectData } from '~/server/utils/integration-release'
import { META_DELETION_PURPOSE } from '~/server/utils/meta-graph'

/**
 * The status URL Meta requires beside a data-deletion request. The code names
 * the verified app and person, and the answer comes from what the database
 * still holds for them, not from a record of what was claimed.
 */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.BETTER_AUTH_SECRET) return jsonResponse({ error: 'Meta integration is not configured' }, { status: 500 })

  const code = event.url.searchParams.get('code')
  if (!code) return jsonResponse({ error: 'A confirmation code is required' }, { status: 400 })

  const payload = await verifyJWT<{ purpose?: string; channel?: string; providerAppId?: string; providerSubjectId?: string; iat?: number }>(code, env.BETTER_AUTH_SECRET)
  if (!payload || payload.purpose !== META_DELETION_PURPOSE || (payload.channel !== 'facebook' && payload.channel !== 'instagram') || !payload.providerAppId || !payload.providerSubjectId) {
    return jsonResponse({ error: 'Unknown confirmation code' }, { status: 404 })
  }
  const remaining = await remainingMetaSubjectData(env, { channel: payload.channel, providerAppId: payload.providerAppId, providerSubjectId: payload.providerSubjectId })
  return jsonResponse({
    confirmation_code: code,
    status: remaining === 0 ? 'complete' : 'incomplete',
    requested_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    description: remaining === 0
      ? 'The Meta authorization and every record naming it have been deleted.'
      : `${remaining} record(s) from this Meta account remain. Contact support@blawby.com.`,
  })
})
