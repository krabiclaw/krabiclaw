import type { H3Event } from 'nitro'
import { requestInsertQueries, getGuestRequest } from '~/server/domain/requests'
import { acceptFormAnswers, readFormQuestions } from '~/server/domain/form-questions'
import { publishGuestInboxThreadEvent } from '~/server/cloudflare/guest-inbox-events'
import { isLegalPracticeSite } from '~/utils/site-routing'
import { execute, executeBatch, queryFirst, type DbClient } from '~/server/db'
import { cleanString, cloudflareEnv } from '~/server/utils/api-response'
import { notifyContactSubmitted, raiseSettledFailures } from '~/server/utils/notifications'
import { DEFAULT_EMAIL_DAILY_LIMIT as EMAIL_DAILY_LIMIT, DEFAULT_IP_HOURLY_LIMIT as IP_HOURLY_LIMIT, getClientIp, hashClientIp, hashIdentifier, incrementHourlyRateLimit } from '~/server/utils/hourly-rate-limit'
import { resolveContactSubmissionAssignment } from '~/server/utils/contact-assignment'
import { measurementOutcome, readPageEventId, recordOrganizationConversionEvent } from '~/server/utils/organization-conversions'
import { ensureInteractionUser, type CloudflareEnv } from '~/server/utils/auth'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguage, getPersistedSourceLocale } from '~/server/utils/localization'
import { formAnswersFingerprint } from '~/shared/form-questions'
import { toE164 } from '~/utils/phone'

const VALID_SUBJECTS = ['general', 'press', 'partnerships', 'catering', 'careers']

/** The authenticated business operation that recorded an inquiry on a visitor's behalf. */
export interface InquiryOperator {
  userId: string
  idempotencyKey: string
  source: string
}

type InquiryResult = { status: number; body: Record<string, unknown> }
const result = (body: Record<string, unknown>, status: number): InquiryResult => ({ body, status })

/** The public path a form says it was submitted from: a site path, never a URL to somewhere else. */
function readPagePath(value: unknown): string | null {
  const path = cleanString(value, 500)
  return path.startsWith('/') && !path.startsWith('//') ? path : null
}

/** The owner's alert and the visitor's receipt for a committed inquiry, read from the thread as saved. */
async function notifyInquiry(env: CloudflareEnv, db: DbClient, organization: { id: string; name: string | null; vertical: string }, threadId: string) {
  const thread = await getGuestRequest(db, threadId, organization.id, 'contact')
  if (!thread || thread.kind !== 'contact') throw new Error('Inquiry delivery requires its saved thread')
  await notifyContactSubmitted(env, db, {
    organizationId: organization.id, locale: thread.payload.guest.locale, locationId: thread.location_id, organizationName: organization.name, vertical: organization.vertical,
    contactId: threadId, guestName: thread.payload.guest.name, email: thread.payload.guest.email, phone: thread.payload.guest.phone,
    subject: thread.payload.subject, message: thread.payload.message, answers: thread.payload.answers, consentAcknowledged: thread.payload.consent_at !== null,
  })
  await execute(db, `UPDATE requests SET payload_json = json_set(payload_json, '$.submission.followups_completed', json('true')) WHERE id = ? AND organization_id = ? AND json_type(payload_json, '$.submission') = 'object'`, [threadId, organization.id])
}

/**
 * Record an inquiry — a contact message, a quote request, a lead — in the
 * explicitly selected organization's inbox. The website's contact endpoint and
 * the MCP tool both call this, so they share one set of rules: the shared
 * contact details, the organization's own inquiry questions, the legal
 * practice consent where it applies, and replay of a keyed submission.
 *
 * Without inquiry questions a message is what the visitor has to say. With
 * them, the answers are the substance and a message is optional.
 */
export async function createInquiry(event: H3Event, input: { organizationId: string; body: Record<string, unknown>; operator?: InquiryOperator }): Promise<InquiryResult> {
  const { organizationId, body, operator } = input
  const env = cloudflareEnv(event)
  const db = env.db
  if (!db) return result({ error: 'Database not available' }, 500)

  const name = cleanString(body.name, 100)
  const email = cleanString(body.email, 200)
  const enteredPhone = cleanString(body.phone, 30)
  const phone = enteredPhone ? toE164(enteredPhone) : null
  const message = cleanString(body.message, 2000)
  const subject = cleanString(body.subject, 30)
  // Free-text context the KrabiClaw help form and ChowBot escalations attach.
  const topic = cleanString(body.topic, 200)
  const source = operator?.source ?? cleanString(body.source, 100)
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
      return result({ error: 'agent_metadata_json must be JSON-serialisable.' }, 400)
    }
  }
  if (agentMetadata !== null && JSON.stringify(agentMetadata).length > 10_000) return result({ error: 'agent_metadata_json is too large.' }, 400)
  const locationIdInput = cleanString(body.location_id, 100) || cleanString(body.locationId, 100)

  if (!name) return result({ error: 'Please enter your name.', code: 'NAME_REQUIRED', field: 'name' }, 400)
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return result({ error: 'Please enter a valid email address.', code: 'EMAIL_INVALID', field: 'email' }, 400)
  if (enteredPhone && !phone) return result({ error: 'Please enter a valid phone number.', code: 'PHONE_INVALID', field: 'phone' }, 400)
  if (subject && !VALID_SUBJECTS.includes(subject)) return result({ error: 'Please choose a valid subject.', code: 'SUBJECT_INVALID', field: 'subject' }, 400)

  const organization = await queryFirst<{ id: string; name: string | null; vertical: string; theme_id: string | null }>(db, 'SELECT id, name, vertical, theme_id FROM organization WHERE id = ? AND status = ? LIMIT 1', [organizationId, 'active'])
  if (!organization) return result({ error: 'Organization not found' }, 404)
  const sourceLocale = await getPersistedSourceLocale(db, organizationId)
  const locale = body.locale === undefined ? sourceLocale.locale : assertExactCanonicalLocale(body.locale)
  const language = await assertPublicOrganizationLanguage(db, organizationId, locale)

  const requiresConsent = isLegalPracticeSite({ themeId: organization.theme_id, vertical: organization.vertical })
  const consentAcknowledged = body.consent === true
  if (requiresConsent && !consentAcknowledged) return result({ error: 'Please acknowledge the contact and privacy notice.', code: 'CONSENT_REQUIRED', field: 'consent' }, 400)

  const assignment = await resolveContactSubmissionAssignment(db, { organizationId, locationId: locationIdInput || null })
  if (assignment.error) return result({ error: assignment.error }, 400)
  const { assignedLocationId } = assignment

  // A keyed submission is one inquiry however often it is sent: the website's
  // retry and an MCP caller's repeat each find the thread the first one made.
  const idempotencyKey = operator?.idempotencyKey ?? cleanString(body.idempotency_key, 200)
  const fingerprint = idempotencyKey ? await hashIdentifier(JSON.stringify({ name, email, phone, message, subject: subject || topic || null, answers: formAnswersFingerprint(body.answers), location: assignedLocationId, consent: consentAcknowledged, source: source || null })) : null
  const id = idempotencyKey ? await hashIdentifier(JSON.stringify([operator ? 'inquiry' : 'website-inquiry', organizationId, idempotencyKey])) : crypto.randomUUID()
  const replay = async (): Promise<InquiryResult | null> => {
    if (!idempotencyKey) return null
    const existing = await queryFirst<{ fingerprint: string | null; completed: number | null }>(db, `SELECT json_extract(payload_json, '$.submission.fingerprint') AS fingerprint, json_extract(payload_json, '$.submission.followups_completed') AS completed
      FROM requests WHERE id = ? AND organization_id = ? AND kind = 'contact'`, [id, organizationId])
    if (!existing) return null
    if (existing.fingerprint !== fingerprint) return result({ error: 'This idempotency key belongs to a different inquiry.', code: 'idempotency_conflict', field: 'idempotency_key' }, 409)
    if (!existing.completed) await notifyInquiry(env, db, organization, id)
    // The accepted inquiry answers as it was saved, whatever the questions say now.
    const saved = await getGuestRequest(db, id, organizationId, 'contact')
    if (!saved || saved.kind !== 'contact') throw new Error('Replayed inquiry is missing its thread')
    return result({ success: true, replayed: true, request_id: id, answers: saved.payload.answers, message: 'Your message has been sent. We will be in touch soon.' }, 200)
  }
  const replayed = await replay()
  if (replayed) return replayed

  const questions = await readFormQuestions(db, { kind: 'inquiry', organizationId })
  if (!questions.length && message.length < 10) return result({ error: 'Message must be at least 10 characters.', code: 'MESSAGE_REQUIRED', field: 'message' }, 400)
  const answers = await acceptFormAnswers(db, { kind: 'inquiry', organizationId }, { locale: language.locale, answers: body.answers, questionsRevision: body.questions_revision, revisionRequired: false })

  const ipHash = await hashClientIp(getClientIp(event))
  // Rate limiting (skipped in dev so local work and E2E can submit repeatedly)
  if (!operator && !import.meta.dev && env.E2E_ALLOW_DEV_ROUTES !== 'true') {
    const hourWindow = Math.floor(Date.now() / 3_600_000)
    const today = new Date().toISOString().split('T')[0]
    if (!await incrementHourlyRateLimit(db, `rate:contact:ip:${ipHash}:${hourWindow}`, IP_HOURLY_LIMIT, 3_600_000)) return result({ error: 'Too many requests. Please try again later.' }, 429)
    if (!await incrementHourlyRateLimit(db, `rate:contact:email:${await hashIdentifier(email)}:${today}`, EMAIL_DAILY_LIMIT, 86_400_000)) return result({ error: 'Too many messages from this email. Please try again tomorrow.' }, 429)
  }

  // The person is the Better Auth user; what they typed stays on the thread as
  // this message's guest snapshot and is never copied onto that user.
  const userId = operator ? null : await ensureInteractionUser(event, env)
  const now = new Date().toISOString()
  try {
    await executeBatch(db, requestInsertQueries({ id, kind: 'contact', organization_id: organization.id, location_id: assignedLocationId,
      user_id: userId, review_id: null, conversation_state: 'needs_attention', resolved_at: null,
      payload: { guest: { name, email, phone, locale: language.locale }, subject: subject || topic || null, message, consent_at: consentAcknowledged ? now : null, ip_hash: ipHash,
        source: source || null, route_context: routeContext || null, suggested_summary: suggestedSummary || null, agent_metadata: agentMetadata, answers,
        ...(idempotencyKey && fingerprint ? { submission: { idempotency_key: idempotencyKey, fingerprint, actor_user_id: operator?.userId ?? null, source: source || 'website', followups_completed: false } } : {}) },
      created_at: now, updated_at: now }))
  } catch (error) {
    // The same key committed by a concurrent attempt is that attempt's inquiry.
    const concurrent = await replay()
    if (concurrent) return concurrent
    throw error
  }
  await publishGuestInboxThreadEvent(env, db, { threadId: id, type: 'thread.created' })

  // Both are attempted before either failure is raised. Telling the owner and
  // recording the conversion are independent of each other.
  const followUps = await Promise.allSettled([
    notifyInquiry(env, db, organization, id),
    operator ? Promise.resolve({ recorded: false, reason: 'operator_creation' })
      // A preview is the host looking at their own site, not a guest's conversion.
      : event.context.previewAuthorized === true ? Promise.resolve({ recorded: false, reason: 'preview' })
      : recordOrganizationConversionEvent(db, event.req, {
        organizationId: organization.id, eventName: 'contact_submit', stage: 'submitted', surface: 'website',
        locationId: assignedLocationId, entityType: 'request', entityId: id,
        // The page the form sat on, and which form it was; a verified origin pageview's own page wins.
        pagePath: readPagePath(body.page_path),
        metadata: { form: 'inquiry', questions_revision: typeof body.questions_revision === 'string' ? body.questions_revision : null, answered: answers.length },
        originEventId: readPageEventId(body.page_event_id),
      }),
  ])
  // Only the owner notification can fail the request. Measurement is reported beside the
  // committed result: a guest told a confirmed submission failed would submit again.
  raiseSettledFailures('contact submission follow-up', `contactId ${id}`, followUps.slice(0, 1), ['notifyContactSubmitted'])
  return result({ success: true, replayed: false, request_id: id, answers, measurement: measurementOutcome(followUps[1]!), message: 'Your message has been sent. We will be in touch soon.' }, 201)
}
