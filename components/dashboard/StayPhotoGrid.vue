<template>
  <DashboardIndexPanel id="product-all-photos" :title="title">
    <template #leading><DashboardNavbarLeading :disabled="p.saving.value" /></template>
    <UAlert v-if="props.roomId && !room && p.photoError.value" color="error" variant="soft" :description="p.photoError.value" />
    <DashboardGridEditor
      v-if="!props.roomId || room"
      v-model:selecting="selecting"
      v-model:selected="selectedIds"
      :items="items"
      title="Photos"
      :error="p.loadError.value || p.photoError.value"
      empty-title="Add your first photo"
      empty-icon="i-lucide-image-plus"
      add-label="Add photos"
      manage-label="Manage photos"
      remove-label="Remove selected photos"
      selection-title="Select photos"
      :grid-class="room && level.mode.value === 'pair' ? 'grid grid-cols-2 gap-4' : 'grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'"
      :removing="p.saving.value"
      @remove-many="removePhotos"
    >
      <template #add-action>
        <UButton v-if="room" icon="i-lucide-plus" aria-label="Add photos" color="neutral" variant="soft" square :disabled="p.saving.value" @click="openAdd" />
        <MediaPicker v-else :organization-id="p.organizationId" accept="image" title="Add photos" :disabled="p.saving.value || changed" @change="addPhoto">
          <span class="inline-flex size-10 items-center justify-center rounded-full bg-elevated text-highlighted"><UIcon name="i-lucide-plus" class="size-5" /><span class="sr-only">Add photos</span></span>
        </MediaPicker>
      </template>
      <template #tile="{ item }">
        <img v-if="mediaStillUrl(item.photo)" :src="mediaStillUrl(item.photo) || undefined" :alt="item.photo.alt_text || ''" class="h-full w-full object-cover" loading="lazy">
        <span v-else class="flex h-full w-full items-center justify-center bg-elevated"><UIcon name="i-lucide-image" class="size-8 text-muted" /></span>
        <span v-if="item.cover" class="absolute left-3 top-3 rounded-full bg-default px-3 py-1.5 text-xs font-medium text-highlighted" data-testid="stay-cover-photo">Cover photo</span>
      </template>
      <template v-if="allPhotos" #tile-actions="{ item }">
        <UDropdownMenu :items="photoActions(item.id)" :content="{ align: 'end' }">
          <UButton icon="i-lucide-ellipsis" :aria-label="`Options for ${item.title.toLowerCase()}`" color="neutral" variant="solid" square class="absolute right-3 top-3 rounded-full shadow-sm" :disabled="p.saving.value" />
        </UDropdownMenu>
      </template>
      <template #bulk-actions="{ ids }">
        <UButton icon="i-lucide-folder-input" aria-label="Move selected photos" color="neutral" variant="ghost" square :disabled="p.saving.value || changed" @click="openMove(ids)" />
      </template>
    </DashboardGridEditor>
    <template v-if="room">
      <EditorNavigationList :groups="roomDetails" :active-item="level.child.value" class="mt-8" />
      <UButton label="Delete room or space" color="neutral" variant="link" :disabled="p.saving.value" class="mt-8 px-0 underline" @click="confirmDelete = true" />
    </template>
    <template v-if="changed" #footer>
      <DashboardPanelFooter :loading="p.saving.value" :disabled="p.saving.value || Boolean(p.loadError.value)" @cancel="cancelOrder" @save="saveOrder" />
    </template>
  </DashboardIndexPanel>
  <StayPhotoRoomDialog v-model:open="moving" :photos="moveDraft" @moved="selecting = false" />
  <DashboardListItemDialog v-model:open="adding" :title="`Add photos to ${title}`" save-label="Add photos" :save-disabled="!addSelected.length || p.saving.value" :saving="p.saving.value" :error="p.photoError.value" @save="addExisting">
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-3">
      <button v-for="photo in addCandidates" :key="photo.photo_id" type="button" :aria-label="`Select photo ${savedOrder.indexOf(photo.photo_id) + 1}`" :aria-pressed="addSelected.includes(photo.photo_id)" :disabled="p.saving.value" class="relative aspect-square overflow-hidden rounded-xl border-2" :class="addSelected.includes(photo.photo_id) ? 'border-highlighted' : 'border-transparent'" @click="toggleAdd(photo.photo_id)">
        <img v-if="photo.url" :src="photo.url" alt="" class="size-full object-cover">
        <span class="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full bg-default"><UIcon v-if="addSelected.includes(photo.photo_id)" name="i-lucide-check" class="size-4" /></span>
        <span v-if="photo.room_name" class="absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-sm text-white">{{ photo.room_name }}</span>
      </button>
    </div>
    <MediaPicker :organization-id="p.organizationId" accept="image" title="Add photos" :disabled="p.saving.value" @change="addRoomPhoto">
      <span class="inline-flex h-10 items-center gap-2 rounded-full bg-elevated px-4 font-medium text-highlighted"><UIcon name="i-lucide-image-plus" class="size-4" />Add from media library</span>
    </MediaPicker>
    <template #actions><UButton label="Cancel" color="neutral" variant="ghost" :disabled="p.saving.value" @click="adding = false" /></template>
  </DashboardListItemDialog>
  <DashboardListItemDialog v-model:open="confirmDelete" title="Delete room or space?" :show-actions="false" :saving="p.saving.value" :error="p.photoError.value">
    <p>Delete {{ title }}? Its photos will move to Additional photos and stay on your listing.</p>
    <div class="flex justify-between gap-4">
      <UButton label="Cancel" color="neutral" variant="ghost" :disabled="p.saving.value" @click="confirmDelete = false" />
      <UButton label="Delete room or space" color="error" :loading="p.saving.value" @click="deleteRoom" />
    </div>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardGridEditor from '~/components/dashboard/DashboardGridEditor.vue'
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import StayPhotoRoomDialog from '~/components/dashboard/StayPhotoRoomDialog.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { stayPhotoRoomName } from '~/shared/stay-photos'
import { STAY_AMENITIES } from '~/shared/stay-listing'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ roomId?: string | null }>()
const p = inject(productEditorKey)!
const { t } = useI18n()
const level = useRouteLevel()
const allPhotos = computed(() => props.roomId === undefined)
const room = computed(() => p.photoRooms.value.find(entry => entry.id === props.roomId) ?? null)
const title = computed(() => allPhotos.value ? 'All photos' : props.roomId === null ? 'Additional photos' : room.value ? stayPhotoRoomName(room.value, p.photoRooms.value) : 'Room or space')
const orderDraft = ref<string[] | null>(null)
const selecting = ref(false)
const selectedIds = ref<string[]>([])
const moving = ref(false)
const movePhotoIds = ref<string[]>([])
const moveDraft = computed(() => movePhotoIds.value.map(photo_id => ({ photo_id, expected_room_id: p.photoRooms.value.find(room => room.photo_ids.includes(photo_id))?.id ?? null })))
const adding = ref(false)
const addSelected = ref<string[]>([])
const addCandidates = computed(() => p.photoAssets.value.filter(photo => !room.value?.photo_ids.includes(photo.asset_id)).map((photo) => {
  const owner = p.photoRooms.value.find(entry => entry.photo_ids.includes(photo.asset_id))
  return { photo_id: photo.asset_id, expected_room_id: owner?.id ?? null, room_name: owner ? stayPhotoRoomName(owner, p.photoRooms.value) : null, url: mediaStillUrl(photo) }
}))
watch([addCandidates, () => p.saving.value], ([candidates, saving]) => {
  if (saving || !adding.value || !addSelected.value.length) return
  const selected = addSelected.value
  const candidateIds = new Set(candidates.map(photo => photo.photo_id))
  if (selected.some(id => !candidateIds.has(id) && !room.value?.photo_ids.includes(id))) p.photoError.value = 'A selected photo is no longer on this listing. Review the remaining selection.'
  addSelected.value = selected.filter(id => candidateIds.has(id))
  if (!addSelected.value.length) adding.value = false
})
const confirmDelete = ref(false)
const deleting = ref(false)
const savedOrder = computed(() => p.photoAssets.value.map(photo => photo.asset_id))
const changed = computed(() => orderDraft.value !== null && JSON.stringify(orderDraft.value) !== JSON.stringify(savedOrder.value))
const roomDetails = computed<EditorNavigationGroup[]>(() => {
  const current = room.value
  if (!current) return []
  return [{ id: 'room-details', items: [
    {
      id: 'beds', label: 'Sleeping arrangements',
      summary: current.sleeping_arrangements === null ? 'Add details' : current.sleeping_arrangements.length ? current.sleeping_arrangements.map(bed => t(`stay.bed_types.${bed.type}`, { count: bed.count }, bed.count)).join(', ') : 'No beds in this room',
      placeholder: current.sleeping_arrangements === null,
      to: `${level.path.value}/beds`,
    },
    ...(current.type === 'bedroom' ? [{
      id: 'privacy', label: 'Privacy info',
      summary: current.private_attached_bathroom === null ? 'Add details' : current.private_attached_bathroom ? 'Private attached bathroom' : 'No private attached bathroom',
      placeholder: current.private_attached_bathroom === null,
      to: `${level.path.value}/privacy`,
    }] : []),
    {
      id: 'amenities', label: 'Amenities',
      summary: current.amenities.length ? current.amenities.map(code => STAY_AMENITIES[code].label).join(', ') : 'Add amenities',
      placeholder: current.amenities.length === 0,
      to: `${level.path.value}/amenities`,
    },
  ] }]
})
const items = computed(() => {
  if (props.roomId && !room.value) return []
  const order = orderDraft.value ?? savedOrder.value
  // A failed write can reveal a concurrent upload. Keep that real photo
  // visible, while retaining the submitted order until Save or Cancel.
  const ids = [...order.filter(id => savedOrder.value.includes(id)), ...savedOrder.value.filter(id => !order.includes(id))]
  const assigned = new Set(p.photoRooms.value.flatMap(entry => entry.photo_ids))
  return ids.filter(id => allPhotos.value || (room.value ? room.value.photo_ids.includes(id) : !assigned.has(id))).map(id => ({
    id,
    title: `Photo ${ids.indexOf(id) + 1}`,
    to: p.sectionPath(`photo/photos/${encodeURIComponent(id)}`),
    photo: p.photoAssets.value.find(photo => photo.asset_id === id)!,
    cover: changed.value ? ids[0] === id : p.product.value?.image?.asset_id === id,
  }))
})

function movePhoto(id: string, direction: -1 | 1) {
  if (p.saving.value) return
  const order = [...(orderDraft.value ?? savedOrder.value)]
  const from = order.indexOf(id)
  const to = from + direction
  if (from < 0 || to < 0 || to >= order.length) return
  order.splice(from, 1)
  order.splice(to, 0, id)
  orderDraft.value = order
}

function photoActions(id: string) {
  const index = items.value.findIndex(item => item.id === id)
  return [
    { label: 'Move backward', icon: 'i-lucide-arrow-left', disabled: index === 0, onSelect: () => movePhoto(id, -1) },
    { label: 'Move forward', icon: 'i-lucide-arrow-right', disabled: index === items.value.length - 1, onSelect: () => movePhoto(id, 1) },
  ]
}

function cancelOrder() {
  orderDraft.value = null
  p.photoError.value = null
}

async function saveOrder() {
  if (orderDraft.value && await p.reorderStayPhotos([...orderDraft.value])) orderDraft.value = null
}

async function addPhoto(asset: { asset_id: string } | null) {
  if (asset) await p.addStayPhoto(asset.asset_id)
}

async function removePhotos(ids: string[]) {
  if (await p.removeStayPhotos(ids)) {
    selecting.value = false
    orderDraft.value = null
  }
}

function openMove(ids: string[]) {
  movePhotoIds.value = ids
  moving.value = true
}

function openAdd() {
  addSelected.value = []
  p.photoError.value = null
  adding.value = true
}

function toggleAdd(id: string) {
  addSelected.value = addSelected.value.includes(id) ? addSelected.value.filter(entry => entry !== id) : [...addSelected.value, id]
}

async function addExisting() {
  if (!room.value) return
  const photos = addCandidates.value.filter(photo => addSelected.value.includes(photo.photo_id)).map(({ photo_id, expected_room_id }) => ({ photo_id, expected_room_id }))
  if (await p.moveStayPhotos(photos, { room_id: room.value.id })) adding.value = false
}

async function addRoomPhoto(asset: { asset_id: string } | null) {
  if (!asset || !room.value) return
  const roomId = room.value.id
  if (p.photoAssets.value.some(photo => photo.asset_id === asset.asset_id)) {
    const owner = p.photoRooms.value.find(entry => entry.photo_ids.includes(asset.asset_id))
    if (await p.moveStayPhotos([{ photo_id: asset.asset_id, expected_room_id: owner?.id ?? null }], { room_id: roomId })) adding.value = false
  } else if (await p.addStayPhoto(asset.asset_id, roomId)) adding.value = false
}

async function deleteRoom() {
  if (!room.value) return
  deleting.value = true
  try {
    if (!await p.deleteStayPhotoRoom(room.value.id)) return
    confirmDelete.value = false
    const result = await navigateTo(level.to.value!)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The room was deleted, but the photo tour could not be opened')
  } finally {
    deleting.value = false
  }
}

watchEffect(() => {
  if (props.roomId && p.product.value && !p.loadError.value && !p.saving.value && !deleting.value && !p.photoError.value && !room.value) showError(createError({ statusCode: 404, statusMessage: 'Room or space not found' }))
})

onBeforeRouteLeave(() => {
  if (p.saving.value) return false
  orderDraft.value = null
})
onBeforeRouteUpdate((to, from) => {
  if (!p.saving.value && to.path !== from.path) orderDraft.value = null
})
</script>
