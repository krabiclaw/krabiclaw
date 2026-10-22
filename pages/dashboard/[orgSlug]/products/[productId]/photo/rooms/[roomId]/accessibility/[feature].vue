<template>
  <StayAccessibilityFeatureEditor
    panel-id="product-room-accessibility-feature"
    :context-key="`${String(route.params.roomId)}:${feature}`"
    :context-label="roomName"
    :organization-id="p.organizationId"
    :definition="definition"
    :answer="answer"
    :snapshot-token="room?.details_version ?? null"
    :photos="p.photoAssets.value"
    :saving="p.saving.value"
    :load-error="p.loadError.value"
    :error="p.photoError.value"
    :close-to="level.to.value ?? undefined"
    :commit="commit"
    @reset-error="p.photoError.value = null"
  />
</template>

<script setup lang="ts">
import StayAccessibilityFeatureEditor from '~/components/dashboard/StayAccessibilityFeatureEditor.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { stayPhotoRoomName } from '~/shared/stay-photos'
import { STAY_ROOM_ACCESSIBILITY_FEATURES, isStayRoomAccessibilityFeature } from '~/shared/stay-accessibility'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const feature = computed(() => {
  if (!isStayRoomAccessibilityFeature(route.params.feature)) throw createError({ statusCode: 404, statusMessage: 'Accessibility feature not found' })
  return route.params.feature
})
const definition = computed(() => STAY_ROOM_ACCESSIBILITY_FEATURES[feature.value])
const room = computed(() => p.photoRooms.value.find(entry => entry.id === route.params.roomId))
const roomName = computed(() => room.value ? stayPhotoRoomName(room.value, p.photoRooms.value) : '')
const answer = computed(() => {
  if (!room.value || room.value.type !== 'bedroom') return null
  const saved = room.value.accessibility.find(answer => answer.feature === feature.value)
  if (!saved) throw createError({ statusCode: 500, statusMessage: 'The bedroom accessibility details could not be read' })
  return saved
})
async function commit(value: { available: boolean | null; photo_ids: string[] }, token: string | number) {
  if (!room.value || typeof token !== 'number') throw new Error('The room version could not be read')
  return await p.updateStayPhotoRoom(room.value.id, { details_version: token, accessibility: { feature: feature.value, ...value } })
}
watchEffect(() => {
  if (room.value && room.value.type !== 'bedroom') showNotFound()
})
</script>
