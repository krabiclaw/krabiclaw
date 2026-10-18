<template>
  <DashboardIndexPanel id="product-all-photos" title="All photos">
    <template #leading><DashboardNavbarLeading :disabled="p.saving.value" /></template>
    <DashboardGridEditor
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
      grid-class="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
      :removing="p.saving.value"
      @remove-many="removePhotos"
    >
      <template #add-action>
        <MediaPicker :organization-id="p.organizationId" accept="image" title="Add photos" :disabled="p.saving.value || changed" @change="addPhoto">
          <span class="inline-flex size-10 items-center justify-center rounded-full bg-elevated text-highlighted"><UIcon name="i-lucide-plus" class="size-5" /><span class="sr-only">Add photos</span></span>
        </MediaPicker>
      </template>
      <template #tile="{ item }">
        <img v-if="mediaStillUrl(item.photo)" :src="mediaStillUrl(item.photo) || undefined" :alt="item.photo.alt_text || ''" class="h-full w-full object-cover" loading="lazy">
        <span v-else class="flex h-full w-full items-center justify-center bg-elevated"><UIcon name="i-lucide-image" class="size-8 text-muted" /></span>
        <span v-if="item.cover" class="absolute left-3 top-3 rounded-full bg-default px-3 py-1.5 text-xs font-medium text-highlighted" data-testid="stay-cover-photo">Cover photo</span>
      </template>
      <template #tile-actions="{ item }">
        <UDropdownMenu :items="photoActions(item.id)" :content="{ align: 'end' }">
          <UButton icon="i-lucide-ellipsis" :aria-label="`Options for ${item.title.toLowerCase()}`" color="neutral" variant="solid" square class="absolute right-3 top-3 rounded-full shadow-sm" :disabled="p.saving.value" />
        </UDropdownMenu>
      </template>
    </DashboardGridEditor>
    <template v-if="changed" #footer>
      <DashboardPanelFooter :loading="p.saving.value" :disabled="p.saving.value || Boolean(p.loadError.value)" @cancel="cancelOrder" @save="saveOrder" />
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardGridEditor from '~/components/dashboard/DashboardGridEditor.vue'
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { mediaStillUrl } from '~/shared/media-placement-contract'

definePageMeta({ layout: 'dashboard', dashboardFrame: true })

const p = inject(productEditorKey)!
const orderDraft = ref<string[] | null>(null)
const selecting = ref(false)
const selectedIds = ref<string[]>([])
const savedOrder = computed(() => p.photoAssets.value.map(photo => photo.asset_id))
const changed = computed(() => orderDraft.value !== null && JSON.stringify(orderDraft.value) !== JSON.stringify(savedOrder.value))
const items = computed(() => {
  const order = orderDraft.value ?? savedOrder.value
  // A failed write can reveal a concurrent upload. Keep that real photo
  // visible, while retaining the submitted order until Save or Cancel.
  const ids = [...order.filter(id => savedOrder.value.includes(id)), ...savedOrder.value.filter(id => !order.includes(id))]
  return ids.map((id, index) => ({
    id,
    title: `Photo ${index + 1}`,
    to: p.sectionPath(`photo/photos/${encodeURIComponent(id)}`),
    photo: p.photoAssets.value.find(photo => photo.asset_id === id)!,
    cover: changed.value ? index === 0 : p.product.value?.image?.asset_id === id,
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

onBeforeRouteLeave(() => { orderDraft.value = null })
onBeforeRouteUpdate((to, from) => {
  if (!p.saving.value && to.path !== from.path) orderDraft.value = null
})
</script>
