<template>
  <DashboardLeafPanel
    id="organization-status"
    title="Status"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value || suspended"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <!--
      Whether the website is public. Search engines follow from this: a Live
      site is indexed and a Draft one is not, so there is no second switch.
    -->
    <UAlert v-if="suspended" color="error" variant="soft" icon="i-lucide-lock" title="Suspended" description="KrabiClaw has suspended this website. Contact support to restore it." />
    <URadioGroup v-else v-model="editor.form.status" :items="items" variant="card" />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const suspended = computed(() => editor.form.status === 'suspended')
const items = [
  { value: 'active', label: 'Published', description: 'Anyone can visit the website, and search engines can list it.' },
  { value: 'inactive', label: 'Draft', description: 'Only people with a preview link can see it. Search engines cannot.' },
]
</script>
