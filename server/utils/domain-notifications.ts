import { domainUpdateMessage } from '~/server/notifications/events'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { notifyOwner } from '~/server/utils/notifications'
import { domainInstructions } from '~/server/utils/domain-read-model'
import type { DomainRecord } from '~/server/utils/domains'

interface DomainNotificationEnv extends CloudflareEnv {
  PLATFORM_OWNER_EMAILS?: string
}

interface DomainNotificationInput {
  organizationId: string
  event: 'added' | 'synced' | 'deleted'
  domain: DomainRecord
  dashboardUrl: string
}

/** The KrabiClaw operator addresses operational mail is copied to. */
export function platformOperatorEmails(env: { PLATFORM_OWNER_EMAILS?: string }): string[] {
  return String(env.PLATFORM_OWNER_EMAILS || '')
    .split(',')
    .map(email => email.trim())
    .filter(Boolean)
}

function safeDashboardUrl(raw: string): string {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Unsupported dashboard URL protocol')
  }
  return parsed.toString()
}

/**
 * A domain lifecycle change, told as an owner alert: every member who wants
 * organization-and-billing messages hears on each channel they chose, and the
 * platform operator addresses are copied by email. Every send is a recorded
 * delivery on the audit row that says the owner was told.
 */
export async function notifyDomainLifecycle(
  env: DomainNotificationEnv,
  db: DbClient,
  opts: DomainNotificationInput,
) {
  const dashboardUrl = safeDashboardUrl(opts.dashboardUrl)
  const status = opts.event === 'deleted' ? 'deleted' : opts.domain.status
  const instructions = domainInstructions(opts.domain)
  const message = domainUpdateMessage({
    event: opts.event, domain: opts.domain.domain, status, error: opts.domain.error_message?.trim() || null,
    records: instructions.records, apexNote: instructions.apex_note, dashboardUrl,
  })
  await notifyOwner(env, db, {
    organizationId: opts.organizationId,
    template: 'domain_update',
    title: message.title,
    payload: { deep_link: dashboardUrl },
    message,
    whatsappTemplate: 'domain_update',
    // One alert per domain, change and state: the same state told again sends nothing.
    idempotencyKey: `domain:${opts.domain.id}:${opts.event}:${status}:${opts.domain.updated_at}`,
    entity: { type: 'domain', id: opts.domain.id },
    operatorEmails: platformOperatorEmails(env),
  })
}
