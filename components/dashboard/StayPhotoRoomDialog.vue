<template>
  <DashboardListItemDialog v-model:open="open" :title="moving ? 'Move photos' : 'Choose a room or space'" :save-label="moving ? 'Move' : 'Add'" :saving="p.saving.value" :save-disabled="!choice || unchanged || p.saving.value || Boolean(p.loadError.value)" :error="p.photoError.value" @save="save">
    <template v-if="moving">
      <h2 class="text-xl font-medium text-highlighted">Choose a room or space</h2>
      <URadioGroup v-model="choice" :items="destinations" variant="card" indicator="hidden" color="neutral" :disabled="p.saving.value" aria-label="Choose a room or space" :ui="tileUi">
        <template #label="{ item }">
          <span class="flex aspect-square items-center justify-center overflow-hidden rounded-xl bg-elevated">
            <img v-if="item.url" :src="item.url" alt="" class="size-full object-cover">
            <UIcon v-else :name="item.pictogram" class="size-12 text-muted" />
          </span>
          <span class="mt-3 block font-medium">{{ item.label }}</span>
          <span class="mt-1 block text-sm font-normal text-muted">{{ item.count ? `${item.count} ${item.count === 1 ? 'photo' : 'photos'}` : 'Add photos' }}</span>
        </template>
      </URadioGroup>
      <h2 class="pt-4 text-xl font-medium text-highlighted">Add a new room or space</h2>
    </template>
    <UInput v-model="search" icon="i-lucide-search" placeholder="Search rooms and spaces" aria-label="Search rooms and spaces" class="w-full" :disabled="p.saving.value" />
    <URadioGroup v-model="choice" :items="types" variant="card" indicator="hidden" color="neutral" :disabled="p.saving.value" :aria-label="moving ? 'Add a new room or space' : 'Room or space type'" :ui="tileUi">
      <template #label="{ item }">
        <span class="flex aspect-square items-center justify-center rounded-xl bg-elevated"><UIcon :name="item.pictogram" class="size-12 text-highlighted" /></span>
        <span class="mt-3 block font-medium"><span v-if="moving" class="sr-only">Add new </span>{{ item.label }}</span>
      </template>
    </URadioGroup>
    <p v-if="!types.length" role="status" class="text-muted">No matching rooms or spaces.</p>
    <template #actions><UButton label="Cancel" color="neutral" variant="ghost" :disabled="p.saving.value" @click="open = false" /></template>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { STAY_PHOTO_ROOM_TYPES, isStayPhotoRoomType, stayPhotoRoomName, type StayPhotoRoom } from '~/shared/stay-photos'
import { mediaStillUrl } from '~/shared/media-placement-contract'

const props = defineProps<{ photos?: Array<{ photo_id: string; expected_room_id: string | null }> }>()
const emit = defineEmits<{ created: [room: StayPhotoRoom]; moved: [] }>()
const open = defineModel<boolean>('open', { default: false })
const p = inject(productEditorKey)!
const choice = ref<string>()
const search = ref('')
const moving = computed(() => props.photos !== undefined)
const tileUi = { fieldset: 'grid grid-cols-2 gap-4 sm:grid-cols-3', item: 'block min-w-0 rounded-2xl p-2', wrapper: 'w-full', label: 'block w-full' }
const types = computed(() => Object.entries(STAY_PHOTO_ROOM_TYPES)
  .filter(([, type]) => type.label.toLowerCase().includes(search.value.trim().toLowerCase()))
  .map(([key, type]) => ({ value: `type:${key}`, label: type.label, pictogram: type.icon })))
const destinations = computed(() => {
  const assigned = new Set(p.photoRooms.value.flatMap(room => room.photo_ids))
  const additional = p.photoAssets.value.filter(photo => !assigned.has(photo.asset_id))
  return [
    ...p.photoRooms.value.map(room => ({ value: `room:${room.id}`, label: stayPhotoRoomName(room, p.photoRooms.value), pictogram: STAY_PHOTO_ROOM_TYPES[room.type].icon, count: room.photo_ids.length, url: firstPhoto(room.photo_ids) })),
    { value: 'additional', label: 'Additional photos', pictogram: 'i-lucide-images', count: additional.length, url: mediaStillUrl(additional[0]) },
  ]
})
const unchanged = computed(() => moving.value && props.photos!.every(photo => photo.expected_room_id === (choice.value === 'additional' ? null : choice.value?.startsWith('room:') ? choice.value.slice(5) : undefined)))

function firstPhoto(ids: string[]) {
  const photo = p.photoAssets.value.find(entry => ids.includes(entry.asset_id))
  return photo ? mediaStillUrl(photo) : null
}

watch(open, (value) => {
  if (!value) return
  search.value = ''
  p.photoError.value = null
  const first = props.photos?.[0]?.expected_room_id
  choice.value = props.photos?.every(photo => photo.expected_room_id === first) ? (first ? `room:${first}` : 'additional') : undefined
})

async function save() {
  if (!choice.value || unchanged.value || p.saving.value) return
  if (choice.value.startsWith('type:')) {
    const type = choice.value.slice(5)
    if (!isStayPhotoRoomType(type)) return
    if (moving.value) {
      if (!await p.moveStayPhotos(props.photos!, { new_room_type: type })) return
      emit('moved')
    } else {
      const room = await p.createStayPhotoRoom(type)
      if (!room) return
      emit('created', room)
    }
  } else if (moving.value) {
    if (!await p.moveStayPhotos(props.photos!, { room_id: choice.value === 'additional' ? null : choice.value.slice(5) })) return
    emit('moved')
  } else return
  open.value = false
}
</script>
