import type { CloudflareEnv } from '~/server/utils/auth'
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
      push_ranges: ReadonlyArray<readonly [string, string]>
      quiet: boolean
      task_ids: string[]
      guest_cancellation_refund_minor?: number
    }
  | { type: 'stay.hold_changed'; organization_id: string; product_id: string; location_id: string; range: readonly [string, string] }
  | { type: 'stay.hold_released'; payment_id: string }

export interface EventsEnv { EVENTS?: { send(_event: DomainEvent): Promise<void> } }

/** Announce what a write did. The write's own batch has already committed; this is one queue send, no database work. */
export async function publishEvent(env: EventsEnv, event: DomainEvent): Promise<void> {
  if (!env.EVENTS) throw new Error('The EVENTS queue is not bound: a write could not announce what it did')
  await env.EVENTS.send(event)
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
  if (event.type === 'mcp.telemetry') {
    const { logMcpToolCallEvent } = await import('~/server/utils/mcp-telemetry')
    await logMcpToolCallEvent(env.DB, event.record)
    return
  }
  if (event.type === 'stay.hold_changed') {
    const { pushStayHoldNights } = await import('~/server/domain/stays')
    await pushStayHoldNights(env.DB, env, event.organization_id, event.product_id, event.location_id, event.range)
    return
  }
  if (event.type === 'stay.hold_released') {
    const { releaseLapsedStayHolds } = await import('~/server/domain/stays')
    await releaseLapsedStayHolds(env.DB, env, event.payment_id)
    return
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
    const { reactToStayChange } = await import('~/server/domain/stays')
    await reactToStayChange(env, event)
    return
  }
  throw new Error(`Unknown event ${JSON.stringify(event)}`)
}
