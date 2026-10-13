<template>
  <DashboardIndexPanel v-if="!concern" id="booking-team" :title="team?.name ?? 'New booking team'" :auto-open="creating ? `${level.path.value}/name` : null">
    <UAlert v-if="loadError || saveError" color="error" :description="saveError ?? getErrorMessage(loadError, 'Booking team could not be loaded')" />
    <EditorNavigationList :groups="groups" :active-item="level.child.value" />
    <UButton v-if="team" class="mt-8" color="error" variant="ghost" :loading="saving" @click="remove">Delete team</UButton>
  </DashboardIndexPanel>
  <DashboardLeafPanel v-else id="booking-team-setting" :title="concern === 'name' ? 'Team name' : 'Team members'" :lead="concern === 'members' ? 'Bookings can use the working hours of any included member.' : undefined" :save-label="creating ? 'Create team' : 'Save'" :saving="saving" :disabled="Boolean(loadError) || !form?.dirty || !valid" :error="saveError ?? (loadError ? getErrorMessage(loadError, 'Booking team could not be loaded') : '')" @cancel="reset(); revision += 1" @save="form?.submit()">
    <UForm ref="form" :key="revision" :state="{ name, included }" @submit="save">
      <UInput v-if="concern === 'name'" v-model="name" aria-label="Team name" variant="none" autofocus class="w-full" :ui="{ base: 'px-0 text-2xl md:text-2xl' }" />
      <template v-else>
        <SettingRow v-for="member in data?.members ?? []" :key="member.userId" :model-value="included.includes(member.userId)" :label="member.name" @update:model-value="value => toggle(member.userId, value)" />
      </template>
    </UForm>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { authClient } from '~/lib/auth-client'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ concern?: string }>()
const route = useRoute()
const level = useRouteLevel()
const dashboard = useDashboardOrganization()
const { data, error: loadError, refresh } = await useOrganizationMembers()
const teamId = computed(() => String(route.params.teamId))
const creating = computed(() => teamId.value === 'new')
const team = computed(() => data.value?.teams.find(team => team.id === teamId.value))
const name = ref('')
const included = ref<string[]>([])
const saving = ref(false)
const createdTeamId = ref<string | null>(null)
const saveError = ref<string | null>(null)
const groups = computed(() => [{ id: 'team', items: [
  { id: 'name', label: 'Name', summary: team.value?.name ?? 'Choose a name', to: `${level.path.value}/name` },
  ...(team.value ? [{ id: 'members', label: 'Members', summary: `${team.value.member_user_ids.length} members`, to: `${level.path.value}/members` }] : []),
] }])
watchEffect(() => {
  if (level.mode.value === 'yield') return
  if ((!creating.value && data.value && !team.value) || (props.concern && (!['name', 'members'].includes(props.concern) || (creating.value && props.concern !== 'name')))) showError(createError({ statusCode: 404, statusMessage: 'Page not found' }))
})
function reset() { name.value = team.value?.name ?? ''; included.value = [...(team.value?.member_user_ids ?? [])]; saveError.value = null }
watch([team, () => props.concern], reset, { immediate: true })
function toggle(userId: string, value: boolean) { included.value = value ? [...new Set([...included.value, userId])] : included.value.filter(id => id !== userId) }
const valid = computed(() => props.concern !== 'name' || Boolean(name.value.trim()))
const form = useTemplateRef('form')
// Cancel restores the draft; a new revision is a fresh form, so nothing reads as changed.
const revision = ref(0)
function organizationId() {
  const id = dashboard.organization.value?.id
  if (!id) throw new Error('Organization context is unavailable')
  return id
}
async function save() {
  saving.value = true
  saveError.value = null
  const wanted = [...included.value]
  const wantedName = name.value.trim()
  try {
    let id = createdTeamId.value ?? teamId.value
    if (creating.value && !createdTeamId.value) {
      const result = await authClient.organization.createTeam({ organizationId: organizationId(), name: wantedName })
      if (result.error) throw new Error(result.error.message)
      if (!result.data) throw new Error('The created team was not returned')
      id = result.data.id
      createdTeamId.value = id
    } else if (props.concern === 'name') {
      const result = await authClient.organization.updateTeam({ teamId: id, data: { organizationId: organizationId(), name: wantedName } })
      if (result.error) throw new Error(result.error.message)
    } else {
      await refresh()
      if (loadError.value) throw loadError.value
      const current = data.value?.teams.find(team => team.id === id)
      if (!current) throw new Error('This team no longer exists')
      for (const userId of new Set([...current.member_user_ids, ...wanted])) {
        if (current.member_user_ids.includes(userId) === wanted.includes(userId)) continue
        const body = { organizationId: organizationId(), teamId: id, userId }
        const result = wanted.includes(userId) ? await authClient.organization.addTeamMember(body) : await authClient.organization.removeTeamMember(body)
        if (result.error) throw new Error(result.error.message)
      }
    }
    await refresh()
    if (loadError.value) throw loadError.value
    const saved = data.value?.teams.find(team => team.id === id)
    if (!saved || (props.concern === 'name' && saved.name !== wantedName) || (props.concern === 'members' && JSON.stringify([...saved.member_user_ids].sort()) !== JSON.stringify([...wanted].sort()))) throw new Error('The team changes could not be verified')
    await refreshNuxtData(`member-scheduling-list:${organizationId()}`)
    await navigateTo(creating.value ? `/dashboard/${encodeURIComponent(String(route.params.orgSlug))}/team/groups/${encodeURIComponent(id)}` : level.to.value!)
  } catch (error) {
    name.value = wantedName
    included.value = wanted
    saveError.value = getErrorMessage(error, 'Team could not be saved')
  }
  finally { saving.value = false }
}
async function remove() {
  saving.value = true
  saveError.value = null
  try {
    const result = await authClient.organization.removeTeam({ organizationId: organizationId(), teamId: teamId.value })
    if (result.error) throw new Error(result.error.message)
    await refresh()
    if (loadError.value) throw loadError.value
    if (data.value?.teams.some(team => team.id === teamId.value)) throw new Error('The deleted team is still present')
    await refreshNuxtData(`member-scheduling-list:${organizationId()}`)
    await navigateTo(level.to.value!)
  } catch (error) { saveError.value = getErrorMessage(error, 'Team could not be deleted') }
  finally { saving.value = false }
}
</script>
