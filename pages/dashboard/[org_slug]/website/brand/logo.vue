<template>
  <DashboardLeafPanel
    id="organization-logo"
    title="Logo"
    :saving="editor.saving.value"
    :disabled="editor.saveDisabled.value"
    :error="editor.editorError.value ?? ''"
    @cancel="editor.revert"
    @save="editor.save"
  >
    <div class="space-y-10">
      <section v-for="logo in logos" :key="logo.slot" class="space-y-4" :data-testid="`logo-${logo.slot}`">
        <div>
          <h2 class="text-base font-semibold text-highlighted">{{ logo.title }}</h2>
          <p class="mt-1 text-sm text-muted">{{ logo.hint }}</p>
        </div>
        <MediaPicker
          :model-value="editor.form[logo.assetKey]"
          :organization-id="editor.organizationId"
          accept="image"
          :title="logo.pickerTitle"
          @update:model-value="value => editor.form[logo.assetKey] = value"
          @change="asset => { if (asset) pickedUrls[asset.asset_id] = mediaStillUrl(asset) }"
        />
        <template v-if="urlFor(logo)">
          <UFormField label="Shape">
            <div class="flex gap-2" role="radiogroup" :aria-label="`${logo.title} shape`">
              <UButton
                v-for="shape in SHAPES"
                :key="shape.value"
                :label="shape.label"
                :icon="shape.icon"
                color="neutral"
                :variant="editor.form[logo.presentationKey].shape === shape.value ? 'solid' : 'outline'"
                role="radio"
                :aria-checked="editor.form[logo.presentationKey].shape === shape.value"
                @click="setShape(logo, shape.value)"
              />
            </div>
          </UFormField>
          <UFormField v-if="editor.form[logo.presentationKey].shape !== 'original'" label="Focus">
            <button
              type="button"
              class="relative block w-full max-w-xs overflow-hidden rounded-lg border border-default bg-muted"
              :aria-label="`Set the ${logo.title.toLowerCase()} focus`"
              @click="event => setFocus(logo, event)"
            >
              <img :src="urlFor(logo)!" alt="" class="block w-full">
              <span
                class="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-2 ring-black/40"
                :style="{ left: `${editor.form[logo.presentationKey].focus.x * 100}%`, top: `${editor.form[logo.presentationKey].focus.y * 100}%` }"
              />
            </button>
          </UFormField>
        </template>
      </section>

      <section v-if="previewUrl" class="space-y-3">
        <h2 class="text-base font-semibold text-highlighted">Preview</h2>
        <div v-for="mode in MODES" :key="mode" class="overflow-hidden rounded-lg border border-default" :style="{ background: mode === 'light' ? '#ffffff' : '#0b0b0d' }" :data-testid="`logo-preview-${mode}`">
          <div v-for="width in WIDTHS" :key="width.label" class="flex items-center gap-3 border-b border-default/40 px-4 py-3 last:border-b-0">
            <span class="w-20 shrink-0 text-xs" :class="mode === 'light' ? 'text-zinc-500' : 'text-zinc-400'">{{ width.label }}</span>
            <span class="flex items-center" :style="{ maxWidth: width.max }">
              <span :class="frameClass(previewFor(mode))" class="inline-flex">
                <img
                  :src="previewFor(mode).url"
                  alt=""
                  :class="previewFor(mode).presentation.shape === 'original' ? 'h-10 w-auto max-w-40 object-contain' : 'size-full object-cover'"
                  :style="previewFor(mode).presentation.shape === 'original' ? undefined : { objectPosition: `${previewFor(mode).presentation.focus.x * 100}% ${previewFor(mode).presentation.focus.y * 100}%` }"
                >
              </span>
            </span>
          </div>
        </div>
      </section>
    </div>
    <UAlert v-if="editor.validationMessage.value" class="mt-6" color="error" variant="soft" :description="editor.validationMessage.value" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import MediaPicker from '~/lib/components/workspace/media/MediaPicker.vue'
import { organizationSettingsEditorKey } from '~/lib/components/workspace/settings/OrganizationSettingsPage.vue'
import { mediaStillUrl, type LogoPresentation, type LogoShape } from '~/shared/media-placement-contract'

definePageMeta({ layout: 'dashboard' })

const editor = inject(organizationSettingsEditorKey)!

const logos = [
  { slot: 'logo', title: 'Logo', hint: 'Shown in the header and footer.', pickerTitle: 'Select logo', assetKey: 'logoAssetId', presentationKey: 'logoPresentation' },
  { slot: 'logo_dark', title: 'Logo for dark backgrounds', hint: 'Optional. Shown instead in dark mode, for a logo that is dark itself.', pickerTitle: 'Select logo for dark backgrounds', assetKey: 'logoDarkAssetId', presentationKey: 'logoDarkPresentation' },
] as const
type LogoEntry = typeof logos[number]

const SHAPES: Array<{ value: LogoShape; label: string; icon: string }> = [
  { value: 'original', label: 'Whole logo', icon: 'i-lucide-rectangle-horizontal' },
  { value: 'square', label: 'Square', icon: 'i-lucide-square' },
  { value: 'circle', label: 'Circle', icon: 'i-lucide-circle' },
]
const MODES = ['light', 'dark'] as const
const WIDTHS = [{ label: 'Phone', max: '10rem' }, { label: 'Desktop', max: '16rem' }]

// A logo just picked has no saved URL yet; the picker hands over its own, kept
// by asset so reverting to the saved logo shows the saved one.
const pickedUrls = reactive<Record<string, string | null>>({})
function urlFor(logo: LogoEntry) {
  const assetId = editor.form[logo.assetKey]
  if (!assetId) return null
  return pickedUrls[assetId] ?? editor.logoUrl(assetId)
}
function setShape(logo: LogoEntry, shape: LogoShape) {
  editor.form[logo.presentationKey] = { ...editor.form[logo.presentationKey], shape }
}
function setFocus(logo: LogoEntry, event: MouseEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const clamp = (n: number) => Math.min(1, Math.max(0, Math.round(n * 100) / 100))
  editor.form[logo.presentationKey] = {
    ...editor.form[logo.presentationKey],
    focus: { x: clamp((event.clientX - box.left) / box.width), y: clamp((event.clientY - box.top) / box.height) },
  }
}

const previewUrl = computed(() => urlFor(logos[0]))
// Dark mode shows the dark-ground logo when there is one, as the site does.
function previewFor(mode: 'light' | 'dark'): { url: string; presentation: LogoPresentation } {
  const dark = mode === 'dark' ? urlFor(logos[1]) : null
  return dark
    ? { url: dark, presentation: editor.form.logoDarkPresentation }
    : { url: previewUrl.value!, presentation: editor.form.logoPresentation }
}
function frameClass(entry: { presentation: LogoPresentation }) {
  if (entry.presentation.shape === 'original') return ''
  return ['size-10 overflow-hidden', entry.presentation.shape === 'circle' ? 'rounded-full' : 'rounded-md']
}
</script>
