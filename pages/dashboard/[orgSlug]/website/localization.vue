<template>
  <DashboardLeafPanel
    id="organization-localization"
    title="Languages"
    lead="English is the permanent source language. Growth includes every available language at no extra cost."
    :saving="busy"
    :disabled="!newLocale || Boolean(validationMessage)"
    :error="actionError ?? ''"
    @cancel="newLocale = ''"
    @save="enableLanguage"
  >
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError" />
    <template v-else-if="settings">
      <!-- One row per language: its name, then its state. -->
      <ul>
        <li v-for="language in settings.languages" :key="language.locale" class="flex flex-wrap items-center justify-between gap-4 border-b border-default py-6 last:border-b-0">
          <div class="min-w-0">
            <p class="text-base text-highlighted">{{ language.label || language.locale }}</p>
            <p class="mt-1 text-sm text-muted">{{ languageSummary(language) }}</p>
          </div>
          <div v-if="!language.is_source" class="flex gap-2">
            <UButton v-if="language.status === 'disabled'" :loading="busy" @click="publishLanguage(language.locale)">Publish</UButton>
            <UButton v-if="language.status === 'published'" color="neutral" variant="outline" :loading="busy" @click="disableLanguage(language.locale)">Disable</UButton>
            <UButton v-if="language.status === 'disabled'" color="error" variant="outline" :loading="busy" @click="deleteLanguage(language.locale)">Delete content</UButton>
          </div>
        </li>
      </ul>
      <!-- What is left to translate, as rows that open the field's own editor. -->
      <section v-for="progress in progressRows ?? []" :key="progress.locale" class="mt-8">
        <h2 class="text-sm font-semibold text-muted">Let’s translate your site</h2>
        <p class="mt-1 text-sm text-muted">{{ progress.completed }}/{{ progress.total }} fields translated in {{ progress.locale }}.</p>
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
      <p v-if="!enableableCatalogOptions.length" class="mt-6 text-sm text-muted">No additional languages are available to enable right now.</p>
      <UFormField v-else class="mt-8" label="Available language">
        <USelect v-model="newLocale" :items="enableableCatalogOptions" placeholder="Select a language to enable" class="w-full" />
      </UFormField>
    </template>
    <UAlert v-if="newLocale && validationMessage" class="mt-6" color="error" variant="soft" :description="validationMessage" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
definePageMeta({ layout: 'dashboard' })
const confirmDialog = useOverlay().create(DashboardConfirmDialog)

interface Language { locale: string; label: string | null; is_source: number | boolean; status: string }
interface LocalizationSettings { effective_plan: string; languages: Language[]; available_catalogs: Array<{ locale: string; label: string; direction: string }> }
interface LocalizationProgress { locale: string; completed: number; total: number; opportunities: Array<{ id: string; label: string; completed: number; total: number; path: string }> }

const isLocalizationSettings = (value: unknown): value is LocalizationSettings =>
  isRecord(value) && typeof value.effective_plan === 'string' && Array.isArray(value.languages) && Array.isArray(value.available_catalogs)
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
    .map(language => dashboardApi<LocalizationProgress>(`${localesPath}/${encodeURIComponent(language.locale)}/opportunities`, { validate: isLocalizationProgress }))),
)
const loadError = computed(() => settingsError.value ? getErrorMessage(settingsError.value, 'Failed to load localization settings') : null)
const progressError = computed(() => progressFailure.value ? getErrorMessage(progressFailure.value, 'Translation progress could not be loaded') : null)

const newLocale = ref('')
const busy = ref(false)
const actionError = ref<string | null>(null)
const enableableCatalogOptions = computed(() => (settings.value?.available_catalogs ?? [])
  .filter(catalog => !settings.value?.languages.some(language => language.locale === catalog.locale && language.status !== 'disabled'))
  .map(catalog => ({ label: `${catalog.label} (${catalog.locale})`, value: catalog.locale })))
const validationMessage = computed(() => settings.value?.effective_plan !== 'growth' ? 'A Growth subscription is required.' : null)

function languageSummary(language: Language): string {
  if (language.is_source) return 'Source · published'
  return language.status === 'published' ? 'published' : 'Not published'
}

async function mutate(path: string, method: 'POST' | 'DELETE', body?: Record<string, unknown>) {
  busy.value = true
  actionError.value = null
  try {
    await dashboardApi(path, { method, body, validate: isRecord })
    await refreshSettings()
    if (settingsError.value) throw settingsError.value
    await refreshProgress()
    return true
  } catch (error) {
    actionError.value = getErrorMessage(error, 'Localization request failed')
    return false
  } finally {
    busy.value = false
  }
}
async function enableLanguage() {
  const catalog = settings.value?.available_catalogs.find(candidate => candidate.locale === newLocale.value)
  if (!catalog) return
  if (await mutate(`${localesPath}/${encodeURIComponent(catalog.locale)}/add`, 'POST', { label: catalog.label })) newLocale.value = ''
}
async function publishLanguage(locale: string) { await mutate(`${localesPath}/${encodeURIComponent(locale)}/publish`, 'POST') }
async function disableLanguage(locale: string) { await mutate(`${localesPath}/${encodeURIComponent(locale)}/disable`, 'POST') }
async function deleteLanguage(locale: string) {
  if (await confirmDialog.open({ title: `Delete ${locale} content`, description: `Every ${locale} translation on this site is deleted permanently.`, confirmLabel: 'Delete content', cancelLabel: 'Keep content' })) await mutate(`${localesPath}/${encodeURIComponent(locale)}`, 'DELETE')
}
</script>
