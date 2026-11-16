import type { CloudflareEnv } from '~/server/utils/auth'
import type { ChannelStayTerms } from '~/server/domain/stays'
import type { PaymentFinancialEvent } from '~/server/domain/payments/notifications'
import type { McpToolCallEvent } from '~/server/utils/mcp-telemetry'
import { isRecord } from '~/server/utils/type-guards'

/*
  What happened, said once by the write that did it. The write sends one
  message to Cloudflare's queue and answers; Cloudflare delivers the message to
  this Worker within seconds, retries a delivery that fails and keeps one that
  never succeeds in the dead-letter queue. Nothing here runs on a timer, and no
  write waits on what reacts to it.
*/
export type DomainEvent =
  | { type: 'airbnb.sync'; organization_id: string; job_id: string }
  | { type: 'booking.created'; organization_id: string; conversation_id: string }
  | { type: 'booking.status_changed'; organization_id: string; conversation_id: string; message_id: string; delivery_id: string }
  | { type: 'booking.change'; organization_id: string; conversation_id: string; entry_id: string; proposal_id: string }
  | { type: 'business.wake'; organization_id: string; kind: 'reviews' | 'retention' | 'checkout' | 'ad_spend' | 'channex_ari'; due_at: number }
  | { type: 'domain.check_requested'; organization_id: string; domains: Array<{ id: string; cloudflare_hostname_id: string | null }>; actor?: { id: string; type: 'owner' | 'admin'; organization_slug: string } }
  | { type: 'deployment.adopt_pending_work' }
  | { type: 'site.cache_changed'; organization_id: string; invalidation_id: string | null }
  | { type: 'calendar.changed'; organization_id: string; booking_id: string | null }
  | { type: 'calendar.cleanup'; organization_id: string }
  /** Already-redacted operational telemetry and the related MCP usage. */
  | { type: 'mcp.telemetry'; record: McpToolCallEvent }
  /** A job was created, given out, moved or closed in this business: its conversation, its post and its reminders follow. */
  | { type: 'jobs.changed'; organization_id: string; task_ids: string[]; /** Post without alerting anyone: the jobs are not news (an import, or work that already existed). */ quiet?: boolean }
  /** A saved stay's guest messages, nights and dashboard publication. */
  | {
      type: 'stay.changed'
      organization_id: string
      booking_id: string
      product_id: string
      location_id: string
      conversation_id: string
      version: number
      nights_changed: boolean
      review_due_at?: number | null
      push_ranges: ReadonlyArray<readonly [string, string]>
      prior_homes?: ReadonlyArray<{ product_id: string; location_id: string }>
      quiet: boolean
      task_ids: string[]
      guest_cancellation_refund_minor?: number
      checkout_expires_at?: string
    }
  | { type: 'stay.hold_changed'; organization_id: string; product_id: string; location_id: string; range: readonly [string, string]; checkout_expires_at: string }
  | { type: 'stay.checkout_expired'; organization_id: string; kind: 'hold' | 'request'; id: string }
  | { type: 'stay.channel_revision'; organization_id: string; booking_id: string; revision_id: string; previous: ChannelStayTerms | null; terms: ChannelStayTerms }
  | { type: 'stay.guide_changed'; organization_id: string; product_id: string }
  | { type: 'payment.financial'; organization_id: string; payment_id: string; notice: PaymentFinancialEvent }
  | { type: 'payment.checkout_started'; organization_id: string; payment_id: string; saved_cards_offered: number | null }
  | {
      type: 'payment.captured'; organization_id: string; payment_id: string; notice: PaymentFinancialEvent
      intent_created: number; saved_method_id: string | null
      booking: { unit: 'nights'; id: string } | { unit: 'slot'; conversation_id: string } | null
    }

type EventDeliveryOptions = { delaySeconds: number }
export interface EventsEnv { EVENTS?: { send(_event: DomainEvent, _options?: EventDeliveryOptions): Promise<void> } }

/** Announce what a write did. The write's own batch has already committed; this is one queue send, no database work. */
export async function publishEvent(env: EventsEnv, event: DomainEvent, options?: EventDeliveryOptions): Promise<void> {
  if (!env.EVENTS) throw new Error('The EVENTS queue is not bound: a write could not announce what it did')
  await env.EVENTS.send(event, options)
}

/** Task mutations return their IDs in the same batch that writes them. */
export function changedTaskIds(batch: readonly D1Result[]): string[] {
  return [...new Set(batch.flatMap(result => result.results.flatMap(row =>
    isRecord(row) && typeof row.changed_task_id === 'string' ? [row.changed_task_id] : [])))]
}

export async function publishChangedJobs(env: EventsEnv, organizationId: string, taskIds: string[]): Promise<void> {
  if (taskIds.length) await publishEvent(env, { type: 'jobs.changed', organization_id: organizationId, task_ids: taskIds })
}

/** React to one event. A throw is the delivery's failure: Cloudflare retries it. */
export async function consumeEvent(env: CloudflareEnv, event: DomainEvent): Promise<void> {
  if (event.type === 'airbnb.sync') {
    const { advanceAirbnbSyncJob } = await import('~/server/integrations/channex/airbnb-sync')
    await advanceAirbnbSyncJob(env, event.organization_id, event.job_id)
    return
  }
  if (event.type === 'booking.change') {
    const { deliverBookingChange } = await import('~/server/domain/guest-threads/booking-changes')
    await deliverBookingChange(env, event)
    return
  }
  if (event.type === 'booking.created') {
    const { notifyProductBookingCreated } = await import('~/server/domain/product-bookings')
    await notifyProductBookingCreated(env, env.DB, event.organization_id, event.conversation_id)
    return
  }
  if (event.type === 'calendar.changed' || event.type === 'calendar.cleanup') {
    const calendar = await import('~/server/utils/google-calendar')
    if (event.type === 'calendar.changed') await calendar.drainCalendarChange(env, event.organization_id, event.booking_id)
    else await calendar.drainCalendarCleanup(env, event.organization_id)
    return
  }
  if (event.type === 'business.wake') {
    const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
    await scheduleBusinessWake(env, event.organization_id, event.kind, event.due_at)
    return
  }
  if (event.type === 'deployment.adopt_pending_work') {
    const { enqueueOutstandingWork } = await import('~/server/domain/due-business-work')
    await enqueueOutstandingWork(env)
    return
  }
  if (event.type === 'domain.check_requested') {
    const { reconcileRequestedDomains } = await import('~/server/utils/domain-dashboard-actions')
    await reconcileRequestedDomains(env, event)
    return
  }
  if (event.type === 'site.cache_changed') {
    const { CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS, drainPublicResourceCacheInvalidations } = await import('~/server/utils/public-resource-cache')
    const { RETENTION_HUB, retentionWakeAt } = await import('~/server/domain/due-business-work')
    const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
    if (!env.ORGANIZATION_CACHE) throw new Error('ORGANIZATION_CACHE is not bound')
    const now = new Date()
    try {
      await drainPublicResourceCacheInvalidations(env.DB, env.ORGANIZATION_CACHE, env, {
        organizationId: event.organization_id, invalidationId: event.invalidation_id, now,
      })
    } finally {
      await scheduleBusinessWake(env, RETENTION_HUB, 'retention', retentionWakeAt(now.getTime() + CACHE_INVALIDATION_TERMINAL_RETENTION_DAYS * 86_400_000))
    }
    return
  }
  if (event.type === 'mcp.telemetry') {
    const { logMcpToolCallEvent, MCP_AUDIT_RETENTION_DAYS, MCP_DIAGNOSTIC_RETENTION_DAYS } = await import('~/server/utils/mcp-telemetry')
    const { RETENTION_HUB, retentionWakeAt } = await import('~/server/domain/due-business-work')
    const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
    await logMcpToolCallEvent(env.DB, event.record)
    const diagnostic = event.record.arguments_summary_json?.startsWith('{"_diagnostic":true,')
    const days = diagnostic ? MCP_DIAGNOSTIC_RETENTION_DAYS : MCP_AUDIT_RETENTION_DAYS
    await scheduleBusinessWake(env, RETENTION_HUB, 'retention', retentionWakeAt(Date.parse(event.record.created_at) + days * 86_400_000))
    return
  }
  if (event.type === 'stay.hold_changed') {
    const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
    await scheduleBusinessWake(env, event.organization_id, 'checkout', Date.parse(event.checkout_expires_at))
    const { pushStayHoldNights } = await import('~/server/domain/stays')
    await pushStayHoldNights(env.DB, env, event.organization_id, event.product_id, event.location_id, event.range)
    return
  }
  if (event.type === 'booking.status_changed') {
    const { deliverBookingStatusUpdate } = await import('~/server/domain/guest-threads/operations')
    await deliverBookingStatusUpdate(env, event)
    return
  }
  if (event.type === 'stay.channel_revision') {
    const { notifyChannelStay } = await import('~/server/utils/notifications')
    await notifyChannelStay(env, env.DB, event.organization_id, { stayId: event.booking_id, revisionId: event.revision_id, previous: event.previous, terms: event.terms })
    return
  }
  if (event.type === 'stay.guide_changed') {
    const { planStayCheckInMessages } = await import('~/server/domain/scheduled-guest-messages')
    const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
    await planStayCheckInMessages(env.DB, event.organization_id, event.product_id)
    await scheduleBusinessWake(env, event.organization_id, 'outbox', Date.now())
    return
  }
  if (event.type === 'payment.checkout_started') {
    const { recordCheckoutStarted } = await import('~/server/domain/booking-analytics')
    await recordCheckoutStarted(env.DB, event)
    return
  }
  if (event.type === 'payment.financial' || event.type === 'payment.captured') {
    const { notifyRecordedPayment } = await import('~/server/domain/payments/events')
    await notifyRecordedPayment(env, event)
    return
  }
  if (event.type === 'stay.checkout_expired') {
    const { expireStayRequest, releaseLapsedStayHold } = await import('~/server/domain/stays')
    if (event.kind === 'hold') await releaseLapsedStayHold(env.DB, env, event.organization_id, event.id)
    else await expireStayRequest(env.DB, env, event.organization_id, event.id)
    return
  }
  if (event.type === 'stay.changed' && event.checkout_expires_at) {
    const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
    await scheduleBusinessWake(env, event.organization_id, 'checkout', Date.parse(event.checkout_expires_at))
  }
  if (event.type === 'stay.changed' || event.type === 'jobs.changed') {
    if (event.task_ids.length) {
      const { postJobs } = await import('~/server/domain/cleaner-jobs')
      await postJobs(env, env.DB, event.organization_id, event.task_ids, { quiet: event.quiet === true })
    }
    if (event.type === 'jobs.changed') {
      const { publishBusinessInvalidation } = await import('~/server/cloudflare/guest-inbox-events')
      await publishBusinessInvalidation(env, event.organization_id)
      return
    }
    if (event.review_due_at != null) {
      const { scheduleBusinessWake } = await import('~/server/cloudflare/guest-inbox-events')
      await scheduleBusinessWake(env, event.organization_id, 'reviews', event.review_due_at)
    }
    await publishEvent(env, { type: 'calendar.changed', organization_id: event.organization_id, booking_id: event.booking_id })
    const { reactToStayChange } = await import('~/server/domain/stays')
    await reactToStayChange(env, event)
    return
  }
  throw new Error(`Unknown event ${JSON.stringify(event)}`)
}
