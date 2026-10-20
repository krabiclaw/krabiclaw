<template>
  <DashboardLeafPanel
    id="post-action"
    :title="post.sectionLabels.value.action"
    lead="An optional button under the post. Facebook, Instagram and Discord get it as a line under the caption."
    :saving="post.editor.saving.value"
    :disabled="post.saveDisabled.value"
    :save-label="post.saveLabel.value"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="post.save"
  >
    <div class="space-y-6">
      <UFormField label="Button label" hint="Optional">
        <UInput :model-value="action.label" placeholder="Book a table" class="w-full" :maxlength="60" @update:model-value="write('label', String($event))" />
      </UFormField>
      <UFormField label="Where it goes" hint="Optional">
        <UInput :model-value="action.url" placeholder="https:// or tel:+66…" class="w-full" @update:model-value="write('url', String($event))" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
const action = computed(() => post.editor.form.callToAction ?? { label: '', url: '' })
/** Both halves empty is no button at all. */
function write(field: 'label' | 'url', value: string) {
  const next = { ...action.value, [field]: value }
  post.editor.form.callToAction = next.label.trim() || next.url.trim() ? next : null
}
</script>
