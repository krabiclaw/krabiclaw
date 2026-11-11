<template>
  <UAlert v-if="error" color="error" variant="soft" :description="getErrorMessage(error, 'People could not be loaded.')" :actions="[{ label: 'Try again', color: 'neutral', variant: 'outline', onClick: () => refresh() }]" />
  <p v-else-if="status !== 'success'" class="text-muted">Loading people…</p>
  <template v-else>
    <UAlert v-if="assignmentError" class="mb-3" color="error" variant="soft" :description="assignmentError" />
    <URadioGroup v-model="selection" :items="options" :disabled="disabled" variant="card" indicator="end" color="neutral" class="w-full" :ui="{ item: 'items-center' }">
      <template #label="{ item }">
        <span class="flex items-center gap-3">
          <UAvatar v-if="item.value !== 'unassigned'" :src="item.avatar ?? undefined" :alt="item.label" size="md" aria-hidden="true" />
          <span>{{ item.label }}</span>
        </span>
      </template>
    </URadioGroup>
  </template>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

const props = withDefaults(defineProps<{ organizationId: string; required?: boolean; profiles?: boolean; peopleLabel?: string; disabled?: boolean }>(), { required: false, profiles: false, peopleLabel: 'Guests', disabled: false })
// A Better Auth membership ID, not a user ID.
const memberId = defineModel<string | null>('memberId', { required: true })
const { data, error, status, refresh } = await useMemberSchedulingList(() => props.organizationId)
const assignmentError = computed(() => {
  if (!data.value) return null
  if (memberId.value && !data.value.members.some(member => member.id === memberId.value)) return 'The assigned person is no longer a member of this workspace.'
  return null
})
const selection = computed({
  get: () => memberId.value ?? 'unassigned',
  set: (value: string | undefined) => { memberId.value = value && value !== 'unassigned' ? value : null },
})
const options = computed(() => data.value ? [
  { value: 'unassigned', label: 'Unassigned', description: 'No person is assigned.', avatar: null, disabled: props.required },
  ...data.value.members.map(member => ({
    value: member.id, label: member.name, avatar: props.profiles ? member.scheduling?.public_photo_url || member.image : member.image,
    description: props.profiles ? member.scheduling?.public_approved === 1 ? 'Profile published' : `Profile not published: ${props.peopleLabel} can't see it yet` : undefined,
  })),
] : [])
</script>
