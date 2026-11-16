import type { MessageBatch } from '@cloudflare/workers-types'
import { bindDatabaseEvents } from '~/server/db'
import { consumeEvent, type DomainEvent } from '~/server/events'
import { describeFailure } from '~/server/scheduled-tasks'
import type { CloudflareEnv } from '~/server/utils/auth'

/** Acknowledge completed events and let Cloudflare redeliver failures. */
export async function consumeEventBatch(env: CloudflareEnv, batch: MessageBatch): Promise<void> {
  bindDatabaseEvents(env.DB, env)
  const failures: Error[] = []
  for (const message of batch.messages) {
    try {
      await consumeEvent(env, message.body as DomainEvent, message.attempts > 1)
      message.ack()
    } catch (cause) {
      failures.push(new Error(`Event ${message.id} failed: ${describeFailure(cause)}`, { cause }))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(failure => failure.message).join('\n'))
}
