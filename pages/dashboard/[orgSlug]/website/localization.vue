<template>
  <DashboardIndexPanel
    id="organization-localization"
    title="Languages"
    lead="English is the permanent source language. Growth includes every available language at no extra cost."
  >
    <template #right>
      <UDropdownMenu v-if="enableableCatalogOptions.length && !loadError" :items="addLanguageItems">
        <UButton label="Add language" icon="i-lucide-plus" color="neutral" variant="ghost" :disabled="busy || Boolean(validationMessage)" />
      </UDropdownMenu>
    </template>
    <UAlert v-if="actionError" class="mb-6" color="error" variant="soft" :description="actionError" />
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError" />
    <template v-else-if="settings">
      <!-- One row per language: its name, then its state. -->
      <ul>
        <li v-for="language in settings.languages" :key="language.locale" class="flex flex-wrap items-center justify-between gap-4 border-b border-default py-6 last:border-b-0">
          <div class="min-w-0">
            <p class="text-base text-highlighted">{{ language.label }}</p>
            <p class="mt-1 text-sm text-muted">{{ languageSummary(language) }}</p>
          </div>
          <div v-if="!language.is_source" class="flex gap-2">
            <UButton v-if="language.status === 'disabled'" :loading="busy" @click="publishLanguage(language.locale)">Publish</UButton>
            <UButton v-if="language.status === 'published'" color="neutral" variant="outline" :loading="busy" @click="disableLanguage(language.locale)">Disable</UButton>
            <UButton v-if="language.status === 'disabled'" color="error" variant="outline" :loading="busy" @click="deleteLanguage(language)">Delete content</UButton>
          </div>
        </li>
      </ul>
      <!-- What is left to translate, as rows that open the field's own editor. -->
      <section v-for="progress in progressRows ?? []" :key="progress.locale" class="mt-8">
        <h2 class="text-sm font-semibold text-muted">{{ progress.label }} translations</h2>
        <p class="mt-1 text-sm text-muted">{{ progress.completed }} of {{ progress.total }} fields translated.</p>
        <ul v-if="progress.opportunities.length">
          <li v-for="item in progress.opportunities" :key="item.id" class="border-b border-default last:border-b-0">
            <NuxtLink :to="item.path" class="flex items-center justify-between gap-4 py-6">
              <span class="text-base text-highlighted">{{ item.label }}</span>
              <span class="flex items-center gap-2 text-sm text-muted">
                {{ item.total - item.completed }} left
                <UIcon name="i-lucide-chevron-right" class="size-5" />
              </span>
            </NuxtLink>
          </li>
        </ul>
        <p v-else class="mt-3 text-sm text-muted">Every source field with content has a translation.</p>
      </section>
      <UAlert v-if="progressError" class="mt-6" color="error" variant="soft" :description="progressError" />
      <p v-if="enableableCatalogOptions.length && validationMessage" class="mt-6 text-sm text-muted">{{ validationMessage }}</p>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
definePageMeta({ layout: 'dashboard' })
const confirmDialog = useOverlay().create(DashboardConfirmDialog)

interface Language { locale: string; label: string; is_source: number | boolean; status: 'published' | 'disabled' }
interface LocalizationSettings { effective_plan: string; languages: Language[]; available_catalogs: Array<{ locale: string; label: string; direction: string }> }
interface LocalizationProgress { locale: string; completed: number; total: number; opportunities: Array<{ id: string; label: string; completed: number; total: number; path: string }> }

const isLocalizationSettings = (value: unknown): value is LocalizationSettings =>
  isRecord(value) && typeof value.effective_plan === 'string' && Array.isArray(value.languages)
  && value.languages.every(language => isRecord(language) && typeof language.locale === 'string' && Boolean(language.locale.trim())
    && typeof language.label === 'string' && Boolean(language.label.trim())
    && (typeof language.is_source === 'boolean' || language.is_source === 0 || language.is_source === 1)
    && (language.status === 'published' || language.status === 'disabled'))
  && Array.isArray(value.available_catalogs) && value.available_catalogs.every(catalog => isRecord(catalog)
    && typeof catalog.locale === 'string' && Boolean(catalog.locale.trim())
    && typeof catalog.label === 'string' && Boolean(catalog.label.trim()) && (catalog.direction === 'ltr' || catalog.direction === 'rtl'))
const isLocalizationProgress = (value: unknown): value is LocalizationProgress =>
  isRecord(value) && typeof value.locale === 'string' && typeof value.completed === 'number' && typeof value.total === 'number'
  && Array.isArray(value.opportunities) && value.opportunities.every(item => isRecord(item)
    && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.path === 'string'
    && typeof item.completed === 'number' && typeof item.total === 'number')

const dashboardApi = useDashboardApi()
const organizationId = await useDashboardOrganizationId()
const localesPath = `/api/editor/organizations/${organizationId}/locales`

// The organization's languages, then how far each added one is translated —
// every added language, not only the published ones: a language still being
// translated is the one whose progress the owner most wants to see. Both load
// before the leaf shows; progress failing leaves the languages on screen.
const { data: settings, error: settingsError, refresh: refreshSettings } = await useAsyncData(
  `organization-localization:${organizationId}`,
  () => dashboardApi<LocalizationSettings>(localesPath, { validate: isLocalizationSettings }),
)
const { data: progressRows, error: progressFailure, refresh: refreshProgress } = await useAsyncData(
  `organization-localization-progress:${organizationId}`,
  () => Promise.all((settings.value?.languages ?? [])
    .filter(language => !language.is_source)
    .map(async (language) => {
      const progress = await dashboardApi<LocalizationProgress>(`${localesPath}/${encodeURIComponent(language.locale)}/opportunities`, { validate: isLocalizationProgress })
      if (progress.locale !== language.locale) throw new Error('The translation progress belongs to a different language.')
      return { ...progress, label: language.label }
    })),
)
const loadError = computed(() => settingsError.value ? getErrorMessage(settingsError.value, 'Failed to load localization settings') : null)
const progressError = computed(() => progressFailure.value ? getErrorMessage(progressFailure.value, 'Translation progress could not be loaded') : null)

const busy = ref(false)
const actionError = ref<string | null>(null)
const enableableCatalogOptions = computed(() => (settings.value?.available_catalogs ?? [])
  .filter(catalog => !settings.value?.languages.some(language => language.locale === catalog.locale))
  .map(catalog => ({ label: catalog.label, value: catalog.locale })))
const validationMessage = computed(() => settings.value?.effective_plan !== 'growth' ? 'A Growth subscription is required.' : null)
const addLanguageItems = computed(() => enableableCatalogOptions.value.map(option => ({
  label: option.label,
  onSelect: () => enableLanguage(option.value),
})))

function languageSummary(language: Language): string {
  if (language.is_source) return 'Source language · Published'
  return language.status === 'published' ? 'Published' : 'Not published'
}

async function mutate(path: string, method: 'POST' | 'DELETE', body?: Record<string, unknown>) {
  busy.value = true
  actionError.value = null
  try {
    await dashboardApi(path, { method, body, validate: isRecord })
    await refreshSettings()
    if (settingsError.value) throw settingsError.value
    await refreshProgress()
    if (progressFailure.value) throw progressFailure.value
    return true
  } catch (error) {
    actionError.value = getErrorMessage(error, 'Localization request failed')
    return false
  } finally {
    busy.value = false
  }
}
async function enableLanguage(locale: string) {
  if (busy.value || validationMessage.value) return
  const catalog = settings.value?.available_catalogs.find(candidate => candidate.locale === locale)
  if (!catalog) throw new Error('The selected language is unavailable.')
  await mutate(`${localesPath}/${encodeURIComponent(catalog.locale)}/add`, 'POST', { label: catalog.label })
}
async function publishLanguage(locale: string) { await mutate(`${localesPath}/${encodeURIComponent(locale)}/publish`, 'POST') }
async function disableLanguage(locale: string) { await mutate(`${localesPath}/${encodeURIComponent(locale)}/disable`, 'POST') }
async function deleteLanguage(language: Language) {
  if (await confirmDialog.open({ title: `Delete ${language.label} content`, description: `Every ${language.label} translation on this site is deleted permanently.`, confirmLabel: 'Delete content', cancelLabel: 'Keep content' })) await mutate(`${localesPath}/${encodeURIComponent(language.locale)}`, 'DELETE')
}
</script>
