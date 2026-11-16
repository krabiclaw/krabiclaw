import assert from 'node:assert/strict'
import type { MessageBatch } from '@cloudflare/workers-types'
import { consumeEventBatch } from '../../../server/cloudflare/queue-consumer.ts'
import type { DomainEvent, EventsEnv } from '../../../server/events.ts'
import type { CloudflareEnv } from '../../../server/utils/auth.ts'

type Delivery = { id: string; body: DomainEvent; delaySeconds: number }

/** Capture Cloudflare queue sends and deliver through the Worker consumer. */
export function captureEvents() {
  const pending: Delivery[] = []
  const binding: NonNullable<EventsEnv['EVENTS']> = {
    async send(body, options) {
      pending.push({ id: crypto.randomUUID(), body, delaySeconds: options?.delaySeconds ?? 0 })
    },
  }
  const take = (type?: DomainEvent['type'], delaySeconds = 0) => {
    const index = pending.findIndex(item => (!type || item.body.type === type) && item.delaySeconds === delaySeconds)
    return index < 0 ? undefined : pending.splice(index, 1)[0]
  }
  const deliver = async (env: CloudflareEnv, item: Delivery) => {
    let acknowledgements = 0
    const batch = { messages: [{ id: item.id, body: item.body, ack: () => acknowledgements++ }] } as unknown as MessageBatch
    try {
      await consumeEventBatch(env, batch)
    } catch (error) {
      assert.equal(acknowledgements, 0)
      pending.push(item)
      // Each fixture delivery covers one message, so expose its domain error.
      if (error instanceof AggregateError && error.errors.length === 1 && error.errors[0] instanceof Error && error.errors[0].cause !== undefined) {
        throw error.errors[0].cause
      }
      throw error
    }
    assert.equal(acknowledgements, 1)
  }
  const runNext = async (env: CloudflareEnv, type?: DomainEvent['type'], delaySeconds = 0) => {
    const item = take(type, delaySeconds)
    assert(item, `No queued ${type ?? 'domain event'} with delay ${delaySeconds}`)
    await deliver(env, item)
  }
  const drain = async (env: CloudflareEnv, type?: DomainEvent['type']) => {
    for (let count = 0; ; count++) {
      const item = take(type)
      if (!item) return
      assert(count < 100, `Queue did not settle for ${type ?? 'domain events'}`)
      await deliver(env, item)
    }
  }
  return { binding, pending, take, deliver, runNext, drain }
}
