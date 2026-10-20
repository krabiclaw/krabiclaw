<template>
  <DashboardLeafPanel
    id="product-room-privacy"
    title="Bedroom privacy"
    lead="Is there a bathroom attached to this bedroom that’s just for its guests?"
    :saving="p.saving.value"
    :disabled="!room || !changed || Boolean(p.loadError.value)"
    :error="p.loadError.value || p.photoError.value || ''"
    desktop-cancel
    @cancel="reset"
    @save="save"
  >
    <template #right>
      <UButton label="Clear details" color="neutral" variant="ghost" :disabled="p.saving.value || draft === null" @click="draft = null" />
    </template>
    <template v-if="room">
      <div v-if="draft === null" class="mb-6 space-y-3">
        <p class="text-sm text-muted" role="status">Privacy details aren’t specified.</p>
        <UButton label="No private attached bathroom" color="neutral" variant="soft" :disabled="p.saving.value" @click="draft = false" />
      </div>
      <UButton v-if="p.photoError.value" label="Use saved details" color="neutral" variant="soft" :disabled="p.saving.value || Boolean(p.loadError.value)" class="mb-6" @click="reset" />
      <div class="flex items-center justify-between gap-6 py-6">
        <label for="stay-room-private-bathroom" class="text-base text-highlighted">Private attached bathroom</label>
        <USwitch id="stay-room-private-bathroom" :model-value="draft === true" :disabled="p.saving.value" aria-label="Private attached bathroom" @update:model-value="draft = $event" />
      </div>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const roomId = computed(() => String(route.params.roomId))
const room = computed(() => p.photoRooms.value.find(entry => entry.id === roomId.value))
const draft = ref<boolean | null>(null)
const original = ref<boolean | null>(null)
const version = ref<number | null>(null)
const changed = computed(() => draft.value !== original.value)

function reset() {
  if (!room.value) return
  original.value = room.value.private_attached_bathroom
  draft.value = original.value
  version.value = room.value.details_version
  p.photoError.value = null
}

watch(room, () => {
  if (room.value && room.value.type !== 'bedroom') showError(createError({ statusCode: 404, statusMessage: 'Bedroom not found' }))
  if (version.value === null && room.value) reset()
}, { immediate: true })
watch(roomId, () => { version.value = null; reset() })

async function save() {
  if (!room.value || version.value === null || !changed.value) return
  if (!await p.updateStayPhotoRoom(roomId.value, { details_version: version.value, private_attached_bathroom: draft.value })) return
  reset()
  try {
    const result = await navigateTo(level.to.value!)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The privacy details were saved, but the room could not be opened')
  }
}

onBeforeRouteLeave(() => !p.saving.value)
onBeforeRouteUpdate(() => !p.saving.value)
</script>
