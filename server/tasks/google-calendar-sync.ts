import { refreshMemberBusy } from '~/server/domain/member-scheduling'
import { queryAll } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { runCalendarCleanupJobs, syncCalendarOrganization } from '~/server/utils/google-calendar'
import { ensureCalendarWatch, pullCalendarChanges } from '~/server/utils/google-calendar-inbound'
import { filterEntitledRows } from '~/server/utils/billing-access'
import { defineScheduledTask } from '~/server/utils/scheduled-task'
import { describeErrorForTelemetry } from '~/shared/error-telemetry'

export default defineScheduledTask({
  meta: { name: 'google-calendar-sync', description: 'Reconcile committed bookings and retained Calendar cleanup intents' },
  async run({ context }) {
    const env = (context as { cloudflare: { env: CloudflareEnv } }).cloudflare.env
    const cleanup = await runCalendarCleanupJobs(env)
    // Only a Business plan keeps a calendar in sync; a lapsed plan's selection is reported where it is read, not polled.
    const selected = await filterEntitledRows(env, await queryAll<{member_id:string;organization_id:string}>(env.DB, "SELECT member_id, organization_id FROM member_scheduling WHERE timezone IS NOT NULL AND calendar_account_id IS NOT NULL AND json_array_length(calendar_ids_json)>0 ORDER BY COALESCE(busy_checked_at,'') LIMIT 10"), 'calendar_sync')
    const busyFailures = []
    for (const member of selected) { const result=await refreshMemberBusy(env.DB,env,member.member_id,true); if(result?.error)busyFailures.push(result.error) }
    const organizations = await filterEntitledRows(env, await queryAll<{ organization_id: string }>(env.DB, "SELECT organization_id FROM organization_integrations WHERE provider='google_calendar'"), 'calendar_sync')
    const results = []
    const failures = [...busyFailures]
    for (const organization of organizations) {
      const entry: Record<string, unknown> = { organization_id: organization.organization_id }
      results.push(entry)
      try {
        // Google's change list is the replay feed: whatever a push notification missed lands here.
        entry.inbound = await pullCalendarChanges(env, organization.organization_id)
        await ensureCalendarWatch(env, organization.organization_id)
      } catch(error) {
        failures.push(`${organization.organization_id}: calendar changes could not be read; ${describeErrorForTelemetry(error)}`)
        // A failed pull may leave a newer staff edit unread. Do not overwrite
        // that edit with an outbound projection before its change is handled.
        continue
      }
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
