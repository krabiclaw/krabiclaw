// DELETE /api/dashboard/onboarding/drafts/active
//
// Abandoning the draft: the owner rewound past the business name, so the
// pending site the first save created is at an address they did not mean to
// claim. Delete it now — nothing was ever public — and close the draft so the
// next save starts a fresh one at the address the new name derives.
//
// Abandonment fences activation before cleanup starts. The saved target stays
// recoverable until native deletion is verified; a failed cleanup never reports
// a completed discard.

import { defineHandler } from 'nitro'

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { execute } from '~/server/db'
import { deleteAbandonedDraftTenant } from '~/server/utils/tenant-deletion'
import { readActiveOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { findOnboardingOrganization } from '~/server/utils/organization-provisioning'
import { resolveOrganizationMembership } from '~/server/utils/member-access'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  const session = await getAuthSession(event, env)
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  const draft = await readActiveOnboardingDraft(db, session.user.id, true)
  if (!draft) return jsonResponse({ success: true, deleted: false })

  const organizationId = draft.organization_id ?? (await findOnboardingOrganization(env, session.user.id, { draftId: draft.id, slug: draft.subdomain_candidate }))?.organizationId ?? null
  if (organizationId && (await resolveOrganizationMembership(env, { organizationId, userId: session.user.id }))?.role !== 'owner') return jsonResponse({ error: 'Only an owner of this organization can discard its draft.' }, { status: 403 })
  const revision = new Date(Math.max(Date.now(), Date.parse(draft.updated_at) + 1)).toISOString()
  const claimed = await execute(db, `
    UPDATE onboarding_drafts SET status = 'abandoned', organization_id = COALESCE(organization_id, ?), updated_at = ?
    WHERE id = ? AND user_id = ? AND status IN ('active', 'abandoned') AND updated_at = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM organization o WHERE o.id = ? AND o.onboarding_status IN ('pending', 'failed') AND NOT EXISTS (SELECT 1 FROM bookings WHERE organization_id = o.id)))
  `, [organizationId, revision, draft.id, session.user.id, draft.updated_at, organizationId, organizationId])
  if (!claimed.meta.changes) return jsonResponse({ error: 'Website draft changed or is already live. Reload before discarding.', code: 'ONBOARDING_DRAFT_CHANGED', draft_id: draft.id }, { status: 409 })

  let deleted = false
  if (organizationId) {
    const outcome = await deleteAbandonedDraftTenant(env, {
      draftId: draft.id,
      updatedAt: revision,
      organizationId,
      subdomain: draft.subdomain_candidate,
      userId: session.user.id,
    })
    if ('refused' in outcome) {
      if (outcome.refused === 'organization_is_live') {
        return jsonResponse({ error: 'This site is already live. Delete it from its dashboard instead.' }, { status: 409 })
      }
      if (outcome.refused === 'not_owner') {
        return jsonResponse({ error: 'Only an owner of this organization can discard its draft.' }, { status: 403 })
      }
      return jsonResponse({ error: 'Website draft cleanup is incomplete. Retry discarding this draft.', code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: draft.id }, { status: outcome.refused === 'draft_changed' ? 409 : 500 })
    }
    deleted = outcome.removed !== 'nothing'
  }

  return jsonResponse({ success: true, deleted })
})
