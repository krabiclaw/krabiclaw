<template>
  <DashboardIndexPanel id="product-room-accessibility" title="Accessibility features" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.loadError.value || p.photoError.value" class="mb-6" color="error" variant="soft" :description="p.loadError.value || p.photoError.value || ''" />
    <EditorNavigationList v-if="room" :groups="groups" :active-item="level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_ROOM_ACCESSIBILITY_FEATURES } from '~/shared/stay-accessibility'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const room = computed(() => p.photoRooms.value.find(entry => entry.id === route.params.roomId))
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'room-accessibility', items: (room.value?.accessibility ?? []).map(answer => ({
  id: answer.feature,
  label: STAY_ROOM_ACCESSIBILITY_FEATURES[answer.feature].label,
  summary: answer.available === null ? 'Add details' : answer.available ? `${answer.photo_ids.length} ${answer.photo_ids.length === 1 ? 'photo' : 'photos'}` : 'Not available',
  placeholder: answer.available === null,
  to: `${level.path.value}/${answer.feature}`,
})) }])
watch(room, () => {
  if (room.value && room.value.type !== 'bedroom') showError(createError({ statusCode: 404, statusMessage: 'Bedroom not found' }))
}, { immediate: true })
</script>
