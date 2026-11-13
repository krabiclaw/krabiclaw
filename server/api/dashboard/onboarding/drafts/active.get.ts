// The owner's unfinished draft, so reloading /dashboard/onboarding picks up
// where they left off instead of asking every question again. An abandoned
// draft resumes only the cleanup its owner already requested.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { queryFirst } from '~/server/db'
import { getDraftMedia, parseStoredOnboardingDraftPayload, readActiveOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { defineHandler, HTTPError } from 'nitro'
import { deleteAbandonedDraftTenant } from '~/server/utils/tenant-deletion'

const noDraft = { success: true, draft: null, resume_action: null }

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const row = await readActiveOnboardingDraft(db, session.user.id, true)

  if (!row) return jsonResponse(noDraft)
  if (row.status === 'abandoned') {
    if (!row.organization_id || !row.subdomain_candidate) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft cleanup has no recorded organization or address. Its native ownership must be verified.', data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id } })
    const outcome = await deleteAbandonedDraftTenant(env, {
      draftId: row.id,
      updated_at: row.updated_at, organizationId: row.organization_id,
      subdomain: row.subdomain_candidate, userId: session.user.id,
    })
    if ('refused' in outcome) throw new HTTPError({
      statusCode: outcome.refused === 'not_owner' ? 403 : outcome.refused === 'delete_incomplete' ? 500 : 409,
      statusMessage: outcome.refused === 'organization_is_live' ? 'This site is already live. Delete it from its dashboard instead.' : 'Website draft cleanup is incomplete. Retry discarding this draft.',
      data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id, organization_id: row.organization_id },
    })
    return jsonResponse(noDraft)
  }

  const payload = parseStoredOnboardingDraftPayload(row.payload_json)

  const organization = row.organization_id && row.subdomain_candidate
    ? await queryFirst<{ id: string; subdomain: string | null }>(db, `
        SELECT id, subdomain FROM organization
        WHERE id = ? AND subdomain = ? AND onboarding_status = 'pending'
        LIMIT 1
      `, [row.organization_id, row.subdomain_candidate])
    : null

  // A draft older than the token's lifetime is still resumable; the token is
  // minted fresh on every read rather than stored with the draft.
  const previewSecret = previewSecretOf(env)
  const previewToken = organization?.subdomain && previewSecret
    ? await createPreviewToken(previewSecret, organization.id, Date.now() + PREVIEW_TOKEN_TTL_MS)
    : null

  return jsonResponse({
    success: true,
    resume_action: { label: 'Continue website setup', to: '/dashboard/onboarding' },
    draft: {
      draft_id: row.id,
      updated_at: row.updated_at,
      name: row.name,
      source_type: row.source_type,
      google_place_id: payload.source.placeId,
      vertical: row.vertical,
      details: payload.source.details,
      timezone_step_visited: payload.timezone_step_visited ?? false,
      paused_step: payload.partial ? payload.paused_step ?? null : null,
      config: payload.preview?.config ?? null,
      logo_image: getDraftMedia(payload, 'logo'),
      hero_image: getDraftMedia(payload, 'hero'),
      products: (payload.preview?.products ?? []).map(product => ({
        name: product.name,
        category: product.collection,
        unit_amount: product.price === null ? null : product.price.unit_amount,
      })),
      organization_id: organization?.id ?? null,
      subdomain_candidate: organization?.subdomain ?? (payload.partial && payload.preview ? payload.subdomain_answer ?? null : row.subdomain_candidate),
      preview_token: previewToken,
    },
  })
})
