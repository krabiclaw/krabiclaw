<template>
  <UAlert v-if="error" color="error" variant="soft" :description="getErrorMessage(error, 'People and teams could not be loaded.')" :actions="[{ label: 'Try again', color: 'neutral', variant: 'outline', onClick: () => refresh() }]" />
  <p v-else-if="status !== 'success'" class="text-muted">Loading people and teams…</p>
  <template v-else>
    <UAlert v-if="assignmentError" class="mb-3" color="error" variant="soft" :description="assignmentError" />
    <URadioGroup v-model="selection" :items="options" :disabled="disabled" variant="card" indicator="end" color="neutral" class="w-full" :ui="{ item: 'items-center' }">
      <template #label="{ item }">
        <span class="flex items-center gap-3">
          <UAvatar v-if="item.value !== 'unassigned'" :src="item.avatar ?? undefined" :alt="item.label" :icon="item.team ? 'i-lucide-users' : undefined" size="md" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </span>
      </template>
    </URadioGroup>
  </template>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

const props = withDefaults(defineProps<{ organizationId: string; required?: boolean; profiles?: boolean; peopleLabel?: string; disabled?: boolean }>(), { required: false, profiles: false, peopleLabel: 'Guests', disabled: false })
// These are Better Auth membership and team IDs, not user IDs.
const memberId = defineModel<string | null>('memberId', { required: true })
const teamId = defineModel<string | null>('teamId', { required: true })
const { data, error, status, refresh } = await useMemberSchedulingList(() => props.organizationId)
const assignmentError = computed(() => {
  if (memberId.value && teamId.value) return 'Choose one person or one team.'
  if (!data.value) return null
  if (memberId.value && !data.value.members.some(member => member.id === memberId.value)) return 'The assigned person is no longer a member of this workspace.'
  if (teamId.value && !data.value.teams.some(team => team.id === teamId.value)) return 'The assigned team is no longer part of this workspace.'
  return null
})
const selection = computed({
  get: () => memberId.value && teamId.value ? undefined : teamId.value ? `team:${teamId.value}` : memberId.value ? `member:${memberId.value}` : 'unassigned',
  set: (value: string | undefined) => {
    if (value?.startsWith('team:')) { memberId.value = null; teamId.value = value.slice(5) }
    else if (value?.startsWith('member:')) { teamId.value = null; memberId.value = value.slice(7) }
    else { memberId.value = null; teamId.value = null }
  },
})
const options = computed(() => data.value ? [
  { value: 'unassigned', label: 'Unassigned', description: 'No person or team is assigned.', avatar: null, team: false, disabled: props.required },
  ...data.value.members.map(member => ({
    value: `member:${member.id}`, label: member.name, avatar: props.profiles ? member.scheduling?.public_photo_url || member.image : member.image, team: false,
    description: props.profiles ? member.scheduling?.public_approved === 1 ? 'Profile published' : `Profile not published: ${props.peopleLabel} can't see it yet` : undefined,
  })),
  ...data.value.teams.map(team => ({
    value: `team:${team.id}`, label: `Team: ${team.name}`, avatar: null, team: true,
    description: `${team.members.length} ${team.members.length === 1 ? 'member' : 'members'}${props.profiles ? `: ${props.peopleLabel} see each one with a published profile` : ''}`,
  })),
] : [])
</script>
