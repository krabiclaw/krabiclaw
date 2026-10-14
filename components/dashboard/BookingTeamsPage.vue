<template>
  <DashboardIndexPanel id="booking-teams" title="Booking teams">
    <template #right><UButton icon="i-lucide-plus" color="neutral" variant="soft" square aria-label="Add a booking team" :to="`${level.path.value}/new`" /></template>
    <UAlert v-if="error" color="error" :description="getErrorMessage(error, 'Booking teams could not be loaded')" />
    <EditorNavigationList v-else-if="data?.teams.length" :groups="groups" :active-item="level.child.value" />
    <p v-else class="text-muted">No booking teams yet.</p>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { getErrorMessage } from '~/utils/errors'
import { isOrganizationMembersData, organizationMembersKey } from '~/utils/organization-members'

// Booking teams group eligible hosts; Airbnb has no equivalent staff pool.
const route = useRoute()
const level = useRouteLevel()
const dashboardApi = useDashboardApi()
const { data, error } = await useAsyncData(
  () => organizationMembersKey(String(route.params.orgSlug)),
  () => dashboardApi('/api/dashboard/members', { validate: isOrganizationMembersData }),
)
const groups = computed(() => [{ id: 'teams', items: (data.value?.teams ?? []).map(team => ({
  id: team.id, label: team.name, summary: `${team.members.length} members`,
  to: `${level.path.value}/${encodeURIComponent(team.id)}`, lead: { icon: 'i-lucide-users' },
})) }])
</script>
