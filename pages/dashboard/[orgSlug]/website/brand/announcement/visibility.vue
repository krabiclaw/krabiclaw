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
    <SettingRow
      v-model="editor.form.announcementEnabled"
      label="Show announcement"
      description="An alert shown to visitors on your website."
    >
      <div class="space-y-6 pt-2">
        <div class="space-y-2">
          <label class="block text-sm font-medium text-highlighted">Display format</label>
          <div class="grid grid-cols-2 gap-3">
            <button
              type="button"
              class="flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition"
              :class="editor.form.announcementFormat === 'banner' ? 'border-primary bg-primary/10 text-primary' : 'border-default bg-elevated text-highlighted hover:bg-muted'"
              @click="editor.form.announcementFormat = 'banner'"
            >
              <span class="text-sm font-semibold">Top banner</span>
              <span class="text-xs text-muted">A bar across the top of your website.</span>
            </button>
            <button
              type="button"
              class="flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition"
              :class="editor.form.announcementFormat !== 'banner' ? 'border-primary bg-primary/10 text-primary' : 'border-default bg-elevated text-highlighted hover:bg-muted'"
              @click="editor.form.announcementFormat = 'modal'"
            >
              <span class="text-sm font-semibold">Popup modal</span>
              <span class="text-xs text-muted">A centered dialog over page content.</span>
            </button>
          </div>
        </div>

        <SettingRow
          v-model="editor.form.announcementDismissible"
          label="Stay closed once a visitor closes it"
          :description="editor.form.announcementFormat === 'banner' ? 'Whether visitors can close the banner. Turn off to keep it permanently visible.' : 'Whether a visitor who closes it will not be shown it again on that device.'"
        />
      </div>
    </SettingRow>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
</script>
