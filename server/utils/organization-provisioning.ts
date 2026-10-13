import { platformLocale } from '~/shared/platform-locales'
// Turning a bare Better Auth organization into a serving tenant: its address,
// its template, its source locale and its seeded structure. The target
// organization is always an explicit input from the caller — this module never
// picks one from the user's memberships. Handles the same-organization retry,
// subdomain uniqueness, and seeding.
import { seedNewOrganization } from '~/server/utils/organization-seed'
import { createSystemSubdomain, isSystemSubdomainSpent, organizationPublicUrl } from '~/server/utils/domains'
import { executeBatch, queryFirst, type BatchQuery } from '~/server/db'
import { ALL_VERTICALS, type OrganizationVertical } from '~/utils/vertical-copy'
import type { CurrencyCode } from '~/shared/currencies'
import { resolvePublicTemplate } from '~/utils/template-registry'
import { isOrganizationWideRole, organizationAdapter } from '~/server/utils/member-access'
import { createAuth, type CloudflareEnv } from '~/server/utils/auth'
import { measurementOutcome, originatingOwnerId, recordAndDeliverConversion } from '~/server/utils/organization-conversions'
import { getPlatformOrganization } from '~/server/utils/platform-organization'
import { platformOperatorEmails } from '~/server/utils/domain-notifications'
import { getPlatformDomain } from '~/server/utils/dashboard-notification-links'
import { hashEmail, sendEmail } from '~/server/utils/email-delivery'
import { renderNotificationEmail } from '~/server/emails/render'
import { onboardingCompletedMessage } from '~/server/notifications/events'
import { HTTPError } from 'nitro'
import { isAPIError } from 'better-auth/api'
import { ONBOARDING_ORGANIZATION_MARKER, onboardingDraftWriteGuard, type SavedOnboardingDraft } from '~/server/utils/onboarding-drafts'

type SetupEnv = CloudflareEnv & { PLATFORM_OWNER_EMAILS?: string }

interface ExistingSubdomainRow {
  id: string
  onboarding_status: string | null
}

interface CreateOrganizationApi {
  createOrganization(_input: {
    body: {
      name: string
      slug: string
      userId: string
      keepCurrentActiveOrganization: true
      metadata: Record<string, string>
      default_currency: CurrencyCode
      timezone: string
    }
  }): Promise<{ id: string }>
}

// Re-exported for existing callers (endpoint validation, tests) — the
// canonical list itself lives in utils/vertical-copy.ts (ALL_VERTICALS) so a
// third supported vertical only needs one array to update, not a duplicate
// here plus one in every UI vertical picker.
export const VALID_VERTICALS: OrganizationVertical[] = ALL_VERTICALS

export interface OrganizationProvisioningResult {
  status: number
  data: Record<string, unknown>
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function markProvisioningFailed(db: D1Database, organizationId: string, cause: unknown, writeGuard?: BatchQuery): Promise<Error> {
  try {
    await executeBatch(db, [...(writeGuard ? [writeGuard] : []), {
      query: "UPDATE organization SET onboarding_status = 'failed', updated_at = ? WHERE id = ? AND onboarding_status <> 'active'",
      params: [new Date().toISOString(), organizationId],
    }])
  } catch (cleanupError) {
    return new AggregateError(
      [asError(cause), asError(cleanupError)],
      `Organization ${organizationId} setup failed and its failure status could not be persisted`,
    )
  }
  return asError(cause)
}

// Registry-driven: the template (and therefore theme_id) a tenant gets is
// derived from the same publicTemplateRegistry that already drives tenant
// routing/rendering (utils/template-registry.ts) — this is the only place
// provisioning decides a theme_id, so a future third template only needs a new
// registry entry, not a second hardcoded vertical-to-theme switch here.
function resolveThemeId(vertical: OrganizationVertical): string {
  return resolvePublicTemplate({ vertical }).themeId
}

export async function provisionOrganization(
  env: SetupEnv,
  db: D1Database,
  userId: string,
  // The currency and the clock arrive with the organization itself (Better
  // Auth requires both at creation), so provisioning never writes them.
  params: { organizationId: string; name: string; subdomain: string; vertical: OrganizationVertical; sourceLocale: string; activate?: boolean; origin: { headers: Headers } | null; writeGuard?: BatchQuery },
): Promise<OrganizationProvisioningResult> {
  const { organizationId, name, vertical } = params
  const normalizedSubdomain = params.subdomain.toLowerCase()
  const source = platformLocale(params.sourceLocale)
  if (!source) return { status: 400, data: { error: 'Choose a supported website language' } }
  const linkedDraft = params.writeGuard ? null : await queryFirst<SavedOnboardingDraft>(db, "SELECT * FROM onboarding_drafts WHERE organization_id = ? AND status IN ('active', 'committing') LIMIT 1", [organizationId])
  if (linkedDraft && linkedDraft.user_id !== userId) return { status: 403, data: { error: 'Only the draft owner can finish this website setup' } }
  const writeGuard: BatchQuery = params.writeGuard ?? (linkedDraft ? onboardingDraftWriteGuard(linkedDraft, organizationId) : {
    query: "SELECT CASE WHEN EXISTS (SELECT 1 FROM organization o WHERE o.id = ? AND o.onboarding_status IN ('pending', 'failed') AND NOT EXISTS (SELECT 1 FROM onboarding_drafts WHERE organization_id = o.id AND status = 'abandoned')) THEN NULL ELSE json('Organization provisioning is no longer available') END",
    params: [organizationId],
  })

  try {
    await executeBatch(db, [writeGuard])
    const adapter = await organizationAdapter(env)
    const member = await adapter.findMemberByOrgId({ userId, organizationId })
    if (!member || !isOrganizationWideRole(String(member.role))) {
      return { status: 403, data: { error: 'Organization-level access required to provision this organization' } }
    }

    const existingSource = await queryFirst<{ locale: string }>(db, 'SELECT locale FROM organization_locales WHERE organization_id = ? AND is_source = 1', [organizationId])
    if (existingSource && existingSource.locale !== source.locale) return { status: 409, data: { error: 'This organization already has a primary language; existing content cannot be relabelled' } }
    const themeId = resolveThemeId(vertical)
    const now = new Date().toISOString()

    const existingSubdomain = await queryFirst<ExistingSubdomainRow>(db, `
      SELECT id, onboarding_status FROM organization WHERE subdomain = ? LIMIT 1
    `, [normalizedSubdomain])
    if (existingSubdomain) {
      const isRetryable = existingSubdomain.id === organizationId
        && (existingSubdomain.onboarding_status === 'pending' || existingSubdomain.onboarding_status === 'failed')
      if (!isRetryable) {
        return { status: 409, data: { error: 'This subdomain is already taken', code: 'SUBDOMAIN_TAKEN', missing_fields: ['subdomain'] } }
      }
      // Retry: the same subdomain in the same explicit organization is still
      // pending/failed from a previous attempt. It may have been left under a
      // stale default (theme_id='saya-theme-v1', vertical='restaurant') —
      // correct both here so a professional-service retry can never be left on Saya.
      await executeBatch(db, [writeGuard, {
        query: "UPDATE organization SET theme_id = ?, vertical = ?, onboarding_status = 'pending', updated_at = ? WHERE id = ? AND onboarding_status IN ('pending', 'failed')",
        params: [themeId, vertical, now, organizationId],
      }])
      return await performSeeding(env, db, organizationId, name, vertical, normalizedSubdomain, params.activate !== false, params.origin, writeGuard, linkedDraft)
    }
    // The guard above answers "is this subdomain taken", which was the only
    // question while provisioning inserted a `organizations` row: a second run made a
    // second row and the organization was untouched. Provisioning now writes
    // the organization itself, so a run naming a different subdomain rewrites a
    // live tenant's address, status and vertical in place. An organization that
    // already carries one is already provisioned, and re-provisioning it is
    // refused rather than performed.
    const target = await queryFirst<{ subdomain: string | null }>(db, `
      SELECT subdomain FROM organization WHERE id = ? LIMIT 1
    `, [organizationId])
    if (target?.subdomain && target.subdomain !== normalizedSubdomain) {
      return { status: 409, data: { error: 'This organization is already provisioned' } }
    }

    if (await isSystemSubdomainSpent(env, db, normalizedSubdomain)) {
      return { status: 409, data: { error: 'This subdomain is permanently unavailable', code: 'SUBDOMAIN_TAKEN', missing_fields: ['subdomain'] } }
    }
    try {
      await executeBatch(db, [
        writeGuard,
        {
          query: `
            UPDATE organization
               SET theme_id = ?, vertical = ?, subdomain = ?,
                   status = 'active', onboarding_status = 'pending',
                   analytics_data_start_at = COALESCE(analytics_data_start_at, ?), updated_at = ?
             WHERE id = ? AND onboarding_status IN ('pending', 'failed')
          `,
          params: [themeId, vertical, normalizedSubdomain, now, now, organizationId],
        },
        {
          query: `
            INSERT INTO organization_locales
              (id, organization_id, locale, label, is_source, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, 'published', ?, ?)
            ON CONFLICT(organization_id, locale) DO NOTHING
          `,
          params: [`locale::${organizationId}::${source.locale}`, organizationId, source.locale, source.label, now, now],
        },
      ], { operation: 'provision organization and source locale' })
    } catch (provisioningError) {
      const msg = provisioningError instanceof Error ? provisioningError.message : ''
      if (/UNIQUE constraint failed: organization\.subdomain/.test(msg)) {
        return { status: 409, data: { error: 'This subdomain is already taken', code: 'SUBDOMAIN_TAKEN', missing_fields: ['subdomain'] } }
      }
      throw provisioningError
    }

    return await performSeeding(env, db, organizationId, name, vertical, normalizedSubdomain, params.activate !== false, params.origin, writeGuard, linkedDraft)

  } catch (error) {
    const state = await queryFirst<{ onboarding_status: string; abandoned: number }>(db, "SELECT onboarding_status, EXISTS (SELECT 1 FROM onboarding_drafts WHERE organization_id = organization.id AND status = 'abandoned') AS abandoned FROM organization WHERE id = ?", [organizationId])
    if (state?.onboarding_status === 'active' || state?.abandoned) return { status: 409, data: { error: 'Website setup is no longer available for this draft', code: 'ONBOARDING_DRAFT_CHANGED' } }
    console.error('Organization provisioning failed:', asError(error))
    const failure = await markProvisioningFailed(db, organizationId, error, writeGuard)
    return { status: 500, data: { error: failure.message } }
  }
}

/** Makes a pending tenant public. */
export async function activateOrganization(db: D1Database, organizationId: string, writeGuard: BatchQuery, draft?: Pick<SavedOnboardingDraft, 'id' | 'user_id' | 'updated_at'> | null): Promise<void> {
  const now = new Date(Math.max(Date.now(), draft ? Date.parse(draft.updated_at) + 1 : 0)).toISOString()
  const queries: BatchQuery[] = [writeGuard, {
    query: "UPDATE organization SET onboarding_status = 'active', updated_at = ? WHERE id = ? AND onboarding_status = 'pending' AND NOT EXISTS (SELECT 1 FROM onboarding_drafts WHERE organization_id = organization.id AND status = 'abandoned')",
    params: [now, organizationId],
  }, { query: "SELECT CASE WHEN changes() = 1 THEN NULL ELSE json('Website activation is no longer available') END" }]
  if (draft) queries.push({
    query: "UPDATE onboarding_drafts SET status = 'committed', committed_at = COALESCE(committed_at, ?), updated_at = ? WHERE id = ? AND user_id = ? AND organization_id = ? AND status = 'active' AND updated_at = ?",
    params: [now, now, draft.id, draft.user_id, organizationId, draft.updated_at],
  }, { query: "SELECT CASE WHEN changes() = 1 THEN NULL ELSE json('Onboarding draft revision changed') END" })
  await executeBatch(db, queries)
}

/**
 * A new business is live: record the onboarding conversion and email the
 * KrabiClaw operator. Neither waits on or hides the other, and neither fails
 * the activation that already committed; each outcome is reported.
 */
export async function completeOnboarding(env: SetupEnv, db: D1Database, organizationId: string, origin: { headers: Headers } | null) {
  const [measurement, operatorEmail] = await Promise.allSettled([
    recordOnboardingComplete(env, db, organizationId, origin),
    emailOperatorOnboardingComplete(env, db, organizationId),
  ])
  return {
    measurement: measurementOutcome(measurement),
    operator_email: operatorEmail.status === 'fulfilled'
      ? { status: 'sent' as const }
      : { status: 'failed' as const, reason: operatorEmail.reason instanceof Error ? operatorEmail.reason.message : String(operatorEmail.reason) },
  }
}

/** Records completion after the caller has committed its setup work. */
async function recordOnboardingComplete(env: SetupEnv, db: D1Database, organizationId: string, origin: { headers: Headers } | null): Promise<void> {
  // The event is unique per organization, so replaying a completed setup request (or
  // retrying after a failed record) never counts a second onboarding. KrabiClaw
  // activating itself is not an acquisition.
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  if (organizationId === platformOrganizationId) return
  await recordAndDeliverConversion(env, db, origin, {
    organizationId: platformOrganizationId, eventName: 'onboarding_complete', stage: 'completed', surface: 'dashboard',
    entityType: 'organization', entityId: organizationId,
    metadata: { originating_user_id: await originatingOwnerId(db, platformOrganizationId, organizationId) },
  })
}

/**
 * Emails each operator address once per business. Activation runs once per
 * draft; the Resend idempotency key makes a repeated request a no-op too.
 */
async function emailOperatorOnboardingComplete(env: SetupEnv, db: D1Database, organizationId: string): Promise<void> {
  const platformOrganizationId = (await getPlatformOrganization(db)).id
  if (organizationId === platformOrganizationId) return
  // One mailbox is one recipient, however its address is cased.
  const recipients = platformOperatorEmails(env).filter((email, index, all) => all.findIndex(other => hashEmail(other) === hashEmail(email)) === index)
  if (!recipients.length) throw new Error('PLATFORM_OWNER_EMAILS is not configured')

  const ownerId = await originatingOwnerId(db, platformOrganizationId, organizationId)
  if (!ownerId) throw new Error(`Organization ${organizationId} has no owner`)
  const [business, owner, platform, siteUrl] = await Promise.all([
    queryFirst<{ name: string }>(db, 'SELECT name FROM organization WHERE id = ?', [organizationId]),
    queryFirst<{ name: string; email: string }>(db, 'SELECT name, email FROM user WHERE id = ?', [ownerId]),
    queryFirst<{ slug: string }>(db, 'SELECT slug FROM organization WHERE id = ?', [platformOrganizationId]),
    organizationPublicUrl(env, db, organizationId),
  ])
  if (!business || !owner || !platform) throw new Error(`Onboarding email for ${organizationId} is missing its business, owner or platform organization`)
  if (!siteUrl) throw new Error(`Organization ${organizationId} has no active site address`)

  const platformDomain = getPlatformDomain(env)
  const query = new URLSearchParams({ user: ownerId, organization: organizationId })
  const message = onboardingCompletedMessage({
    organizationName: business.name,
    ownerName: owner.name,
    ownerEmail: owner.email,
    siteUrl,
    viewCustomerUrl: `https://${platformDomain}/dashboard/${platform.slug}/platform-accounts?${query}`,
  })
  const email = await renderNotificationEmail(message, { platformDomain })

  const results = await Promise.all(recipients.map(to => sendEmail(env, {
    to, subject: message.title, ...email, idempotencyKey: `onboarding-complete:${organizationId}:${hashEmail(to)}`,
  })))
  const failures = results.flatMap(result => result.status === 'sent' ? [] : [result.error])
  if (failures.length) throw new Error(`Operator onboarding email failed: ${failures.join('; ')}`)
}

// The draft identifies one native organization across interrupted requests.
export async function findOnboardingOrganization(env: CloudflareEnv, userId: string, identity: { draftId: string; slug: string }) {
  const adapter = await organizationAdapter(env)
  const existing = await adapter.findOrganizationBySlug(identity.slug)
  if (!existing || organizationMetadata(existing.metadata)[ONBOARDING_ORGANIZATION_MARKER] !== identity.draftId) return null
  const owner = await adapter.findMemberByOrgId({ userId, organizationId: existing.id })
  if (owner?.role !== 'owner') throw new HTTPError({ statusCode: 409, statusMessage: 'Website organization creation has no verified owner', data: { code: 'ONBOARDING_ORGANIZATION_OWNER_MISSING', draft_id: identity.draftId, organization_id: existing.id } })
  return { organizationId: existing.id }
}

export async function createOrganization(env: CloudflareEnv, userId: string, name: string, identity: { draftId: string; slug: string }, facts: { defaultCurrency: CurrencyCode; timezone: string }) {
  const auth = createAuth(env)
  const organizationApi = auth.api as unknown as CreateOrganizationApi
  const existing = await findOnboardingOrganization(env, userId, identity)
  if (existing) return existing
  try {
    const organization = await organizationApi.createOrganization({
      body: {
        name,
        slug: identity.slug,
        userId,
        keepCurrentActiveOrganization: true,
        metadata: { [ONBOARDING_ORGANIZATION_MARKER]: identity.draftId },
        default_currency: facts.defaultCurrency,
        timezone: facts.timezone,
      },
    })
    const created = await findOnboardingOrganization(env, userId, identity)
    if (!created || created.organizationId !== organization.id) throw new Error('Created organization identity could not be read back')
    return { organizationId: organization.id }
  } catch (error) {
    const nativeCollision = isAPIError(error) && error.body?.code === 'ORGANIZATION_ALREADY_EXISTS'
    const collision = nativeCollision
      || error instanceof Error && /UNIQUE constraint failed: organization\.slug/.test(error.message)
    if (!collision) throw error
    const raced = await findOnboardingOrganization(env, userId, identity)
    if (raced) return raced
    throw new HTTPError({ statusCode: 409, statusMessage: 'This website address is already taken. Choose another address.', data: { code: 'SUBDOMAIN_TAKEN', missing_fields: ['subdomain'], draft_id: identity.draftId }, cause: error })
  }
}

function organizationMetadata(value: unknown): Record<string, unknown> {
  if (isMetadataRecord(value)) return { ...value }
  if (typeof value !== 'string') return {}
  const parsed: unknown = JSON.parse(value)
  if (!isMetadataRecord(parsed)) throw new Error('Stored organization metadata is invalid')
  return { ...parsed }
}

function isMetadataRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function performSeeding(
  env: SetupEnv,
  db: D1Database,
  organizationId: string,
  name: string,
  vertical: OrganizationVertical,
  subdomain: string,
  // Onboarding provisions the tenant before the owner has finished answering,
  // so it stays pending: the address is reserved and the tenant is previewable
  // with its preview token, but it is not public until activateOrganization()
  // is called.
  activate: boolean,
  // The request of the person finishing setup, when there is one: the only
  // source of the consent GA4 delivery of the onboarding outcome must honor.
  origin: { headers: Headers } | null,
  writeGuard: BatchQuery,
  draft: Pick<SavedOnboardingDraft, 'id' | 'user_id' | 'updated_at'> | null,
): Promise<OrganizationProvisioningResult> {
  const locationId = await seedNewOrganization(db, { env: env as CloudflareEnv, organizationId, name, vertical, writeGuard })

  await createSystemSubdomain(env, db, organizationId, subdomain, { writeGuard })

  if (activate) await activateOrganization(db, organizationId, writeGuard, draft)
  const completion = activate ? await completeOnboarding(env, db, organizationId, origin) : undefined

  return {
    status: 200,
    data: {
      organizationId,
      subdomain,
      locationId,
      message: 'Organization provisioned successfully',
      ...completion,
    }
  }
}
