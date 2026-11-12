<template>
  <DashboardLeafPanel
    id="organization-announcement-visibility"
    title="Show announcement"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? editor.validationMessage.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="space-y-6">
      <SettingRow
        v-model="editor.form.announcementEnabled"
        label="Show announcement"
        description="An alert shown to visitors on your website."
      />

      <template v-if="editor.form.announcementEnabled">
        <UFormField label="Display format">
          <URadioGroup
            v-model="editor.form.announcementFormat"
            :items="formatItems"
            variant="card"
            class="w-full"
          />
        </UFormField>

        <SettingRow
          v-model="editor.form.announcementDismissible"
          label="Stay closed once a visitor closes it"
          :description="editor.form.announcementFormat === 'banner' ? 'Whether visitors can close the banner. Turn off to keep it permanently visible.' : 'Whether a visitor who closes it will not be shown it again on that device.'"
        />
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!

const formatItems = [
  {
    value: 'banner',
    label: 'Top banner',
    description: 'A bar across the top of your website.',
  },
  {
    value: 'modal',
    label: 'Popup modal',
    description: 'A centered dialog over page content.',
  },
]
</script>
