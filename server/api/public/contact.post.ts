import { requestInsertQueries } from '~/server/domain/requests'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { isLegalPracticeSite } from '~/utils/template-registry'
import { executeBatch, queryFirst } from '~/server/db'
import { cleanString, cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { notifyContactSubmitted, raiseSettledFailures } from '~/server/utils/notifications'
import { DEFAULT_EMAIL_DAILY_LIMIT as EMAIL_DAILY_LIMIT, DEFAULT_IP_HOURLY_LIMIT as IP_HOURLY_LIMIT, getClientIp, hashClientIp, hashIdentifier, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { resolveContactSubmissionAssignment } from '~/server/utils/contact-assignment'
import { measurementOutcome, readPageEventId, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { ensureInteractionUser } from '~/server/utils/auth'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguageEntitlement, getPersistedSourceLocale } from '~/server/utils/localization'
import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'

const VALID_SUBJECTS = ['general', 'press', 'partnerships', 'catering', 'careers']

export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | null | undefined
  if (!organizationId) return jsonResponse({ error: 'Unknown tenant' }, { status: 404 })

  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  let body: ApiRecord
  try { body = await readBody(event) } catch {
    return jsonResponse({ error: 'Invalid request body' }, { status: 400 })
  }

  const name    = cleanString(body.name, 100)
  const email   = cleanString(body.email, 200)
  const message = cleanString(body.message, 2000)
  const subject = cleanString(body.subject, 30)
  // Free-text context the KrabiClaw help form and ChowBot escalations attach.
  const topic = cleanString(body.topic, 200)
  const source = cleanString(body.source, 100)
  const routeContext = cleanString(body.route_context, 500)
  const suggestedSummary = cleanString(body.suggested_summary, 1000)
  // Metadata the caller sent but that cannot round-trip is the caller's error,
  // so it is refused. Discarding it silently meant an escalation arrived stripped
  // of the context the agent attached, with nothing anywhere saying so.
  let agentMetadata: ApiValue = null
  if (body.agent_metadata_json !== undefined && body.agent_metadata_json !== null) {
    try {
      agentMetadata = JSON.parse(JSON.stringify(body.agent_metadata_json)) as ApiValue
    } catch {
      return jsonResponse({ error: 'agent_metadata_json must be JSON-serialisable.' }, { status: 400 })
    }
  }
  if (agentMetadata !== null && JSON.stringify(agentMetadata).length > 10_000) return jsonResponse({ error: 'agent_metadata_json is too large.' }, { status: 400 })
  const locationIdInput = cleanString(body.location_id, 100) || cleanString(body.locationId, 100)

  if (!name) return jsonResponse({ error: 'Please enter your name.' }, { status: 400 })
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return jsonResponse({ error: 'Please enter a valid email address.' }, { status: 400 })
  if (message.length < 10)
    return jsonResponse({ error: 'Message must be at least 10 characters.' }, { status: 400 })
  if (subject && !VALID_SUBJECTS.includes(subject))
    return jsonResponse({ error: 'Please choose a valid subject.' }, { status: 400 })

  const organization = await queryFirst<{ id: string; name?: string | null; vertical: string; theme_id?: string | null }>(
    db, 'SELECT id, name, vertical, theme_id FROM organization WHERE id = ? AND status = ? LIMIT 1', [organizationId, 'active'], )
  if (!organization) return jsonResponse({ error: 'Organization not found' }, { status: 404 })
  const sourceLocale = await getPersistedSourceLocale(db, organizationId)
  const locale = body.locale === undefined ? sourceLocale.locale : assertExactCanonicalLocale(body.locale)
  const language = await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  const requiresConsent = isLegalPracticeSite({ themeId: organization.theme_id, vertical: organization.vertical })
  const consentAcknowledged = body.consent === true
  if (requiresConsent && !consentAcknowledged) {
    return jsonResponse({ error: 'Please acknowledge the contact and privacy notice.' }, { status: 400 })
  }

  const assignment = await resolveContactSubmissionAssignment(db, {
    organizationId, locationId: locationIdInput || null, })
  if (assignment.error) return jsonResponse({ error: assignment.error }, { status: 400 })
  const { assignedLocationId } = assignment

  const id = crypto.randomUUID()
  const clientIp = getClientIp(event)
  const ipHash = await hashClientIp(clientIp)

  // Rate limiting (skipped in dev so local work and E2E can submit repeatedly)
  const e2eOverride = env.E2E_ALLOW_DEV_ROUTES === 'true'
  if (!import.meta.dev && !e2eOverride) {
    const hourWindow = Math.floor(Date.now() / 3_600_000)
    const today = new Date().toISOString().split('T')[0]

    const ipOk = await incrementHourlyRateLimit(db, `rate:contact:ip:${ipHash}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)
    if (!ipOk) return jsonResponse({ error: 'Too many requests. Please try again later.' }, { status: 429 })

    const emailHash = await hashIdentifier(email)
    const emailOk = await incrementHourlyRateLimit(db, `rate:contact:email:${emailHash}:${today}`, EMAIL_DAILY_LIMIT, 86_400_000)
    if (!emailOk) return jsonResponse({ error: 'Too many messages from this email. Please try again tomorrow.' }, { status: 429 })
  }

  // The person is the Better Auth user; what they typed stays on the thread as
  // this message's guest snapshot and is never copied onto that user.
  const userId = await ensureInteractionUser(event, env)
  const consentAt = consentAcknowledged ? new Date().toISOString() : null
  const now = new Date().toISOString()
  await executeBatch(db, requestInsertQueries({ id, kind: 'contact', organization_id: organization.id, location_id: assignedLocationId,
    user_id: userId, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
    payload: { guest: { name, email, phone: null, locale: language.locale }, subject: subject || topic || null, message, consent_at: consentAt, ip_hash: ipHash,
      source: source || null, route_context: routeContext || null, suggested_summary: suggestedSummary || null, agent_metadata: agentMetadata }, created_at: now, updated_at: now }))
  await publishGuestInboxThreadEvent(env, db, { threadId: id, type: 'thread.created' })

  // Both are attempted before either failure is raised. Telling the owner and
  // recording the conversion are independent of each other, and running them in
  // sequence meant a failed notification silently cost the tenant the conversion
  // record as well.
  const followUps = await Promise.allSettled([
    notifyContactSubmitted(env, db, {
      organizationId: organization.id, locale: language.locale, locationId: assignedLocationId, organizationName: organization.name, vertical: organization.vertical, contactId: id, guestName: name, email, subject: subject || topic || null, message, consentAcknowledged, }),
    // A preview is the host looking at their own site, not a guest's conversion.
    event.context.previewAuthorized === true ? Promise.resolve({ recorded: false, reason: 'preview' }) : recordOrganizationConversionEvent(db, event.req, {
    organizationId: organization.id,
    eventName: 'contact_submit',
    stage: 'submitted',
    surface: 'website',
    locationId: assignedLocationId,
    entityType: 'request',
    entityId: id,
    pageType: 'contact',
    routePath: '/contact',
        originEventId: readPageEventId(body.page_event_id),
    }),
  ])
  // Only the owner notification can fail the request. Measurement is reported beside the
  // committed result: a guest told a confirmed submission failed would submit again.
  raiseSettledFailures('contact submission follow-up', `contactId ${id}`, followUps.slice(0, 1),
    ['notifyContactSubmitted'])
  const measurement = measurementOutcome(followUps[1]!)

  return jsonResponse({
    success: true, measurement, message: 'Your message has been sent. We will be in touch soon.', }, { status: 201 })
})
