<template>
  <DashboardLeafPanel id="team-conversation-name" title="Conversation name" save-label="Save name" :saving="saving" :disabled="!thread?.canManage || name.trim().length > 100 || (name.trim() || null) === thread?.name" :error="actionError || (error ? getErrorMessage(error, 'Conversation could not be loaded') : !thread?.canManage ? 'You cannot rename this conversation' : '')" @save="save">
    <UInput v-model="name" aria-label="Conversation name" placeholder="Optional" :maxlength="100" :disabled="!thread?.canManage || saving" class="w-full" autofocus />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useTeamGroup } from '~/lib/components/workspace/messages/team-thread-client'
import { getErrorMessage } from '~/utils/errors'
definePageMeta({ layout: 'dashboard', tab: 'messages' })
const level = useRouteLevel()
const { thread, error, operate } = await useTeamGroup()
const name = ref('')
const saving = ref(false)
const actionError = ref('')
watch(() => thread.value?.name, value => { name.value = value ?? '' }, { immediate: true })
async function save() {
  if (saving.value || !thread.value?.canManage) return
  const wanted = name.value.trim() || null
  saving.value = true
  actionError.value = ''
  try {
    await operate({ action: 'rename', name: wanted })
    await navigateTo(level.to.value!)
  } catch (error) { actionError.value = getErrorMessage(error, 'The conversation name could not be saved') }
  finally { saving.value = false }
}
</script>
