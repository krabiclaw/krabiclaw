<template>
  <UTooltip v-if="!rowTrigger" text="Translations">
    <UButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-languages"
      aria-label="Translations"
      :to="modePath"
      :disabled="disabled || !resourceId"
      class="size-10 rounded-full"
      data-testid="localize-resource"
    />
  </UTooltip>

  <UModal
    v-model:open="modalOpen"
    :title="`${resourceLabel} translations`"
    :dismissible="!saving"
    :ui="{ content: 'max-w-3xl' }"
  >
    <template #body>
      <div class="space-y-6">
        <UFormField label="Translation language">
          <USelect
            v-model="selectedLocale"
            :items="localeOptions"
            placeholder="Choose a language"
            class="w-full"
            aria-label="Translation language"
            :disabled="loadingLanguages || saving"
            data-testid="localize-language"
          />
        </UFormField>
        <p v-if="localeOptions.find(option => option.value === locale)?.status === 'disabled'" class="text-sm text-muted" data-testid="translation-publication-state">Not published. Saving this translation keeps the language private.</p>

        <div v-if="loadingLanguages" class="space-y-3">
          <USkeleton class="h-16 rounded-lg" />
          <USkeleton class="h-16 rounded-lg" />
        </div>
        <UAlert
          v-else-if="languageError"
          color="error"
          variant="soft"
          icon="i-lucide-triangle-alert"
          :description="languageError"
        />
        <div v-else-if="localeOptions.length === 0" class="space-y-3">
          <p class="text-sm text-muted">Add another language in Languages before translating this content.</p>
          <UButton v-if="languageSettingsPath" color="neutral" variant="soft" label="Manage languages" :to="languageSettingsPath" />
        </div>

        <template v-else-if="locale">
          <div v-if="loading" class="space-y-3">
            <USkeleton v-for="field in fields" :key="field.key" class="h-24 rounded-lg" />
          </div>
          <template v-else>
            <UCard
              v-for="field in fields"
              :key="field.key"
              variant="subtle"
              :ui="{ body: 'grid gap-3 sm:grid-cols-2' }"
            >
              <div>
                <p class="text-xs font-semibold uppercase tracking-wide text-muted">Source language · {{ sourceLocale }}</p>
                <p class="mt-2 whitespace-pre-wrap text-sm text-highlighted">{{ sourceText(field) }}</p>
              </div>
              <UFormField :label="`${field.label} · ${locale}`">
                <UTextarea
                  v-if="field.multiline || field.kind === 'string-list'"
                  v-model="draft[field.key]"
                  :rows="field.rows || (field.kind === 'string-list' ? 4 : 3)"
                  :placeholder="field.kind === 'string-list' ? 'One item per line' : undefined"
                  class="w-full"
                  :disabled="saving"
                  :data-testid="`localize-field-${field.key}`"
                />
                <UInput
                  v-else
                  v-model="draft[field.key]"
                  class="w-full"
                  :disabled="saving"
                  :data-testid="`localize-field-${field.key}`"
                />
              </UFormField>
            </UCard>
            <UAlert v-if="editorError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="editorError" />
          </template>
        </template>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-3">
        <UButton color="neutral" variant="ghost" label="Cancel" :disabled="saving" @click="requestClose" />
        <UButton
          label="Save"
          :loading="saving"
          :disabled="!locale || loading || loadingLanguages || Boolean(languageError) || Boolean(editorError)"
          data-testid="localize-save"
          @click="save"
        />
      </div>
    </template>
  </UModal>
</template>

<script setup lang="ts">
import { getErrorMessage } from '~/utils/errors'

interface LocalizationField {
  key: string
  label: string
  source: string | readonly string[] | null | undefined
  kind?: 'text' | 'string-list'
  multiline?: boolean
  rows?: number
}

interface LanguageRow {
  locale: string
  label: string | null
  status: string
  is_source: boolean | number
}

interface LocalizationResponse {
  localization: {
    [key: string]: unknown
  }
}

const props = defineProps<{
  organizationId: string
  resourceType: string
  resourceId: string
  resourceLabel: string
  fields: readonly LocalizationField[]
  languageSettingsPath?: string
  disabled?: boolean
  /** Opened by a row in a settings list that links to this mode; draws no button of its own. */
  rowTrigger?: boolean
  loadValues?: (locale: string) => Promise<Record<string, unknown>>
  saveValues?: (locale: string, values: Record<string, unknown>) => Promise<void>
}>()

const emit = defineEmits<{ saved: [locale: string] }>()
const dashboardApi = useDashboardApi()
const route = useRoute()
const router = useRouter()
const level = useRouteLevel()

/*
  Translating is a mode of the record, held in its URL: the record's own path
  with `editMode=translations`, and `locale` once a language is chosen. A reload,
  a shared link or a Languages opportunity reopens the same record in the same
  language. Without `locale` the mode is on the source language and nothing is
  picked for the tenant. The record whose level the URL ends at owns the mode;
  a record with a child open beside it does not, so a product and its page
  never both open.
*/
const modePath = computed(() => router.resolve({ path: level.path.value, query: { ...route.query, locale: undefined, editMode: 'translations' } }).fullPath)
const open = computed(() => route.query.editMode === 'translations' && level.mode.value === 'index')
const locale = computed(() => open.value && typeof route.query.locale === 'string' ? route.query.locale : '')
const sourceLocale = ref('')
const localeOptions = ref<Array<{ label: string, value: string, status: string }>>([])
const draft = reactive<Record<string, string>>({})
const baseline = ref<Record<string, string>>({})
const loadingLanguages = ref(false)
const loading = ref(false)
const saving = ref(false)
const languageError = ref<string | null>(null)
const editorError = ref<string | null>(null)
let requestGeneration = 0
let documentRevision: { locale: string; updatedAt: string } | null = null
let loadedValues: Record<string, unknown> = {}


/** Leaving the mode is a navigation like entering it, so Back and reload agree with the screen. */
function close() {
  return navigateTo({ path: route.path, query: { ...route.query, editMode: undefined, locale: undefined }, hash: route.hash })
}

const modalOpen = computed({
  get: () => open.value,
  set: (value: boolean) => {
    if (!value && !saving.value) void close()
  },
})

const selectedLocale = computed({
  get: () => locale.value,
  set: (value: string) => {
    if (value === locale.value || saving.value) return
    void navigateTo({ path: route.path, query: { ...route.query, locale: value }, hash: route.hash }, { replace: true })
  },
})

function isLanguagesResponse(value: unknown): value is { languages: LanguageRow[] } {
  return isRecord(value)
    && Array.isArray(value.languages)
    && value.languages.every(item => isRecord(item)
      && typeof item.locale === 'string'
      && (typeof item.label === 'string' || item.label === null)
      && typeof item.status === 'string'
      && (typeof item.is_source === 'boolean' || typeof item.is_source === 'number'))
}

function isLocalizationResponse(value: unknown): value is LocalizationResponse {
  return isRecord(value) && isRecord(value.localization) && (props.resourceType === 'content_document'
    ? typeof value.localization.updated_at === 'string' && isRecord(value.localization.metadata)
    : isRecord(value.localization.values))
}

function sourceText(field: LocalizationField): string {
  if (Array.isArray(field.source)) return field.source.join('\n')
  return typeof field.source === 'string' && field.source.trim() ? field.source : 'Empty'
}

function clearDraft(): void {
  for (const field of props.fields) draft[field.key] = ''
}

function markDraftClean(): void {
  baseline.value = Object.fromEntries(props.fields.map(field => [field.key, draft[field.key] ?? '']))
}

function applyValues(values: Record<string, unknown>): void {
  // Document writes replace their localized text snapshot. Keep values the
  // current field list does not display, including explicit nulls.
  loadedValues = props.resourceType === 'content_document' && !props.loadValues
    ? Object.fromEntries(['title', 'summary', ...(values.kind === 'qa' ? [] : ['seo_keywords']), 'metadata'].filter(key => Object.hasOwn(values, key)).map(key => [key, structuredClone(values[key])]))
    : structuredClone(values)
  for (const field of props.fields) {
    const value = props.loadValues ? values[field.key] : field.key.split('.').reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, values)
    draft[field.key] = field.kind === 'string-list'
      ? (Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '')
      : (typeof value === 'string' ? value : '')
  }
  markDraftClean()
}

function serializedValues(): Record<string, unknown> {
  const values: Record<string, unknown> = props.saveValues ? {} : structuredClone(loadedValues)
  for (const field of props.fields) {
    const rawValue = draft[field.key]
    if (rawValue === undefined) throw new Error(`Translation field ${field.key} is unavailable.`)
    const text = rawValue.trim()
    if (props.saveValues && !text) continue
    if (!props.saveValues && rawValue === baseline.value[field.key]) continue
    const value = field.kind === 'string-list'
      ? text.split('\n').map(item => item.trim()).filter(Boolean)
      : text
    if (props.saveValues) values[field.key] = value
    else {
      const path = field.key.split('.')
      let target = values
      for (const key of path.slice(0, -1)) {
        if (!isRecord(target[key])) target[key] = {}
        target = target[key] as Record<string, unknown>
      }
      const key = path[path.length - 1]!
      if (text) target[key] = value
      else if (props.resourceType === 'content_document' && path.length === 1) target[key] = null
      else {
        Reflect.deleteProperty(target, key)
        for (let index = path.length - 2; index >= 0; index -= 1) {
          const parent = path.slice(0, index).reduce<Record<string, unknown>>((current, part) => current[part] as Record<string, unknown>, values)
          const child = parent[path[index]!]
          if (isRecord(child) && Object.keys(child).length === 0) Reflect.deleteProperty(parent, path[index]!)
        }
      }
    }
  }
  return values
}

async function loadLanguages(): Promise<void> {
  loadingLanguages.value = true
  languageError.value = null
  localeOptions.value = []
  sourceLocale.value = ''
  clearDraft()
  markDraftClean()
  try {
    const response = await dashboardApi<{ languages: LanguageRow[] }>(
      `/api/editor/organizations/${props.organizationId}/locales`,
      { validate: isLanguagesResponse },
    )
    const sources = response.languages.filter(item => Boolean(item.is_source) && item.status === 'published')
    if (sources.length !== 1) throw new Error('The organization source language is not configured correctly.')
    sourceLocale.value = sources[0]!.locale
    const secondaryLanguages = response.languages.filter(item => !item.is_source)
    if (secondaryLanguages.some(item => !item.label)) throw new Error('An added language is missing its display name.')
    localeOptions.value = secondaryLanguages.map(item => ({ label: `${item.label} (${item.locale})${item.status === 'published' ? '' : ' · Not published'}`, value: item.locale, status: item.status }))
  } catch (cause) {
    languageError.value = getErrorMessage(cause, 'Failed to load organization languages')
  } finally {
    loadingLanguages.value = false
  }
}

async function load(): Promise<void> {
  const requestedLocale = locale.value
  const generation = ++requestGeneration
  documentRevision = null
  loadedValues = {}
  clearDraft()
  markDraftClean()
  editorError.value = null
  loading.value = false
  if (!requestedLocale || loadingLanguages.value || languageError.value) return
  if (!localeOptions.value.some(option => option.value === requestedLocale)) {
    editorError.value = `The requested ${requestedLocale} language has not been added to this organization.`
    return
  }
  loading.value = true
  try {
    const response = props.loadValues ? null : await dashboardApi<LocalizationResponse>(
      `/api/editor/organizations/${props.organizationId}/localization/${props.resourceType}/${props.resourceId}/${encodeURIComponent(requestedLocale)}`,
      { validate: isLocalizationResponse },
    )
    const values = props.loadValues ? await props.loadValues(requestedLocale)
      : props.resourceType === 'content_document' ? response!.localization : response!.localization.values
    if (generation !== requestGeneration || locale.value !== requestedLocale || !open.value) return
    if (!isRecord(values)) throw new Error('Localized values are unavailable.')
    if (response && typeof response.localization.updated_at === 'string') {
      documentRevision = { locale: requestedLocale, updatedAt: response.localization.updated_at }
    }
    applyValues(values)
  } catch (cause) {
    if (generation !== requestGeneration || locale.value !== requestedLocale || !open.value) return
    const statusCode = isRecord(cause) && typeof cause.statusCode === 'number' ? cause.statusCode : null
    if (statusCode !== 404) editorError.value = getErrorMessage(cause, 'Failed to load translation')
  } finally {
    if (generation === requestGeneration && locale.value === requestedLocale) loading.value = false
  }
}

async function save(): Promise<void> {
  const requestedLocale = locale.value
  if (!requestedLocale || loading.value) return
  saving.value = true
  editorError.value = null
  try {
    const values = serializedValues()
    if (props.saveValues) {
      await props.saveValues(requestedLocale, values)
    } else {
      await dashboardApi(
        `/api/editor/organizations/${props.organizationId}/localization/${props.resourceType}/${props.resourceId}/${encodeURIComponent(requestedLocale)}`,
        {
          method: 'PUT',
          body: {
            values,
            ...(documentRevision?.locale === requestedLocale ? { expected_updated_at: documentRevision.updatedAt } : {}),
          },
          validate: isLocalizationResponse,
        },
      )
    }
    emit('saved', requestedLocale)
    markDraftClean()
    await close()
  } catch (cause) {
    editorError.value = getErrorMessage(cause, 'Failed to save translation')
  } finally {
    saving.value = false
  }
}

function requestClose(): void {
  modalOpen.value = false
}

// A mode reached by a link opens on arrival.
watch([open, () => props.resourceId], ([value]) => {
  requestGeneration += 1
  clearDraft()
  markDraftClean()
  editorError.value = null
  if (value) void loadLanguages().then(load)
}, { immediate: true })
watch(locale, () => { void load() })
</script>
