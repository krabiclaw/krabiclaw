<template>
  <DashboardIndexPanel id="product-checkout-instructions" title="Checkout instructions" lead="Explain what’s essential for guests to do before they leave." column="leaf" :paired-size="63">
    <template v-if="level.child.value" #leading>
      <DashboardNavbarLeading :to="overviewPath" :disabled="p.saving.value" />
    </template>
    <UAlert v-if="p.arrivalError.value || p.saveError.value" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="p.arrivalError.value || p.saveError.value || ''" />
    <template v-if="p.arrivalDraft.value && !p.arrivalError.value">
      <DashboardListEditor
        v-if="instructions.length || editing"
        :editing="editing"
        :items="instructions"
        title="Checkout instructions"
        empty-title="No checkout instructions added yet"
        empty-icon="i-lucide-list-checks"
        add-label="Add instructions"
        :add-to="p.sectionPath('checkout-instructions/add')"
        :addable="!editing && instructions.length < taskCount"
        :disabled="p.saving.value"
        :read-only="!p.arrivalManage.value"
        class="[&_ul]:border-0 [&_ul]:divide-y-0 [&_li]:py-6"
        @update:editing="setEditing"
        @remove="remove"
      >
        <template v-if="editing" #actions><UButton label="Cancel" color="neutral" variant="soft" :disabled="p.saving.value" @click="cancelEditing" /></template>
        <template #item="{ item }">
          <div class="flex gap-5">
            <UIcon v-if="!editing" :name="item.icon" class="mt-0.5 size-7 shrink-0 text-highlighted" aria-hidden="true" />
            <div><p class="text-base font-medium text-highlighted">{{ item.title }}</p><p v-if="item.summary" class="mt-2 whitespace-pre-line break-words text-base text-muted">{{ item.summary }}</p></div>
          </div>
        </template>
      </DashboardListEditor>
      <UButton v-else-if="p.arrivalManage.value" :to="p.sectionPath('checkout-instructions/add')" label="Add instructions" icon="i-lucide-plus" color="neutral" variant="outline" class="w-full justify-center rounded-xl py-4" />
      <p v-else class="text-base text-muted">No checkout instructions added yet.</p>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { STAY_CHECKOUT_TASKS, type StayCheckoutTask } from '~/shared/stay-listing'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const router = useRouter()
const editing = ref(false)
const taskCount = Object.keys(STAY_CHECKOUT_TASKS).length
const overviewPath = computed(() => router.resolve({ path: level.path.value, query: route.query }).fullPath)
const instructions = computed(() => p.arrivalDraft.value?.checkout_instructions.map(instruction => ({ id: instruction.task, title: STAY_CHECKOUT_TASKS[instruction.task].label, icon: STAY_CHECKOUT_TASKS[instruction.task].icon, summary: instruction.details, to: editing.value ? undefined : p.sectionPath(`checkout-instructions/${instruction.task}`) })) ?? [])
async function setEditing(value: boolean) {
  if (p.saving.value) return
  if (value) { editing.value = true; return }
  if (p.arrivalChanged(['checkout_instructions'])) await p.saveArrival(['checkout_instructions'], overviewPath.value)
  if (!p.saveError.value) editing.value = false
}
function remove(item: { id: StayCheckoutTask }) {
  if (!p.saving.value && p.arrivalDraft.value) p.arrivalDraft.value.checkout_instructions = p.arrivalDraft.value.checkout_instructions.filter(instruction => instruction.task !== item.id)
}
function cancelEditing() { p.revert(); editing.value = false }
onBeforeRouteLeave(() => p.revert())
</script>
