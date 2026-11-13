import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { saveOnboardingDraft } from '~/server/utils/onboarding-apply'
import type { OnboardingDraftInput } from '~/server/utils/onboarding-drafts'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.DB) throw new HTTPError({ statusCode: 503, message: 'Database not available', data: { code: 'DATABASE_UNAVAILABLE' } })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) throw new HTTPError({ statusCode: 401, message: 'Authentication required', data: { code: 'UNAUTHORIZED' } })
  const input = await readBody(event) as OnboardingDraftInput
  const secret = previewSecretOf(env)
  if (!secret && input?.partial !== true) throw new HTTPError({ statusCode: 503, message: 'Preview secret not configured', data: { code: 'PREVIEW_UNAVAILABLE' } })
  const { row, payload } = await saveOnboardingDraft(env, env.DB, session.user.id, input)
  if (!payload.partial && !row.organization_id) throw new Error('Saved website draft has no organization')
  const previewToken = secret && row.organization_id
    ? await createPreviewToken(secret, row.organization_id, Date.now() + PREVIEW_TOKEN_TTL_MS)
    : null
  return jsonResponse({
    success: true, draft_id: row.id, updated_at: row.updated_at, name: row.name, organization_id: row.organization_id,
    subdomain_candidate: row.organization_id || !payload.partial || !payload.preview ? row.subdomain_candidate : payload.subdomain_answer ?? null,
    preview_token: previewToken,
  })
})
