import { queryFirst } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runRevisionFeed } from '~/server/integrations/channex/booking-revisions'
import { runAlterationRequestFeed } from '~/server/domain/guest-threads/stay-change-requests'
import { defineScheduledTask } from '~/server/utils/scheduled-task'

export default defineScheduledTask({
  meta: { name: 'channex-revision-feed', description: 'Land Channex booking revisions and Airbnb change requests the webhook did not deliver' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    // An environment where no organization ever made a Channex group has no revision to take.
    // Once one has, a missing Channex key fails the run.
    const connected = await queryFirst<{ n: number }>(env.DB, 'SELECT COUNT(*) AS n FROM channex_connections WHERE group_id IS NOT NULL')
    if (!connected?.n) return { result: { acknowledged: 0, ignored: 0, recorded: 0, reconciled: 0 } }
    // Both always run, revisions first, so a revision that will not land does not hide a change request; either failure fails the run.
    const settle = <T>(run: Promise<T>) => run.then(value => ({ value }), (error: unknown) => ({ error }))
    const revisions = await settle(runRevisionFeed(env.DB, env))
    const requests = await settle(runAlterationRequestFeed(env.DB, env))
    if ('error' in revisions || 'error' in requests) {
      const errors = [revisions, requests].flatMap(outcome => 'error' in outcome ? [outcome.error] : [])
      throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('; '))
    }
    return { result: { ...revisions.value, ...requests.value } }
  },
})
