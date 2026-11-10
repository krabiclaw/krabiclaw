import { queryAll } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runCalendarCleanupJobs, syncCalendarOrganization } from '~/server/utils/google-calendar'
import { filterEntitledRows } from '~/server/utils/billing-access'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'

export default defineScheduledTask({
  meta: { name: 'google-calendar-sync', description: 'Reconcile committed bookings and retained Calendar cleanup intents' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const cleanup = await runCalendarCleanupJobs(env)
    const organizations = await filterEntitledRows(env, await queryAll<{ organization_id: string }>(env.DB, "SELECT organization_id FROM organization_integrations WHERE provider='google_calendar'"), 'calendar_sync')
    const results = []
    const failures: string[] = []
    for (const organization of organizations) {
      const entry: Record<string, unknown> = { organization_id: organization.organization_id }
      results.push(entry)
      try {
        Object.assign(entry, await syncCalendarOrganization(env, organization.organization_id))
        if(entry.failed)failures.push(`${organization.organization_id}: ${entry.failed} Google Calendar event(s) failed; inspect the integration's last_error`)
      } catch(error) {
        failures.push(`${organization.organization_id}: ${describeErrorForTelemetry(error)}`)
      }
    }
    if (cleanup.failed) failures.push(`${cleanup.failed} retained Google Calendar cleanup job(s) remain unresolved; inspect google_calendar_cleanup_jobs.last_error`)
    if(failures.length)throw new Error(failures.join('; '))
    return { result: { cleanup, organizations: results } }
  },
})
