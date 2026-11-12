<template>
  <DashboardIndexPanel
    id="organization-localization"
    title="Languages"
  >
    <UAlert v-if="actionError" class="mb-6" color="error" variant="soft" :description="actionError" />
    <UAlert v-if="loadError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="loadError" />

    <template v-else-if="settings">
      <div class="w-full py-2">
        <!-- Translation tasks indicator (Airbnb parity) -->
        <div v-if="activeTasks.length > 0" class="flex items-center gap-2 mb-6 text-sm font-medium text-highlighted">
          <span class="size-2 rounded-full shrink-0 bg-amber-500" />
          <button
            type="button"
            class="hover:underline focus:outline-none cursor-pointer"
            data-testid="translation-task-button"
            @click="tasksModalOpen = true"
          >
            You have {{ activeTasks.length }} translation {{ activeTasks.length === 1 ? 'task' : 'tasks' }}
          </button>
        </div>

        <!-- Languages list (Airbnb Parity) -->
        <div>
          <!-- Default source language -->
          <div
            v-if="sourceLanguage"
            class="flex items-center justify-between py-6 border-b border-neutral-200 dark:border-neutral-800"
            data-testid="source-language-row"
          >
            <span class="text-base font-normal text-highlighted">
              {{ sourceLanguage.label }} (Default)
            </span>
          </div>

          <!-- Additional languages -->
          <div
            v-for="language in additionalLanguages"
            :key="language.locale"
            class="flex items-center justify-between py-6 border-b border-neutral-200 dark:border-neutral-800"
            :data-testid="`language-row-${language.locale}`"
          >
            <span class="text-base font-normal text-highlighted">
              {{ language.label }}
            </span>

            <!-- Delete language -->
            <button
              type="button"
              class="inline-flex items-center gap-1.5 text-base font-medium text-highlighted hover:opacity-70 transition cursor-pointer"
              :disabled="busyLocale !== null"
              @click="deleteLanguage(language)"
            >
              <UIcon name="i-lucide-trash-2" class="size-4" />
              <span>Delete</span>
            </button>
          </div>
        </div>

        <!-- Add a language button (Airbnb Parity) -->
        <div class="mt-8">
          <UButton
            label="Add a language"
            icon="i-lucide-plus"
            color="neutral"
            variant="outline"
            size="lg"
            class="h-12 px-6 rounded-xl font-semibold border border-neutral-900 dark:border-white text-highlighted cursor-pointer"
            data-testid="open-add-language-modal"
            @click="addModalOpen = true"
          />
        </div>

        <!-- Add Language Modal (Airbnb Parity) -->
        <UModal v-model:open="addModalOpen" :ui="{ content: 'max-w-md p-6 sm:p-7 rounded-3xl' }">
          <template #content>
            <div class="relative flex items-center justify-center mb-6">
              <button
                type="button"
                class="absolute left-0 p-1 rounded-full hover:bg-neutral-100 dark:hover:bg-neutral-800 transition cursor-pointer"
                aria-label="Close"
                @click="addModalOpen = false"
              >
                <UIcon name="i-lucide-x" class="size-5 text-highlighted" />
              </button>
              <h3 class="text-lg font-semibold text-highlighted">
                Add a language
              </h3>
            </div>

            <div class="max-h-96 overflow-y-auto py-1 pr-1 space-y-1">
              <div
                v-for="catalog in availableCatalogs"
                :key="catalog.locale"
                class="flex items-center justify-between py-3.5 px-3 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800/60 rounded-2xl transition"
                @click="toggleCatalogSelection(catalog.locale)"
              >
                <span class="text-base text-highlighted">{{ catalog.label }}</span>
                <UCheckbox
                  :model-value="selectedCatalogs.includes(catalog.locale)"
                  @click.stop="toggleCatalogSelection(catalog.locale)"
                />
              </div>
              <p v-if="availableCatalogs.length === 0" class="text-center py-6 text-sm text-muted">
                All supported languages are already added.
              </p>
            </div>

            <div class="flex items-center justify-between pt-6 border-t border-neutral-200 dark:border-neutral-800 mt-4">
              <button
                type="button"
                class="text-base font-semibold text-highlighted underline underline-offset-4 hover:opacity-70 transition cursor-pointer"
                @click="addModalOpen = false"
              >
                Cancel
              </button>
              <UButton
                label="Save"
                color="neutral"
                class="rounded-xl px-6 py-2.5 font-semibold bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-800 dark:hover:bg-neutral-100 cursor-pointer disabled:opacity-40"
                :disabled="selectedCatalogs.length === 0 || savingCatalogs"
                :loading="savingCatalogs"
                @click="saveSelectedLanguages"
              />
            </div>
          </template>
        </UModal>

        <!-- Translation Tasks Modal -->
        <TranslationTasksModal
          v-model="tasksModalOpen"
          :tasks="activeTasks"
        />
      </div>
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

interface Opportunity {
  id: string
  label: string
  path: string
  completed: number
  total: number
}

interface LocalizationProgress {
  locale: string
  completed: number
  total: number
  opportunities: Opportunity[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isLocalizationSettings = (value: unknown): value is LocalizationSettings => {
  if (!isRecord(value)) return false
  if (!Array.isArray(value.languages)) return false
  const langsValid = value.languages.every((language: unknown) => isRecord(language)
    && typeof language.locale === 'string' && Boolean(language.locale.trim())
    && typeof language.label === 'string' && Boolean(language.label.trim())
    && (typeof language.is_source === 'boolean' || language.is_source === 0 || language.is_source === 1)
    && (language.status === 'published' || language.status === 'disabled'))
  if (!langsValid) return false
  if (!Array.isArray(value.available_catalogs)) return false
  return value.available_catalogs.every((catalog: unknown) => isRecord(catalog)
    && typeof catalog.locale === 'string' && Boolean(catalog.locale.trim())
    && typeof catalog.label === 'string' && Boolean(catalog.label.trim())
    && (catalog.direction === 'ltr' || catalog.direction === 'rtl'))
}

const isLocalizationProgress = (value: unknown): value is LocalizationProgress => {
  if (!isRecord(value)) return false
  if (typeof value.locale !== 'string' || typeof value.completed !== 'number' || typeof value.total !== 'number') return false
  if (!Array.isArray(value.opportunities)) return false
  return value.opportunities.every((item: unknown) => isRecord(item)
    && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.path === 'string'
    && typeof item.completed === 'number' && typeof item.total === 'number')
}

const isMutationResponse = (value: unknown): value is { success: boolean } => {
  return isRecord(value) && typeof value.success === 'boolean'
}

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
      return { ...progress, label: language.label }
    })),
)

const loadError = computed(() => settingsError.value ? (settingsError.value instanceof Error ? settingsError.value.message : 'Languages could not be loaded.') : null)

const sourceLanguage = computed(() => settings.value?.languages.find(language => Boolean(language.is_source)) ?? null)
const additionalLanguages = computed(() => (settings.value?.languages ?? []).filter(language => !language.is_source))

const availableCatalogs = computed(() => {
  const existing = new Set((settings.value?.languages ?? []).map(l => l.locale))
  return (settings.value?.available_catalogs ?? []).filter(c => !existing.has(c.locale))
})

const tasksModalOpen = ref(false)

const activeTasks = computed<TranslationTask[]>(() => {
  if (!progressRows.value) return []
  const list: TranslationTask[] = []
  for (const prog of progressRows.value) {
    for (const opp of prog.opportunities) {
      const remaining = opp.total - opp.completed
      if (remaining <= 0) continue
      const taskId = `${prog.locale}-${opp.id}`
      list.push({
        id: taskId,
        headline: `Translate ${opp.label} to ${prog.label}`,
        reason: `${remaining} ${remaining === 1 ? 'field' : 'fields'} left to translate`,
        to: opp.path,
        actionLabel: `Translate ${opp.label}`,
        locale: prog.locale,
      })
    }
  }
  return list
})

const addModalOpen = ref(false)
const selectedCatalogs = ref<string[]>([])
const savingCatalogs = ref(false)
const busyLocale = ref<string | null>(null)
const actionError = ref<string | null>(null)

function toggleCatalogSelection(locale: string) {
  const idx = selectedCatalogs.value.indexOf(locale)
  if (idx >= 0) {
    selectedCatalogs.value.splice(idx, 1)
  } else {
    selectedCatalogs.value.push(locale)
  }
}

watch(addModalOpen, (isOpen) => {
  if (isOpen) {
    selectedCatalogs.value = []
    actionError.value = null
  }
})

async function saveSelectedLanguages() {
  if (selectedCatalogs.value.length === 0 || savingCatalogs.value) return
  savingCatalogs.value = true
  actionError.value = null
  try {
    for (const locale of selectedCatalogs.value) {
      await dashboardApi(`${localesPath}/${encodeURIComponent(locale)}`, {
        method: 'PUT',
        body: { status: 'published' },
        validate: isMutationResponse,
      })
    }
    addModalOpen.value = false
    await refreshSettings()
    await refreshProgress()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Adding languages failed.'
  } finally {
    savingCatalogs.value = false
  }
}

async function deleteLanguage(language: Language) {
  const confirmed = await confirmDialog.open({
    title: `Remove ${language.label}?`,
    description: `Are you sure you want to remove ${language.label}? Any translations specific to this language will no longer be shown to visitors.`,
    confirmLabel: 'Remove language',
    cancelLabel: 'Cancel',
  })
  if (!confirmed) return

  busyLocale.value = language.locale
  actionError.value = null
  try {
    await dashboardApi(`${localesPath}/${encodeURIComponent(language.locale)}`, {
      method: 'DELETE',
      validate: isMutationResponse,
    })
    await refreshSettings()
    await refreshProgress()
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : 'Removing language failed.'
  } finally {
    busyLocale.value = null
  }
}
</script>
