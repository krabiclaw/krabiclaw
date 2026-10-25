import { domainUpdateMessage } from '~/server/notifications/events'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { notifyOwner } from '~/server/utils/notifications'

interface DomainNotificationEnv extends CloudflareEnv {
  PLATFORM_OWNER_EMAILS?: string
}

interface DomainNotificationInput {
  organizationId: string
  domain: string
  status: string
  title: string
  message: string
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
 * delivery on the in-app notification.
 */
export async function notifyDomainLifecycle(
  env: DomainNotificationEnv,
  db: DbClient,
  opts: DomainNotificationInput,
) {
  const dashboardUrl = safeDashboardUrl(opts.dashboardUrl)
  await notifyOwner(env, db, {
    organizationId: opts.organizationId,
    template: 'domain_update',
    title: opts.title,
    payload: { deep_link: dashboardUrl },
    message: domainUpdateMessage({ headline: opts.title, message: opts.message, domain: opts.domain, status: opts.status, dashboardUrl }),
    whatsappTemplate: 'domain_update',
    notification: { message: opts.message, severity: opts.status === 'active' ? 'success' : 'warning' },
    operatorEmails: platformOperatorEmails(env),
  })
}
