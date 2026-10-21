<template>
  <DashboardLeafPanel
    id="product-room-beds"
    title="Sleeping arrangements"
    :lead="lead"
    :saving="p.saving.value"
    :disabled="!room || !changed || invalid || overCapacity || Boolean(p.loadError.value)"
    :error="p.loadError.value || p.photoError.value || (invalid ? 'Choose a whole number for each bed type.' : '')"
    desktop-cancel
    @cancel="reset"
    @save="save"
  >
    <template #right>
      <UButton label="Clear details" color="neutral" variant="ghost" :disabled="p.saving.value || draft === null" @click="clear" />
    </template>
    <template v-if="room">
      <UButton :to="p.sectionPath('rooms')" label="Edit listing bed count" color="neutral" variant="link" :disabled="p.saving.value" class="mb-6 px-0 underline" />
      <div v-if="draft === null" class="mb-6 space-y-3">
        <p class="text-sm text-muted" role="status">Sleeping arrangements aren’t specified.</p>
        <UButton label="No beds in this room" color="neutral" variant="soft" :disabled="p.saving.value" @click="noBeds" />
      </div>
      <UAlert v-if="overCapacity" color="error" variant="soft" description="These beds exceed the listing’s total. Update the listing bed count or remove beds from a room." class="mb-6" />
      <UButton v-if="p.photoError.value" label="Use saved details" color="neutral" variant="soft" :disabled="p.saving.value || Boolean(p.loadError.value)" class="mb-6" @click="reset" />
      <div class="divide-y divide-default">
        <div v-for="bed in bedTypes" :key="bed.type" class="flex items-center justify-between gap-6 py-6">
          <label :for="`stay-room-bed-${bed.type}`" class="text-base text-highlighted">{{ bed.label }}</label>
          <UInputNumber
            :id="`stay-room-bed-${bed.type}`"
            :model-value="quantity(bed.type)"
            :aria-label="bed.label"
            :min="0"
            :max="maximum(bed.type)"
            :step="1"
            :disabled="p.saving.value"
            :increment="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            :decrement="{ color: 'neutral', variant: 'outline', class: 'rounded-full' }"
            variant="none"
            class="w-36 shrink-0"
            @update:model-value="setQuantity(bed.type, $event)"
          />
        </div>
      </div>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { MAX_STAY_BEDS_PER_TYPE, STAY_BED_TYPES, type StayBedType, type StaySleepingArrangement } from '~/shared/stay-photos'
import { isNavigationFailure } from 'vue-router'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const roomId = computed(() => String(route.params.roomId))
const room = computed(() => p.photoRooms.value.find(entry => entry.id === roomId.value))
const bedTypes = Object.entries(STAY_BED_TYPES).map(([type, bed]) => ({ type: type as StayBedType, label: bed.label }))
const draft = ref<StaySleepingArrangement[] | null>(null)
const original = ref<StaySleepingArrangement[] | null>(null)
const version = ref<number | null>(null)
const invalidTypes = ref(new Set<StayBedType>())
const invalid = computed(() => invalidTypes.value.size > 0)
const totalBeds = computed(() => p.product.value?.stay?.beds ?? null)
const elsewhere = computed(() => p.photoRooms.value.filter(entry => entry.id !== roomId.value).reduce((sum, entry) => sum + (entry.sleeping_arrangements ?? []).reduce((count, bed) => count + bed.count, 0), 0))
const available = computed(() => totalBeds.value === null ? 0 : Math.max(0, totalBeds.value - elsewhere.value))
const assigned = computed(() => (draft.value ?? []).reduce((sum, bed) => sum + bed.count, 0))
const overCapacity = computed(() => assigned.value > available.value)
const changed = computed(() => JSON.stringify(draft.value) !== JSON.stringify(original.value))
const lead = computed(() => totalBeds.value === null
  ? 'Choose the type of beds in this room. Set the listing’s total bed count before adding beds.'
  : `Choose the type of beds in this room. ${available.value} of the listing’s ${totalBeds.value} beds are available to assign here.`)

function quantity(type: StayBedType) {
  return draft.value?.find(bed => bed.type === type)?.count ?? 0
}

function maximum(type: StayBedType) {
  return Math.min(MAX_STAY_BEDS_PER_TYPE, Math.max(quantity(type), available.value - assigned.value + quantity(type)))
}

function clear() {
  draft.value = null
  invalidTypes.value.clear()
}

function noBeds() {
  draft.value = []
  invalidTypes.value.clear()
}

function setQuantity(type: StayBedType, count: number | null | undefined) {
  if (count == null || !Number.isInteger(count) || count < 0 || count > MAX_STAY_BEDS_PER_TYPE) {
    invalidTypes.value.add(type)
    return
  }
  invalidTypes.value.delete(type)
  const next = [...(draft.value ?? []).filter(bed => bed.type !== type)]
  if (count > 0) next.push({ type, count })
  draft.value = bedTypes.flatMap(bed => next.filter(entry => entry.type === bed.type))
}

function reset() {
  if (!room.value) return
  original.value = room.value.sleeping_arrangements?.map(bed => ({ ...bed })) ?? null
  draft.value = original.value?.map(bed => ({ ...bed })) ?? null
  version.value = room.value.details_version
  invalidTypes.value.clear()
  p.photoError.value = null
}

watch(room, () => { if (version.value === null && room.value) reset() }, { immediate: true })
watch(roomId, () => { version.value = null; reset() })

async function save() {
  if (!room.value || version.value === null || !changed.value || invalid.value || overCapacity.value) return
  if (!await p.updateStayPhotoRoom(roomId.value, { details_version: version.value, sleeping_arrangements: draft.value })) return
  reset()
  try {
    const result = await navigateTo(level.to.value!)
    if (isNavigationFailure(result)) throw result
  } catch (error) {
    p.photoError.value = getErrorMessage(error, 'The sleeping arrangements were saved, but the room could not be opened')
  }
}

onBeforeRouteLeave(() => !p.saving.value)
onBeforeRouteUpdate(() => !p.saving.value)
</script>
