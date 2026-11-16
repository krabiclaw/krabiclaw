<template>
  <DashboardLeafPanel
    id="organization-name"
    title="Brand name"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <p class="mb-2 text-sm font-semibold text-muted">{{ editor.nameCharactersRemaining.value }}/50 available</p>
    <UInput v-model="editor.form.name" maxlength="50" autofocus class="w-full" />
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
    <div v-if="editor.socialCardRefresh.value" class="mt-6 space-y-3" aria-live="polite">
      <UAlert
        v-if="editor.socialCardRefresh.value.status === 'failed'"
        color="error"
        variant="soft"
        title="The name was saved. Social cards still need updating."
        :description="editor.socialCardRefresh.value.error ?? undefined"
      />
      <p v-else class="text-sm text-muted">
        {{ editor.socialCardRefresh.value.status === 'complete' ? 'Social cards are up to date.' : 'Social cards are updating.' }}
      </p>
      <UButton
        v-if="editor.socialCardRefresh.value.status !== 'complete'"
        type="button"
        variant="outline"
        :loading="editor.refreshingSocialCards.value"
        :disabled="editor.saving.value"
        @click="editor.finishSocialCardRefresh"
      >
        {{ editor.socialCardRefresh.value.status === 'failed' ? 'Retry social cards' : 'Finish updating social cards' }}
      </UButton>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
</script>
