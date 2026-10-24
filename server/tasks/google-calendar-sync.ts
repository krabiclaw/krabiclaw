import { refreshMemberBusy } from '~/server/domain/member-scheduling'
import { queryAll } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runCalendarCleanupJobs, syncCalendarOrganization } from '~/server/utils/google-calendar'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'

export default defineScheduledTask({
  meta: { name: 'google-calendar-sync', description: 'Reconcile committed bookings and retained Calendar cleanup intents' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const cleanup = await runCalendarCleanupJobs(env)
    const selected = await queryAll<{member_id:string}>(env.DB, "SELECT member_id FROM member_scheduling WHERE timezone IS NOT NULL AND calendar_account_id IS NOT NULL AND json_array_length(calendar_ids_json)>0 ORDER BY COALESCE(busy_checked_at,'') LIMIT 10")
    const busyFailures = []
    for (const member of selected) { const result=await refreshMemberBusy(env.DB,env,member.member_id,true); if(result?.error)busyFailures.push(result.error) }
    const organizations = await queryAll<{ id: string }>(env.DB, "SELECT organization_id AS id FROM organization_integrations WHERE provider='google_calendar'")
    const results = []
    const failures = [...busyFailures]
    for (const organization of organizations) {
      try {
        const result=await syncCalendarOrganization(env, organization.id)
        results.push({organization_id:organization.id,...result})
        if(result.failed)failures.push(`${organization.id}: ${result.failed} Google Calendar event(s) failed; inspect the integration's last_error`)
      } catch(error) {
        failures.push(`${organization.id}: ${describeErrorForTelemetry(error)}`)
      }
    }
    if (cleanup.failed) failures.push(`${cleanup.failed} retained Google Calendar cleanup job(s) remain unresolved; inspect google_calendar_cleanup_jobs.last_error`)
    if(failures.length)throw new Error(failures.join('; '))
    return { result: { cleanup, organizations: results } }
  },
})
