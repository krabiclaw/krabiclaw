import type { CloudflareEnv } from '~/server/utils/auth'

/*
  What happened, said once by the write that did it. The write sends one
  message to Cloudflare's queue and answers; Cloudflare delivers the message to
  this Worker within seconds, retries a delivery that fails and keeps one that
  never succeeds in the dead-letter queue. Nothing here runs on a timer, and no
  write waits on what reacts to it.
*/
export type DomainEvent =
  /** A job was created, given out, moved or closed in this business: its conversation, its post and its reminders follow. */
  | { type: 'jobs.changed'; organization_id: string }

export interface EventsEnv { EVENTS?: { send(_event: DomainEvent): Promise<void> } }

/** Announce what a write did. The write's own batch has already committed; this is one queue send, no database work. */
export async function publishEvent(env: EventsEnv, event: DomainEvent): Promise<void> {
  if (!env.EVENTS) throw new Error('The EVENTS queue is not bound: a write could not announce what it did')
  await env.EVENTS.send(event)
}

/** React to one event. A throw is the delivery's failure: Cloudflare retries it. */
export async function consumeEvent(env: CloudflareEnv, event: DomainEvent): Promise<void> {
  if (event.type === 'jobs.changed') {
    const { postJobs } = await import('~/server/domain/cleaner-jobs')
    await postJobs(env, env.DB, event.organization_id)
    // The reminders it stored are sent at their exact times: the business's hub is told to look.
    const { publishBusinessInvalidation } = await import('~/server/cloudflare/guest-inbox-events')
    await publishBusinessInvalidation(env, event.organization_id)
    return
  }
  throw new Error(`Unknown event ${JSON.stringify(event)}`)
}
