import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { saveOnboardingDraft } from '~/server/utils/onboarding-apply'
import type { OnboardingDraftInput } from '~/server/utils/onboarding-drafts'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  if (!env.DB) return jsonResponse({ error: 'Database not available' }, { status: 500 })
  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })
  const secret = previewSecretOf(env)
  if (!secret) return jsonResponse({ error: 'Preview secret not configured' }, { status: 503 })
  const input = await readBody(event) as OnboardingDraftInput
  const { row, payload } = await saveOnboardingDraft(env, env.DB, session.user.id, input)
  if (!row.organization_id) throw new Error('Saved website draft has no organization')
  const previewToken = await createPreviewToken(secret, row.organization_id, Date.now() + PREVIEW_TOKEN_TTL_MS)
  return jsonResponse({ success: true, draftId: row.id, updatedAt: row.updated_at, draftName: payload.preview.brandName, organizationId: row.organization_id, subdomainCandidate: row.subdomain_candidate, previewToken })
})
