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
    <!-- Centered 3D storefront illustration (Airbnb parity) -->
    <div class="flex justify-center my-6">
      <img
        src="/images/website/storefront.webp"
        alt=""
        class="size-40 sm:size-48 object-contain"
        decoding="async"
      />
    </div>

    <!--
      Whether the website is public. Search engines follow from this: a Live
      site is indexed and a Draft one is not, so there is no second switch.
    -->
    <UAlert v-if="suspended" color="error" variant="soft" icon="i-lucide-lock" title="Suspended" description="KrabiClaw has suspended this website. Contact support to restore it." />

    <div v-else class="space-y-4" role="radiogroup" aria-label="Website status">
      <button
        v-for="item in items"
        :key="item.value"
        type="button"
        role="radio"
        :aria-checked="editor.form.status === item.value"
        class="w-full text-left rounded-2xl p-5 border-2 transition-all cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        :class="editor.form.status === item.value
          ? 'border-highlighted bg-elevated shadow-sm ring-1 ring-highlighted/10'
          : 'border-default bg-default hover:border-accented'"
        @click="editor.form.status = item.value"
      >
        <p class="text-base font-semibold text-highlighted">{{ item.label }}</p>
        <p class="mt-1 text-sm text-muted leading-relaxed">{{ item.description }}</p>
      </button>
    </div>

    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { organizationSettingsEditorKey, type OrganizationStatus } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!
const suspended = computed(() => editor.form.status === 'suspended')
const items: Array<{ value: OrganizationStatus; label: string; description: string }> = [
  { value: 'active', label: 'Published', description: 'Anyone can visit the website, and search engines can list it.' },
  { value: 'inactive', label: 'Draft', description: 'Only people with a preview link can see it. Search engines cannot.' },
]
</script>
