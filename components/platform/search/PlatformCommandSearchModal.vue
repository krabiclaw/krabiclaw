<template>
  <Teleport v-if="isOpen" :to="teleportTarget">
    <div
      class="fixed inset-0 z-[120] flex items-start justify-center bg-black/35 px-4 py-8 backdrop-blur-[2px] sm:py-12"
      @click.self="close"
    >
      <div
        ref="panelRef"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="dialogTitleId"
        tabindex="-1"
        class="flex max-h-[min(80vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border shadow-[0_24px_80px_rgba(0,0,0,0.18)]"
        :class="panelClass"
        @keydown.tab="onTabKeydown"
        @keydown.esc.prevent="close"
      >
        <h2 :id="dialogTitleId" class="sr-only">{{ dialogTitle }}</h2>
        <div class="flex items-center gap-3 border-b px-4 py-3 sm:px-5" :class="headerBorderClass">
          <PlatformSearchGlyph name="search" class="size-4 shrink-0" :class="mutedTextClass" />
          <input
            ref="inputRef"
            v-model="query"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="placeholder"
            class="min-w-0 flex-1 bg-transparent text-base outline-none"
            :class="[defaultTextClass, placeholderClass]"
            @keydown.down.prevent="moveSelection(1)"
            @keydown.up.prevent="moveSelection(-1)"
            @keydown.enter.prevent="void openSelectedResult()"
          >
          <button
            type="button"
            class="rounded-lg border px-2 py-1 text-xs transition"
            :class="escButtonClass"
            @click="close"
          >
            Esc
          </button>
        </div>

        <div class="min-h-0 overflow-y-auto">
          <p v-if="searchError" role="alert" class="px-5 py-4 text-sm">{{ searchError }}</p>
          <div v-if="query.trim() && loading" class="px-5 py-10 text-sm" :class="mutedTextClass">
            {{ searchingLabel }}
          </div>

          <div v-else-if="!query.trim()" class="px-5 py-10">
            <p class="text-sm font-medium" :class="defaultTextClass">{{ dialogTitle }}</p>
            <p class="mt-2 text-sm leading-6" :class="mutedTextClass">{{ emptyStateHint }}</p>
          </div>

          <div v-else-if="!searchError && results.length === 0" class="px-5 py-10">
            <p class="text-sm font-medium" :class="defaultTextClass">{{ noResultsLabel }}</p>
            <p class="mt-2 text-sm leading-6" :class="mutedTextClass">{{ noResultsHint }}</p>
          </div>

          <div v-else class="py-3">
            <section v-for="group in groupedResults" :key="group.label" class="px-2 pb-2">
              <p
                v-if="groupedResults.length > 1"
                class="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.16em]"
                :class="dimmedTextClass"
              >
                {{ group.label }}
              </p>
              <button
                v-for="result in group.items"
                :key="result.id"
                :ref="(element) => setResultRef(result.id, element)"
                type="button"
                :class="[
                  'flex w-full items-start gap-3 rounded-2xl px-3 py-3 text-left transition',
                  selectedIndex === flatIndexById.get(result.id) ? selectedResultClass : hoverResultClass,
                ]"
                @mouseenter="selectedIndex = flatIndexById.get(result.id) ?? selectedIndex"
                @click="void openResult(result)"
              >
                <div class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border" :class="resultIconClass">
                  <PlatformSearchGlyph :name="glyphName(result.icon)" class="size-4" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-semibold" :class="defaultTextClass">{{ result.title }}</p>
                      <p class="mt-1 line-clamp-2 text-sm leading-6" :class="mutedTextClass">{{ result.snippet }}</p>
                    </div>
                    <span class="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium" :class="badgeClass">
                      {{ resultTypeLabel(result.type) }}
                    </span>
                  </div>
                  <p class="mt-2 truncate text-xs" :class="dimmedTextClass">{{ result.path }}</p>
                </div>
              </button>
            </section>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { $fetch } from 'ofetch'
import { isNavigationFailure, NavigationFailureType } from 'vue-router'
import PlatformSearchGlyph, { PLATFORM_SEARCH_GLYPHS } from '~/components/platform/search/PlatformSearchGlyph.vue'
import type { PlatformSearchGlyphName } from '~/components/platform/search/PlatformSearchGlyph.vue'
import type { ComponentPublicInstance } from 'vue'
import type { PlatformSearchPaletteSurface } from '~/composables/usePlatformSearchPalette'
import type { PublicSearchResult } from '~/server/utils/public-search'

interface SearchResponse {
  results: PublicSearchResult[]
}

const props = withDefaults(defineProps<{
  surface: PlatformSearchPaletteSurface
  variant?: 'platform' | 'tenant'
}>(), {
  variant: 'platform',
})

interface SearchPalette {
  panel: string
  headerBorder: string
  text: string
  muted: string
  dimmed: string
  placeholder: string
  esc: string
  selected: string
  hover: string
  icon: string
  badge: string
}

// Nuxt UI's semantic `--ui-*` custom properties (text-default, bg-elevated, border-default,
// etc.) are the platform's default palette.
const PLATFORM_PALETTE: SearchPalette = {
  panel: 'border-default bg-default',
  headerBorder: 'border-default',
  text: 'text-default',
  muted: 'text-muted',
  dimmed: 'text-dimmed',
  placeholder: 'placeholder:text-dimmed',
  esc: 'border-default text-dimmed hover:bg-elevated hover:text-default',
  selected: 'bg-elevated text-default',
  hover: 'hover:bg-elevated/70',
  icon: 'border-default bg-default text-muted',
  badge: 'border-default text-dimmed',
}

const palette = computed<SearchPalette>(() => PLATFORM_PALETTE)

// Platform search teleports straight to <body>. A customer site's search must
// teleport inside its layout's portal root, which sits within .tenant-theme,
// or the modal silently loses the site's palette.
const teleportTarget = computed(() => props.variant === 'tenant' ? '#tenant-portal-root' : 'body')

const panelClass = computed(() => palette.value.panel)
const headerBorderClass = computed(() => palette.value.headerBorder)
const defaultTextClass = computed(() => palette.value.text)
const mutedTextClass = computed(() => palette.value.muted)
const dimmedTextClass = computed(() => palette.value.dimmed)
const placeholderClass = computed(() => palette.value.placeholder)
const escButtonClass = computed(() => palette.value.esc)
const selectedResultClass = computed(() => palette.value.selected)
const hoverResultClass = computed(() => palette.value.hover)
const resultIconClass = computed(() => palette.value.icon)
const badgeClass = computed(() => palette.value.badge)

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { isOpen, open, close } = usePlatformSearchPalette(props.surface)
const inputRef = ref<HTMLInputElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const query = ref('')
const loading = ref(false)
const searchError = ref<string | null>(null)
const results = ref<PublicSearchResult[]>([])
const selectedIndex = ref(0)
const resultRefs = new Map<string, HTMLButtonElement>()
const dialogTitleId = useId()
// User-facing labels describe what the user is opening, not how it's stored —
// never reintroduce "Platform Pages", "Routes", or "Route" here (see issue #254).
const resultTypeMeta: Partial<Record<PublicSearchResult['type'], { badge: string, group: string }>> = {
  doc: { badge: 'Guide', group: 'Guides' },
  blog: { badge: 'Article', group: 'Articles' },
  faq: { badge: 'Answer', group: 'Help answers' },
  route: { badge: 'Link', group: 'Quick links' },
  platform_page: { badge: 'Page', group: 'Pages' },
}

const surfaceLabel = computed(() => {
  if (props.surface === 'tenant_blog') return t('site.footer.blog')
  if (props.surface === 'public') return 'KrabiClaw'
  if (props.surface === 'docs') return 'Documentation'
  if (props.surface === 'blog') return 'Blog'
  return 'Dashboard'
})

// KrabiClaw is a proper noun; the other surfaces read as ordinary nouns mid-sentence.
const surfacePhrase = computed(() => props.surface === 'public'
  ? surfaceLabel.value
  : surfaceLabel.value.toLowerCase())

const dialogTitle = computed(() => props.surface === 'tenant_blog'
  ? t('site.search.dialog_title', { surface: surfaceLabel.value })
  : `Search ${surfacePhrase.value}`)
const searchingLabel = computed(() => props.surface === 'tenant_blog'
  ? t('site.search.searching', { surface: surfaceLabel.value })
  : `Searching ${surfacePhrase.value}...`)
const noResultsLabel = computed(() => props.surface === 'tenant_blog'
  ? t('site.search.no_results')
  : 'No results found')

const placeholder = computed(() => {
  if (props.surface === 'dashboard') return 'Search dashboard, docs, blog, help...'
  if (props.surface === 'tenant_blog') return t('site.search.placeholder')
  return 'Search docs, blog, help, platform pages...'
})

const emptyStateHint = computed(() => {
  if (props.surface === 'tenant_blog') return t('site.search.hint')
  if (props.surface === 'dashboard') return 'Search docs, blog posts, support answers, and dashboard destinations.'
  return 'Search docs, blog posts, support answers, and platform pages.'
})

const noResultsHint = computed(() => {
  if (props.surface === 'tenant_blog') return t('site.search.no_results_hint')
  return 'Try a more specific task, page, or support question.'
})

const groupedResults = computed(() => {
  const groups = new Map<string, PublicSearchResult[]>()
  for (const result of results.value) {
    const label = groupLabel(result.type)
    const items = groups.get(label) ?? []
    items.push(result)
    groups.set(label, items)
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }))
})

const flatResults = computed(() => groupedResults.value.flatMap(group => group.items))
const flatIndexById = computed(() => {
  const pairs = flatResults.value.map((result, index) => [result.id, index] as const)
  return new Map<string, number>(pairs)
})

function resultTypeLabel(type: PublicSearchResult['type']) {
  if (props.surface === 'tenant_blog' && type === 'blog') return t('site.search.article')
  return resultTypeMeta[type]?.badge ?? 'Result'
}

function groupLabel(type: PublicSearchResult['type']) {
  if (props.surface === 'tenant_blog' && type === 'blog') return t('site.search.articles')
  return resultTypeMeta[type]?.group ?? 'Results'
}

function setResultRef(resultId: string, element: Element | ComponentPublicInstance | null) {
  if (element instanceof HTMLButtonElement) {
    resultRefs.set(resultId, element)
    return
  }
  resultRefs.delete(resultId)
}

function scrollSelectedResultIntoView() {
  const selected = flatResults.value[selectedIndex.value]
  if (!selected) return
  resultRefs.get(selected.id)?.scrollIntoView({ block: 'nearest' })
}

function getFocusableElements() {
  return [...(panelRef.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) ?? [])].filter(element => !element.hasAttribute('disabled') && element.tabIndex !== -1)
}

function onTabKeydown(event: KeyboardEvent) {
  const focusable = getFocusableElements()
  if (!focusable.length) {
    event.preventDefault()
    panelRef.value?.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first || !last) return
  const active = document.activeElement

  if (event.shiftKey) {
    if (active === first || active === panelRef.value) {
      event.preventDefault()
      last.focus()
    }
    return
  }

  if (active === last) {
    event.preventDefault()
    first.focus()
  }
}

function glyphName(icon: string): PlatformSearchGlyphName {
  return icon in PLATFORM_SEARCH_GLYPHS ? icon as PlatformSearchGlyphName : 'search'
}

function moveSelection(delta: number) {
  if (!flatResults.value.length) return
  const next = (selectedIndex.value + delta + flatResults.value.length) % flatResults.value.length
  selectedIndex.value = next
}

async function openSelectedResult() {
  const selected = flatResults.value[selectedIndex.value]
  if (!selected) return
  await openResult(selected)
}

async function openResult(result: PublicSearchResult) {
  try {
    const failure = await router.push(result.path)
    // Choosing the page already open is a completed selection.
    if (failure && !isNavigationFailure(failure, NavigationFailureType.duplicated)) {
      searchError.value = 'Unable to open this result: ' + failure.message
      return
    }
    close()
    query.value = ''
    searchError.value = null
    results.value = []
    selectedIndex.value = 0
  } catch (error) {
    searchError.value = 'Unable to open this result: ' + (error instanceof Error ? error.message : String(error))
  }
}

let debounceHandle: ReturnType<typeof setTimeout> | null = null
let requestSequence = 0

async function runSearch() {
  searchError.value = null
  const normalized = query.value.trim()
  if (!normalized) {
    requestSequence += 1
    results.value = []
    selectedIndex.value = 0
    loading.value = false
    return
  }

  const requestId = ++requestSequence
  loading.value = true
  try {
    const response = await $fetch<SearchResponse>('/api/public/search', {
      query: {
        q: normalized,
        surface: props.surface,
        orgSlug: typeof route.params.orgSlug === 'string' ? route.params.orgSlug : '',
        locationSlug: typeof route.params.locationSlug === 'string' ? route.params.locationSlug : '',
      },
    })
    if (requestId !== requestSequence) return
    results.value = response.results ?? []
    selectedIndex.value = 0
  } catch (error) {
    if (requestId !== requestSequence) return
    searchError.value = 'Search failed: ' + (error instanceof Error ? error.message : String(error))
    results.value = []
    selectedIndex.value = 0
  } finally {
    if (requestId === requestSequence) {
      loading.value = false
    }
  }
}

watch(query, () => {
  if (debounceHandle) clearTimeout(debounceHandle)
  debounceHandle = setTimeout(() => {
    void runSearch()
  }, 120)
})

watch(selectedIndex, async () => {
  await nextTick()
  scrollSelectedResultIntoView()
})

watch(isOpen, async (openNow) => {
  if (!openNow) {
    requestSequence += 1
    query.value = ''
    searchError.value = null
    results.value = []
    selectedIndex.value = 0
    loading.value = false
    resultRefs.clear()
    return
  }
  await nextTick()
  inputRef.value?.focus()
  inputRef.value?.select()
  scrollSelectedResultIntoView()
})

function onGlobalKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  const tagName = target?.tagName
  const isTypingField = tagName === 'INPUT' || tagName === 'TEXTAREA' || target?.isContentEditable

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    open()
    return
  }

  if (props.surface !== 'dashboard' && !isOpen.value && event.key === '/' && !isTypingField) {
    event.preventDefault()
    open()
  }
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  if (debounceHandle) clearTimeout(debounceHandle)
  window.removeEventListener('keydown', onGlobalKeydown)
})
</script>
