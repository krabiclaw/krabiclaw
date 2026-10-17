<template>
  <DashboardLeafPanel
    id="review-visibility"
    title="Status"
    lead="A published review appears on your site. A draft review is hidden."
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.errorMessage.value"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <URadioGroup v-model="editor.form.status" :items="REVIEW_VISIBILITY_ITEMS" variant="card" class="w-full" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { reviewEditorKey } from '~/components/dashboard/ReviewEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const REVIEW_VISIBILITY_ITEMS = [
  { label: 'Published', value: 'approved', description: 'Shown on your site.' },
  { label: 'Draft', value: 'rejected', description: 'Hidden from your site.' },
]

const editor = inject(reviewEditorKey)!
</script>
