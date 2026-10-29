<template>
  <DashboardLeafPanel id="new-team-conversation" title="New team conversation" save-label="Start" :disabled="!selected.length || !!membersError || !!stayError" :saving="saving" :error="actionError" @save="start">
    <UAlert v-if="membersError || stayError" class="mb-6" color="error" title="Conversation could not be prepared" :description="getErrorMessage(membersError || stayError, 'Team members could not be loaded')" />
    <template v-if="members">
      <UFormField v-if="selected.length >= 2 && !stayId && !locationId" label="Conversation name" class="mb-6">
        <UInput v-model="name" aria-label="Conversation name" placeholder="Optional" :maxlength="100" :disabled="saving" class="w-full" />
      </UFormField>
      <UInput v-model="search" icon="i-lucide-search" placeholder="Search teammates" aria-label="Search teammates" class="mb-6 w-full" />
      <div class="divide-y divide-default">
        <div v-for="member in visibleMembers" :key="member.id" class="flex items-center gap-3 py-4">
          <UAvatar :src="member.image ?? undefined" :alt="member.name" size="md" />
          <UCheckbox :model-value="selected.includes(member.id)" :label="member.name" :description="member.email" :disabled="saving" class="min-w-0 flex-1" :ui="{ root: 'flex-row-reverse justify-between', wrapper: 'min-w-0 flex-1' }" @update:model-value="toggle(member.id, $event === true)" />
        </div>
      </div>
      <p v-if="!visibleMembers.length" class="py-6 text-muted">{{ search ? 'No teammates match' : 'There are no other members in this workspace' }}</p>
      <p v-if="location" class="mt-8 text-base text-muted">About {{ location.title }}</p>
      <p v-if="stay" class="mt-8 text-base text-muted">About {{ stay.check_in_date }} – {{ stay.check_out_date }}</p>
    </template>
  </DashboardLeafPanel>
</template>
<script setup lang="ts">
import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'
import { isTeamMembersResponse } from '~/lib/components/workspace/messages/team-thread-client'
import type { StayDetail } from '~/server/domain/stays'
definePageMeta({ layout: 'dashboard', tab: 'messages' })
const route = useRoute()
const dashboard = useDashboardOrganization()
const session = authClient.useSession()
// The member picker must know its caller before offering anyone as a recipient.
if (session.value.isPending) await session.value.refetch()
if (session.value.error) throw createError({ statusCode: session.value.error.status || 503, statusMessage: getErrorMessage(session.value.error, 'Your session could not be loaded') })
const api = useDashboardApi()
const selected = ref<string[]>([])
const name = ref('')
let attempt: { identity: string; key: string } | null = null
const search = ref('')
const actionError = ref('')
const saving = ref(false)
// Context comes from the caller, never from whichever stay or location happens to be first.
for (const field of ['stayId', 'locationId']) {
  const value = route.query[field]
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw createError({ statusCode: 400, statusMessage: `${field} must name one explicit context` })
}
const stayId = typeof route.query.stayId === 'string' ? route.query.stayId : null
const locationId = typeof route.query.locationId === 'string' ? route.query.locationId : null
const location = locationId ? dashboard.locations.value.find(location => location.id === locationId) : null
if (locationId && !location) throw createError({ statusCode: 404, statusMessage: 'That conversation location is not available in this workspace' })
const { data: members, error: membersError } = await useAsyncData(`team-members:${dashboard.organizationId.value}`, () => api('/api/dashboard/team/members', { validate: isTeamMembersResponse }))
const { data: stayData, error: stayError } = await useAsyncData(`team-compose-stay:${dashboard.organizationId.value}:${stayId}`, () => stayId ? api(`/api/dashboard/stays/${encodeURIComponent(stayId)}`, {
  validate: (value): value is { stay: StayDetail } => isRecord(value) && isRecord(value.stay) && value.stay.id === stayId && typeof value.stay.check_in_date === 'string' && typeof value.stay.check_out_date === 'string',
}) : Promise.resolve(null))
const stay = computed(() => stayData.value?.stay)
const visibleMembers = computed(() => members.value?.members.filter(member => member.id !== session.value.data?.user.id && `${member.name} ${member.email}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())) ?? [])
function toggle(id: string, checked: boolean) { selected.value = checked ? [...selected.value, id] : selected.value.filter(memberId => memberId !== id) }
async function start() {
  if (saving.value || !selected.value.length) return
  saving.value = true
  actionError.value = ''
  try {
    const body = { memberIds: [...selected.value].sort(), ...(selected.value.length >= 2 && !stayId && !locationId && name.value.trim() ? { name: name.value.trim() } : {}), ...(stayId ? { stayId } : {}), ...(locationId ? { locationId } : {}) }
    const identity = JSON.stringify(body)
    if (attempt?.identity !== identity) attempt = { identity, key: crypto.randomUUID() }
    const thread = await api('/api/dashboard/team/threads', {
      method: 'POST', body: { ...body, idempotencyKey: attempt.key },
      validate: (value): value is { id: string } => isRecord(value) && typeof value.id === 'string' && Boolean(value.id),
    })
    await refreshNuxtData(`team-threads:${dashboard.organizationId.value}`)
    await navigateTo({ path: `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/messages/team/${encodeURIComponent(thread.id)}`, query: { view: 'team' } })
  } catch (error) { actionError.value = getErrorMessage(error, 'The team conversation could not be started') }
  finally { saving.value = false }
}
</script>
