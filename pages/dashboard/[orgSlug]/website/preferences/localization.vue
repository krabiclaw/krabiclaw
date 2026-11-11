<template>
  <DashboardIndexPanel
    id="organization-localization"
    title="Languages"
    lead="For some content, you can add details in any language you add to your website. Visitors will see your translations for published languages."
  >
    <UAlert v-if="actionError" class="mb-6" color="error" variant="soft" :description="actionError" />
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError" />

    <template v-else-if="settings">
      <!-- Task indicator under lead (Airbnb parity) -->
      <div v-if="hasAdditionalLanguages" class="flex items-center gap-2 mb-6 text-sm font-medium text-highlighted">
        <span class="size-2 rounded-full shrink-0" :class="activeTasks.length ? 'bg-amber-500' : 'bg-emerald-500'" />
        <button
          type="button"
          class="hover:underline focus:outline-none cursor-pointer"
          data-testid="translation-task-button"
          @click="tasksModalOpen = true"
        >
          {{ tasksStatusText }}
        </button>
      </div>

      <!-- Languages list (Airbnb Parity) -->
      <div class="border-t border-default divide-y divide-default">
        <!-- Default source language -->
        <div
          v-if="sourceLanguage"
          class="flex items-center justify-between py-5"
          data-testid="source-language-row"
        >
          <div>
            <p class="text-base font-semibold text-highlighted">
              {{ sourceLanguage.label }} (Default)
            </p>
          </div>
        </div>

        <!-- Additional languages -->
        <div
          v-for="language in additionalLanguages"
          :key="language.locale"
          class="flex items-center justify-between py-5 gap-4"
          :data-testid="`language-row-${language.locale}`"
        >
          <div class="min-w-0">
            <div class="flex items-center gap-2.5">
              <p class="text-base font-semibold text-highlighted">
                {{ language.label }}
              </p>
              <UBadge
                :color="language.status === 'published' ? 'success' : 'neutral'"
                variant="subtle"
                size="sm"
              >
                {{ language.status === 'published' ? 'Published' : 'Draft' }}
              </UBadge>
            </div>
            <p v-if="progressByLocale.get(language.locale)" class="mt-0.5 text-xs text-muted">
              {{ progressByLocale.get(language.locale)?.completed }} of {{ progressByLocale.get(language.locale)?.total }} fields translated
            </p>
          </div>

          <div class="flex items-center gap-2">
            <!-- Toggle published status -->
            <UButton
              v-if="language.status === 'disabled'"
              color="neutral"
              variant="soft"
              size="sm"
              :loading="busyLocale === language.locale"
              @click="publishLanguage(language.locale)"
            >
              Publish
            </UButton>
            <UButton
              v-else
              color="neutral"
              variant="ghost"
              size="sm"
              :loading="busyLocale === language.locale"
              @click="disableLanguage(language.locale)"
            >
              Switch to draft
            </UButton>

            <!-- Delete language -->
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="sm"
              label="Delete"
              class="text-neutral-700 dark:text-neutral-300 hover:text-error"
              :disabled="busyLocale !== null"
              @click="deleteLanguage(language)"
            />
          </div>
        </div>
      </div>

      <!-- Add a language button (Airbnb Parity) -->
      <div class="mt-6">
        <UButton
          label="Add a language"
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          size="lg"
          class="h-11 px-5 rounded-xl font-semibold border-2 cursor-pointer"
          data-testid="open-add-language-modal"
          @click="addModalOpen = true"
        />
      </div>

      <!-- Translation Tasks Modal -->
      <TranslationTasksModal
        v-model="tasksModalOpen"
        :tasks="activeTasks"
        @dismiss="dismissTask"
      />

      <!-- Add Language Modal (Airbnb Parity) -->
      <UModal v-model:open="addModalOpen" :ui="{ content: 'max-w-md p-6 sm:p-7 rounded-3xl' }">
        <template #content>
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-xl font-semibold text-highlighted">Add a language</h3>
            <UButton
              icon="i-lucide-x"
              color="neutral"
              variant="ghost"
              square
              size="sm"
              aria-label="Close"
              @click="addModalOpen = false"
            />
          </div>

          <div class="mb-4">
            <UInput
              v-model="addSearchQuery"
              icon="i-lucide-search"
              placeholder="Search languages..."
              class="w-full"
            />
          </div>

          <div class="max-h-80 overflow-y-auto divide-y divide-default border-y border-default pr-1">
            <div
              v-for="catalog in filteredAvailableCatalogs"
              :key="catalog.locale"
              class="flex items-center justify-between py-3.5 px-1 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/50 rounded-xl transition"
              @click="toggleCatalogSelection(catalog.locale)"
            >
              <span class="text-sm font-medium text-highlighted">{{ catalog.label }}</span>
              <UCheckbox
                :model-value="selectedCatalogs.includes(catalog.locale)"
                @click.stop="toggleCatalogSelection(catalog.locale)"
              />
            </div>
            <p v-if="filteredAvailableCatalogs.length === 0" class="text-center py-6 text-sm text-muted">
              No matching languages available.
            </p>
          </div>

          <div class="flex items-center justify-between pt-6">
            <UButton
              label="Cancel"
              color="neutral"
              variant="ghost"
              size="lg"
              class="font-semibold"
              @click="addModalOpen = false"
            />
            <UButton
              label="Save"
              color="neutral"
              variant="solid"
              size="lg"
              class="px-6 rounded-xl font-semibold justify-center"
              :disabled="selectedCatalogs.length === 0 || savingCatalogs"
              :loading="savingCatalogs"
              data-testid="save-added-languages"
              @click="saveSelectedLanguages"
            />
          </div>
        </template>
      </UModal>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardConfirmDialog from '~/components/dashboard/DashboardConfirmDialog.vue'
import TranslationTasksModal, { type TranslationTask } from '~/components/dashboard/TranslationTasksModal.vue'

definePageMeta({ layout: 'dashboard' })

const confirmDialog = useOverlay().create(DashboardConfirmDialog)

interface Language {
  locale: string
  label: string
  is_source: number | boolean
  status: 'published' | 'disabled'
}

interface LocalizationSettings {
  languages: Language[]
  available_catalogs: Array<{ locale: string; label: string; direction: string }>
}

interface LocalizationProgress {
  locale: string
  completed: number
  total: number
  opportunities: Array<{ id: string; label: string; completed: number; total: number; path: string }>
}

const isLocalizationSettings = (value: unknown): value is LocalizationSettings =>
  isRecord(value) && Array.isArray(value.languages)
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
const organizationId = useDashboardOrganizationId()
const localesPath = `/api/editor/organizations/${organizationId}/locales`

const { data: settings, error: settingsError, refresh: refreshSettings } = await useAsyncData(
  `organization-localization:${organizationId}`,
  () => dashboardApi<LocalizationSettings>(localesPath, { validate: isLocalizationSettings }),
)

const { data: progressRows, refresh: refreshProgress } = await useAsyncData(
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

const busyLocale = ref<string | null>(null)
const actionError = ref<string | null>(null)

const sourceLanguage = computed(() => settings.value?.languages.find(l => Boolean(l.is_source)))
const additionalLanguages = computed(() => settings.value?.languages.filter(l => !l.is_source) ?? [])
const hasAdditionalLanguages = computed(() => additionalLanguages.value.length > 0)

const progressByLocale = computed(() => {
  const map = new Map<string, LocalizationProgress>()
  for (const row of progressRows.value ?? []) {
    map.set(row.locale, row)
  }
  return map
})

// Unified translation tasks (matching PageTasks pattern)
const tasksModalOpen = ref(false)
const dismissedTaskIds = ref<Set<string>>(new Set())

const allTranslationTasks = computed<TranslationTask[]>(() => {
  const tasks: TranslationTask[] = []
  for (const progress of progressRows.value ?? []) {
    for (const opp of progress.opportunities) {
      const remaining = opp.total - opp.completed
      if (remaining > 0) {
        tasks.push({
          id: `${progress.locale}-${opp.id}`,
          headline: `Translate ${opp.label} to ${progress.label}`,
          reason: `${remaining} ${remaining === 1 ? 'field' : 'fields'} left to translate`,
          to: opp.path,
          actionLabel: `Translate ${opp.label}`,
          locale: progress.locale,
        })
      }
    }
  }
  return tasks
})

const activeTasks = computed(() => allTranslationTasks.value.filter(t => !dismissedTaskIds.value.has(t.id)))

const tasksStatusText = computed(() => {
  if (activeTasks.value.length === 0) return 'All translations ready'
  return `${activeTasks.value.length} translation ${activeTasks.value.length === 1 ? 'task' : 'tasks'}`
})

function dismissTask(taskId: string) {
  dismissedTaskIds.value.add(taskId)
}

// Add a Language Modal State
const addModalOpen = ref(false)
const addSearchQuery = ref('')
const selectedCatalogs = ref<string[]>([])
const savingCatalogs = ref(false)

const availableCatalogs = computed(() => (settings.value?.available_catalogs ?? [])
  .filter(catalog => !settings.value?.languages.some(language => language.locale === catalog.locale)))

const filteredAvailableCatalogs = computed(() => {
  const q = addSearchQuery.value.trim().toLowerCase()
  if (!q) return availableCatalogs.value
  return availableCatalogs.value.filter(c => c.label.toLowerCase().includes(q) || c.locale.toLowerCase().includes(q))
})

function toggleCatalogSelection(locale: string) {
  const index = selectedCatalogs.value.indexOf(locale)
  if (index >= 0) {
    selectedCatalogs.value.splice(index, 1)
  } else {
    selectedCatalogs.value.push(locale)
  }
}

async function saveSelectedLanguages() {
  if (selectedCatalogs.value.length === 0) return
  savingCatalogs.value = true
  actionError.value = null
  try {
    for (const locale of selectedCatalogs.value) {
      const catalog = availableCatalogs.value.find(c => c.locale === locale)
      if (catalog) {
        await dashboardApi(`${localesPath}/${encodeURIComponent(catalog.locale)}/add`, {
          method: 'POST',
          body: { label: catalog.label },
          validate: isRecord,
        })
      }
    }
    selectedCatalogs.value = []
    addModalOpen.value = false
    await refreshSettings()
    await refreshProgress()
  } catch (error) {
    actionError.value = getErrorMessage(error, 'Failed to add languages')
  } finally {
    savingCatalogs.value = false
  }
}

async function publishLanguage(locale: string) {
  busyLocale.value = locale
  actionError.value = null
  try {
    await dashboardApi(`${localesPath}/${encodeURIComponent(locale)}/publish`, { method: 'POST', validate: isRecord })
    await refreshSettings()
  } catch (error) {
    actionError.value = getErrorMessage(error, 'Failed to publish language')
  } finally {
    busyLocale.value = null
  }
}

async function disableLanguage(locale: string) {
  busyLocale.value = locale
  actionError.value = null
  try {
    await dashboardApi(`${localesPath}/${encodeURIComponent(locale)}/disable`, { method: 'POST', validate: isRecord })
    await refreshSettings()
  } catch (error) {
    actionError.value = getErrorMessage(error, 'Failed to switch language to draft')
  } finally {
    busyLocale.value = null
  }
}

async function deleteLanguage(language: Language) {
  const confirmed = await confirmDialog.open({
    title: `Delete ${language.label} content`,
    description: `Every ${language.label} translation on this site will be deleted permanently.`,
    confirmLabel: 'Delete content',
    cancelLabel: 'Keep content',
  })
  if (!confirmed) return

  busyLocale.value = language.locale
  actionError.value = null
  try {
    await dashboardApi(`${localesPath}/${encodeURIComponent(language.locale)}`, { method: 'DELETE', validate: isRecord })
    await refreshSettings()
    await refreshProgress()
  } catch (error) {
    actionError.value = getErrorMessage(error, `Failed to delete ${language.label}`)
  } finally {
    busyLocale.value = null
  }
}
</script>
