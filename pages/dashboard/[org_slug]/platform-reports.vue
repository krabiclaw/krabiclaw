<template>
  <DashboardIndexPanel id="platform-reports" title="Platform reports" column="reading">
    <div class="space-y-6">
      <p class="text-sm text-muted">
        What members reported about guests and teammates, and the guests they blocked. Decide each within 24 hours: Remove takes the
        content away and bans its author's KrabiClaw account; an Airbnb guest has no account, so their conversation is
        blocked for that business.
      </p>

      <div class="flex gap-2">
        <UButton v-for="option in statuses" :key="option.value" size="sm" class="rounded-full" :color="status === option.value ? 'primary' : 'neutral'" :variant="status === option.value ? 'solid' : 'soft'" @click="status = option.value">
          {{ option.label }}
        </UButton>
      </div>

      <UAlert v-if="actionError" color="error" variant="soft" icon="i-lucide-circle-alert" :description="actionError" />
      <UAlert v-if="loadError" color="error" variant="soft" title="Could not load reports" :description="getErrorMessage(loadError, 'Failed to load reports.')" />

      <ul v-else>
        <li v-for="report in reports" :key="report.id" class="space-y-3 border-b border-default py-6 last:border-b-0" :data-report="report.id">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="text-base text-highlighted">
              {{ report.subject === 'guest_thread' ? (report.blocked ? 'Guest blocked' : 'Guest conversation') : 'Team message' }}
              <span class="text-muted">· {{ report.organizationName }}</span>
            </p>
            <p class="text-sm text-muted">{{ formatTimestamp(report.createdAt, 'en-US', 'UTC') }} UTC</p>
          </div>
          <p class="text-sm text-muted">
            Reported by {{ report.reporter ? `${report.reporter.name} (${report.reporter.email})` : 'a deleted account' }}<span v-if="report.author">
            · written by {{ report.author.name }} ({{ report.author.email }})<span v-if="report.author.banned"> · banned</span></span>
          </p>
          <p class="text-sm"><span class="font-medium">Reason:</span> {{ report.reason }}</p>
          <p class="whitespace-pre-wrap break-words rounded-2xl bg-elevated px-4 py-3 text-sm">{{ report.excerpt }}</p>
          <div v-if="report.status === 'open'" class="flex gap-2">
            <UButton size="sm" color="error" class="rounded-full" :loading="deciding === `${report.id}:remove`" :disabled="deciding !== null" @click="decide(report.id, 'remove')">Remove and ban</UButton>
            <UButton size="sm" color="neutral" variant="soft" class="rounded-full" :loading="deciding === `${report.id}:dismiss`" :disabled="deciding !== null" @click="decide(report.id, 'dismiss')">Dismiss</UButton>
          </div>
        </li>
        <li v-if="!reports.length" class="py-6 text-sm text-muted">No {{ status }} reports.</li>
      </ul>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { canOpenPlatformReports } from '~/utils/platform-admin-access'
import { isRecord } from '~/utils/api-clients'
import { formatTimestamp } from '~/utils/timezone'

// Content reports from every business, decided by KrabiClaw staff. Like
// Platform accounts it exists only inside KrabiClaw's own organization and only
// for a Better Auth admin who may ban users; the server enforces both again.
definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

const dashboard = useDashboardOrganization()
const session = authClient.useSession()
if (session.value.isPending) await session.value.refetch()
if (session.value.error) throw createError({ statusCode: session.value.error.status || 503, statusMessage: getErrorMessage(session.value.error, 'Your session could not be loaded') })
if (!dashboard.organization.value || !canOpenPlatformReports(dashboard.organization.value, (session.value.data?.user as { role?: string | null } | undefined)?.role)) {
  throw createError({ statusCode: 404, statusMessage: 'Page not found' })
}

useSeoMeta({ title: 'Platform reports | KrabiClaw Dashboard', robots: 'noindex, nofollow' })

interface Report {
  id: string
  organizationName: string
  subject: 'guest_thread' | 'team_message'
  reporter: { name: string; email: string } | null
  author: { name: string; email: string; banned: boolean } | null
  reason: string
  excerpt: string
  blocked: boolean
  status: 'open' | 'removed' | 'dismissed'
  createdAt: string
}

const statuses = [
  { value: 'open', label: 'Open' },
  { value: 'removed', label: 'Removed' },
  { value: 'dismissed', label: 'Dismissed' },
] as const
const status = ref<Report['status']>('open')
const api = useDashboardApi()

function isReport(value: unknown): value is Report {
  return isRecord(value) && typeof value.id === 'string' && typeof value.organizationName === 'string'
    && (value.subject === 'guest_thread' || value.subject === 'team_message')
    && typeof value.reason === 'string' && typeof value.excerpt === 'string' && typeof value.blocked === 'boolean'
    && (value.status === 'open' || value.status === 'removed' || value.status === 'dismissed') && typeof value.createdAt === 'string'
}

const { data, error: loadError, refresh } = await useAsyncData(() => `platform-reports:${status.value}`, () =>
  api('/api/dashboard/platform-reports', {
    query: { status: status.value },
    validate: (value: unknown): value is { reports: Report[] } => isRecord(value) && Array.isArray(value.reports) && value.reports.every(isReport),
  }))
const reports = computed(() => data.value?.reports ?? [])

const deciding = ref<string | null>(null)
const actionError = ref<string | null>(null)
async function decide(reportId: string, decision: 'remove' | 'dismiss') {
  deciding.value = `${reportId}:${decision}`
  actionError.value = null
  try {
    await api(`/api/dashboard/platform-reports/${encodeURIComponent(reportId)}/resolve`, {
      method: 'POST', body: { decision }, validate: (value: unknown): value is { report: Report } => isRecord(value) && isReport(value.report),
    })
    await refresh()
  } catch (error) {
    actionError.value = getErrorMessage(error, 'The report could not be decided')
  } finally {
    deciding.value = null
  }
}
</script>
