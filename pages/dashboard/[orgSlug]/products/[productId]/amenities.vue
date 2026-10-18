<template>
  <DashboardIndexPanel
    id="product-amenities"
    :title="p.sectionLabels.amenities"
    lead="You’ve added these to your listing so far."
    column="leaf"
    :paired-size="63"
  >
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading
        :to="router.resolve({ path: level.path.value, query: route.query }).fullPath"
        :disabled="p.saving.value"
      />
    </template>
    <UAlert
      v-if="p.loadError.value || p.saveError.value"
      class="mb-6"
      color="error"
      variant="soft"
      icon="i-lucide-triangle-alert"
      :description="p.loadError.value || p.saveError.value || ''"
    />
    <DashboardListEditor
      v-if="p.product.value && !p.loadError.value"
      :editing="editing"
      :items="selectedAmenities"
      title="Amenities"
      empty-title="No amenities added yet"
      empty-icon="i-lucide-house"
      add-label="Add amenity"
      :add-to="p.sectionPath('amenities/add')"
      :addable="!editing"
      :disabled="p.saving.value"
      :aria-busy="p.saving.value"
      class="[&_ul]:border-0 [&_ul]:divide-y-0 [&_li]:gap-5 [&_li]:py-7"
      @update:editing="setEditing"
      @remove="removeAmenity"
    >
      <template v-if="editing" #actions>
        <UButton label="Cancel" color="neutral" variant="soft" :disabled="p.saving.value" @click="cancelEditing" />
      </template>
      <template #item="{ item }">
        <div class="flex items-center gap-5">
          <UIcon v-if="!editing" :name="item.icon" class="size-7 shrink-0 text-highlighted" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="text-base text-highlighted">{{ item.title }}</p>
            <p v-if="item.description" class="mt-1 text-sm text-muted">{{ item.description }}</p>
          </div>
        </div>
      </template>
    </DashboardListEditor>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_AMENITIES, type StayAmenity } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()
const editing = ref(false)
const selectedAmenities = computed(() => p.form.stay_amenities.map((code) => {
  const amenity = STAY_AMENITIES[code]
  return { id: code, title: amenity.label, icon: amenity.icon, description: 'description' in amenity ? amenity.description : undefined }
}).sort((left, right) => left.title.localeCompare(right.title)))

async function setEditing(value: boolean) {
  if (p.saving.value) return
  if (value) {
    editing.value = true
    return
  }
  await p.save(router.resolve({ path: level.path.value, query: route.query }).fullPath)
  if (!p.saveError.value) editing.value = false
}

function removeAmenity(item: { id: StayAmenity }) {
  if (p.saving.value) return
  p.form.stay_amenities = p.form.stay_amenities.filter(code => code !== item.id)
}

function cancelEditing() {
  p.revert()
  editing.value = false
}

// The parent product keeps the draft while the picker is open. Leaving this
// concern discards it, including a browser Back during inline removal.
onBeforeRouteLeave(() => { p.revert() })
</script>
