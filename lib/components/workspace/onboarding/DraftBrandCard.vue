<template>
  <div class="onboarding-intake-card">
      <UFormField v-if="showBrand" label="Colors" description="Light and dark colors that go together. You can fine-tune them later in Brand.">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="onboarding-palettes">
          <button
            v-for="starter in STARTER_PALETTES"
            :key="starter.id"
            type="button"
            class="rounded-lg border-2 p-1.5 text-left transition disabled:pointer-events-none disabled:opacity-50"
            :class="form.paletteStarter === starter.id ? 'border-highlighted' : 'border-default hover:border-accented'"
            :aria-pressed="form.paletteStarter === starter.id"
            :aria-label="`Use the ${starter.label} colors`"
            :disabled="disabled"
            @click="form.paletteStarter = starter.id"
          >
            <span class="flex h-8 overflow-hidden rounded" :style="{ background: starter.palette.light.ground }">
              <span class="m-1 flex-1 rounded-sm" :style="{ background: starter.palette.light.action }" />
              <span class="my-1 mr-1 w-1.5 rounded-sm" :style="{ background: starter.palette.light.accent }" />
              <span class="w-1/3" :style="{ background: starter.palette.dark.ground }" />
            </span>
            <span class="mt-1 block text-xs font-medium text-highlighted">{{ starter.label }}</span>
          </button>
        </div>
      </UFormField>

      <UFormField v-if="showBrand" label="Website font">
        <USelect :model-value="form.fontPreset ?? undefined" :items="fontItems" @update:model-value="value => form.fontPreset = value ?? null" value-key="value" label-key="label" class="w-full" placeholder="The template's own" :disabled="disabled" />
      </UFormField>

      <UCard v-if="showBrand" variant="subtle">
        <p class="mb-2 text-xs font-bold text-highlighted">Logo</p>
        <div class="flex items-center gap-3">
          <button
            type="button"
            class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-default bg-default transition-colors hover:border-primary"
            aria-label="Upload logo"
            :disabled="disabled || logoUploading || !draftId"
            @click="logoInput?.inputRef?.click()"
          >
            <img v-if="form.logoPreviewUrl" :src="form.logoPreviewUrl" alt="" class="h-full w-full object-contain">
            <UIcon v-else name="i-lucide-image" class="size-5 text-dimmed" />
          </button>
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            :loading="logoUploading"
            :disabled="disabled || !draftId"
            @click="logoInput?.inputRef?.click()"
          >
            {{ form.logoPreviewUrl ? 'Replace logo' : 'Upload logo' }}
          </UButton>
          <UInput ref="logoInput" type="file" accept="image/*" class="hidden" @change="event => uploadDraftImage(event, 'logo')" />
        </div>
        <div v-if="form.logoPreviewUrl" class="mt-3 flex gap-2" role="radiogroup" aria-label="Logo shape">
          <button
            v-for="shape in LOGO_SHAPE_OPTIONS"
            :key="shape.value"
            type="button"
            role="radio"
            class="flex flex-1 flex-col items-center gap-1 rounded-lg border-2 p-2 text-xs font-medium text-highlighted transition"
            :class="(form.logoShape || 'original') === shape.value ? 'border-highlighted' : 'border-default hover:border-accented'"
            :aria-checked="(form.logoShape || 'original') === shape.value"
            :disabled="disabled"
            @click="form.logoShape = shape.value"
          >
            <span class="flex h-10 items-center justify-center">
              <img :src="form.logoPreviewUrl" alt="" :class="shape.value === 'original' ? 'h-8 w-auto max-w-16 object-contain' : ['size-10 object-cover', shape.value === 'circle' ? 'rounded-full' : 'rounded-md']">
            </span>
            {{ shape.label }}
          </button>
        </div>
      </UCard>

      <UCard v-if="showHero" variant="subtle">
        <p class="mb-2 text-xs font-bold text-highlighted">Hero photo</p>
        <button
          type="button"
          class="flex aspect-[16/9] w-full items-center justify-center overflow-hidden rounded-xl border border-default bg-default transition-colors hover:border-primary"
          aria-label="Upload hero photo"
          :disabled="disabled || heroUploading || !draftId"
          @click="heroInput?.inputRef?.click()"
        >
          <img v-if="form.heroPreviewUrl" :src="form.heroPreviewUrl" alt="" class="h-full w-full object-cover">
          <UIcon v-else name="i-lucide-image" class="size-7 text-highlighted" />
        </button>
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          class="mt-3"
          :loading="heroUploading"
          :disabled="disabled || !draftId"
          @click="heroInput?.inputRef?.click()"
        >
          {{ form.heroPreviewUrl ? 'Replace photo' : 'Upload photo' }}
        </UButton>
        <UInput ref="heroInput" type="file" accept="image/*" class="hidden" @change="event => uploadDraftImage(event, 'hero')" />
      </UCard>

      <UFormField v-if="showHero" label="Hero headline" required>
        <UInput v-model="form.heroHeadline" class="w-full" placeholder="A clear promise guests remember" />
      </UFormField>
      <UFormField v-if="showHero" label="Hero description">
        <UTextarea
          v-model="form.heroSubtitle"
          class="w-full"
          autoresize
          :rows="3"
          placeholder="One or two sentences about what makes this business worth choosing."
        />
      </UFormField>

      <UAlert
        v-if="uploadError"
        color="error"
        variant="soft"
        icon="i-lucide-triangle-alert"
        :description="uploadError"
      />

      <div v-if="actionLabel" class="grid gap-3">
        <UButton
          block
          :loading="loading"
          :disabled="disabled || activeUploadInProgress"
          @click="$emit('submit')"
        >
          {{ actionLabel }}
        </UButton>
      </div>
  </div>
</template>

<script setup lang="ts">
import { STARTER_PALETTES } from '~/shared/site-palette'
import { ORGANIZATION_FONT_OPTIONS, type OrganizationFontPreset } from '~/shared/organization-fonts'
import type { LogoShape } from '~/shared/media-placement-contract'
type DraftUploadedImage = {
  draftAssetId: string
  cloudflareImageId: string
  publicUrl: string
  thumbnailUrl: string | null
  mimeType: string | null
  fileName: string | null
  fileSize: number | null
}

export type DraftBrandForm = {
  paletteStarter: string | null
  fontPreset: OrganizationFontPreset | null
  logoShape: LogoShape | null
  logoNote: string
  logoPreviewUrl: string
  logoImage: DraftUploadedImage | null
  heroPhotoNote: string
  heroPreviewUrl: string
  heroImage: DraftUploadedImage | null
  heroHeadline: string
  heroSubtitle: string
}

const form = defineModel<DraftBrandForm>('form', { required: true })
const revision = defineModel<string | null>('revision', { required: true })

const props = defineProps<{
  /** Omitted when the surface around the card owns the commit control. */
  actionLabel?: string
  section: 'brand' | 'hero' | 'look'
  draftId?: string | null
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  submit: []
  uploading: [value: boolean]
}>()

const fontItems = [...ORGANIZATION_FONT_OPTIONS]
const LOGO_SHAPE_OPTIONS: Array<{ value: LogoShape; label: string }> = [
  { value: 'original', label: 'Whole logo' },
  { value: 'square', label: 'Square' },
  { value: 'circle', label: 'Circle' },
]
const logoInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)
const heroInput = ref<{ inputRef?: HTMLInputElement | null } | null>(null)
const logoUploading = ref(false)
const heroUploading = ref(false)
const uploadError = ref<string | null>(null)
const section = computed(() => props.section)
// 'look' is both halves on one screen: colour and logo above, photo and words
// below. The two are one decision an owner makes in one sitting.
const showBrand = computed(() => section.value === 'brand' || section.value === 'look')
const showHero = computed(() => section.value === 'hero' || section.value === 'look')
const activeUploadInProgress = computed(() => showBrand.value && logoUploading.value ? true : showHero.value && heroUploading.value)
watch(activeUploadInProgress, value => emit('uploading', value), { flush: 'sync' })

async function uploadDraftImage(event: Event, target: 'logo' | 'hero') {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !props.draftId || props.disabled) return

  uploadError.value = null
  if (target === 'logo') logoUploading.value = true
  else heroUploading.value = true

  try {
    if (!revision.value) throw new Error('Reload your saved website draft before uploading.')
    const body = new FormData()
    body.set('revision', revision.value)
    body.set('target', target)
    body.set('file', file)
    const res = await applicationFetch<{ success: boolean; image?: DraftUploadedImage; updatedAt?: string; error?: string; message?: string }>(
      `/api/dashboard/onboarding/drafts/${props.draftId}/media/upload`,
      {
        method: 'POST',
        body,
        validate: (value): value is { success: boolean; image?: DraftUploadedImage; updatedAt?: string; error?: string; message?: string } =>
          isRecord(value)
          && typeof value.success === 'boolean'
          && (value.image === undefined || (
            isRecord(value.image)
            && typeof value.image.draftAssetId === 'string'
            && typeof value.image.cloudflareImageId === 'string'
            && typeof value.image.publicUrl === 'string'
          )),
      },
    )
    if (!res.success || !res.image || typeof res.updatedAt !== 'string') throw new Error(res.error || res.message || 'Upload failed.')
    revision.value = res.updatedAt

    if (target === 'logo') {
      form.value.logoImage = res.image
      form.value.logoNote = res.image.fileName ?? file.name
      form.value.logoPreviewUrl = res.image.publicUrl
    } else {
      form.value.heroImage = res.image
      form.value.heroPhotoNote = res.image.fileName ?? file.name
      form.value.heroPreviewUrl = res.image.publicUrl
    }
  } catch (error) {
    const fetchError = error as { data?: { error?: string; message?: string }; status?: number; statusCode?: number }
    const apiMessage = fetchError.data?.message || fetchError.data?.error
    const status = fetchError.status ?? fetchError.statusCode
    uploadError.value = status === 503 && apiMessage === 'Cloudflare Images not configured'
      ? 'Image upload is not configured for this server. Restart dev with the project environment loaded, then try again.'
      : apiMessage || (error instanceof Error ? error.message : 'Upload failed.')
  } finally {
    if (target === 'logo') logoUploading.value = false
    else heroUploading.value = false
  }
}
</script>

<style scoped>
.onboarding-intake-card {
  display: grid;
  gap: 1rem;
}

.onboarding-intake-card :deep(.rounded-md),
.onboarding-intake-card :deep(.rounded-lg) {
  border-radius: 14px;
}

.onboarding-intake-card :deep(label) {
  color: var(--ui-text-muted);
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}
</style>
