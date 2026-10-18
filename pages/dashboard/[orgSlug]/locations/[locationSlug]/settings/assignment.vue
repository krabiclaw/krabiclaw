<template>
  <DashboardLeafPanel
    id="location-assignment"
    title="Team assignment"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <p v-if="membersError" role="alert" class="mb-3 text-error">
      Team members could not be loaded.
    </p>
    <p v-else-if="membersStatus !== 'success'" class="mb-3 text-muted">
      Loading team members…
    </p>
    <URadioGroup
      v-else
      v-model="assignedChoice"
      :items="assignmentOptions"
      variant="card"
      class="w-full"
    />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useLocationEditor } from '~/lib/components/workspace/settings/LocationSettingsPage.vue'
import { useMemberSchedulingList } from '~/composables/useMemberSchedulingList'

definePageMeta({ layout: 'dashboard' })

const dashboardLocation = useDashboardLocation()
const organizationId = await useDashboardOrganizationId()
const editor = await useLocationEditor(organizationId, dashboardLocation.currentLocationId, 'assignment')

const { data: members, error: membersError, status: membersStatus } = await useMemberSchedulingList(organizationId)

const WHOLE_ORGANIZATION = 'whole-organization'

const assignedChoice = computed({
  get: () => {
    if (editor.detailsForm.assigned_team_id) return `team:${editor.detailsForm.assigned_team_id}`
    if (editor.detailsForm.assigned_member_id) return `member:${editor.detailsForm.assigned_member_id}`
    return WHOLE_ORGANIZATION
  },
  set: (val: string) => {
    editor.detailsForm.assigned_team_id = val.startsWith('team:') ? val.slice(5) : null
    editor.detailsForm.assigned_member_id = val.startsWith('member:') ? val.slice(7) : null
  },
})

const assignmentOptions = computed(() => {
  if (!members.value) return []
  return [
    {
      value: WHOLE_ORGANIZATION,
      label: 'Whole organization',
      description: 'All team members and administrators manage this location.',
    },
    ...members.value.teams.map(team => ({
      value: `team:${team.id}`,
      label: `Team: ${team.name}`,
      description: `Members of ${team.name} manage this location and its reservations.`,
    })),
    ...members.value.members.map(member => ({
      value: `member:${member.id}`,
      label: member.name,
      description: `${member.name} manages this location and its reservations.`,
    })),
  ]
})
</script>
