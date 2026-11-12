<template>
  <DashboardIndexPanel id="product-check-in-method" title="Check-in method" column="leaf">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="router.resolve({ path: level.path.value, query: route.query }).fullPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.arrivalError.value || p.saveError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.arrivalError.value || p.saveError.value || ''" />
    <div v-if="p.arrivalHome.value && !p.arrivalError.value" class="space-y-12">
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          <h2 class="text-lg font-medium text-highlighted">{{ method?.label || 'How will guests get inside?' }}</h2>
          <p v-if="method" class="mt-2 text-base text-muted">{{ method.description }}</p>
        </div>
        <UButton :to="p.sectionPath('check-in-method/method')" :label="method ? 'Edit' : 'Add'" aria-label="Choose check-in method" color="neutral" variant="link" :disabled="p.saving.value || !p.arrivalManage.value" class="shrink-0 underline" />
      </div>
      <div class="flex items-start gap-6">
        <div class="min-w-0 flex-1">
          <h2 class="text-lg font-medium text-highlighted">Check-in instructions</h2>
          <p v-if="p.arrivalHome.value.check_in_instructions" class="mt-2 whitespace-pre-line break-words text-base text-muted">{{ p.arrivalHome.value.check_in_instructions }}</p>
          <p v-else class="mt-2 text-base text-muted">Add the details guests need to get inside.</p>
        </div>
        <UButton :to="p.sectionPath('check-in-method/instructions')" :label="p.arrivalHome.value.check_in_instructions ? 'Edit' : 'Add'" aria-label="Edit check-in instructions" color="neutral" variant="link" :disabled="p.saving.value || !p.arrivalManage.value" class="shrink-0 underline" />
      </div>
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CHECK_IN_METHODS } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const method = computed(() => p.arrivalHome.value?.check_in_method ? STAY_CHECK_IN_METHODS[p.arrivalHome.value.check_in_method] : null)
</script>
