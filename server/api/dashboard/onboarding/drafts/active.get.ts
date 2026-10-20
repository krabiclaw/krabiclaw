// The owner's unfinished draft, so reloading /dashboard/onboarding picks up
// where they left off instead of asking every question again. An abandoned
// draft resumes only the cleanup its owner already requested.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { queryFirst } from '~/server/db'
import { getDraftMedia, parseOnboardingDraftPayload, readActiveOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { defineHandler, HTTPError } from 'nitro'
import { deleteAbandonedDraftTenant } from '~/server/utils/tenant-deletion'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const row = await readActiveOnboardingDraft(db, session.user.id, true)

  if (!row) return jsonResponse({ success: true, draft: null })
  if (row.status === 'abandoned') {
    if (!row.organization_id) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft cleanup has no recorded organization. Its native ownership must be verified.', data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id } })
    const outcome = await deleteAbandonedDraftTenant(env, {
      draftId: row.id,
      updatedAt: row.updated_at, organizationId: row.organization_id,
      subdomain: row.subdomain_candidate, userId: session.user.id,
    })
    if ('refused' in outcome) throw new HTTPError({
      statusCode: outcome.refused === 'not_owner' ? 403 : outcome.refused === 'delete_incomplete' ? 500 : 409,
      statusMessage: outcome.refused === 'organization_is_live' ? 'This site is already live. Delete it from its dashboard instead.' : 'Website draft cleanup is incomplete. Retry discarding this draft.',
      data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id, organization_id: row.organization_id },
    })
    return jsonResponse({ success: true, draft: null })
  }

  const payload = parseOnboardingDraftPayload(row.payload_json)

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
    draft: {
      draftId: row.id,
      updatedAt: row.updated_at,
      draftName: payload.preview.brandName,
      sourceType: row.source_type,
      placeId: payload.source.placeId,
      vertical: payload.preview.vertical,
      details: payload.source.details,
      config: payload.preview.config,
      logoImage: getDraftMedia(payload, 'logo'),
      heroImage: getDraftMedia(payload, 'hero'),
      products: payload.preview.products.map(product => ({
        name: product.name,
        category: product.collection,
        amountMinor: product.price === null ? null : product.price.unit_amount,
      })),
      organizationId: organization?.id ?? null,
      subdomainCandidate: organization?.subdomain ?? row.subdomain_candidate,
      previewToken,
    },
  })
})
