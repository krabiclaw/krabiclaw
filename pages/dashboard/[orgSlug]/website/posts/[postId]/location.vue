<template>
  <DashboardLeafPanel
    id="post-location"
    :title="post.sectionLabels.value.location"
    lead="Choose the location this post is about, or the whole website."
    :saving="post.editor.saving.value"
    :disabled="post.saveDisabled.value"
    :save-label="post.saveLabel.value"
    :error="post.loadError.value || post.editor.error.value || ''"
    @cancel="post.revert"
    @save="post.save"
  >
    <URadioGroup v-model="choice" :items="items" variant="card" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { postEditorKey } from '~/components/dashboard/PostEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const post = inject(postEditorKey)!
const WHOLE_WEBSITE = 'whole-website'
const items = computed(() => [
  { value: WHOLE_WEBSITE, label: 'Whole website' },
  ...post.organizationLocations.value.map(location => ({ value: location.id, label: location.title })),
])
const choice = computed({
  get: () => post.editor.form.location_id ?? WHOLE_WEBSITE,
  set: (value: string) => { post.editor.form.location_id = value === WHOLE_WEBSITE ? null : value },
})
</script>
