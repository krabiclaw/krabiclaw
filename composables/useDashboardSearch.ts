import type { CommandPaletteGroup, CommandPaletteItem } from '@nuxt/ui'
import type { PublicSearchResult } from '~/server/utils/public-search'
import { dashboardFetch } from '~/composables/dashboardFetch'

interface SearchResponse {
  results: PublicSearchResult[]
}

type PaletteGroup = CommandPaletteGroup

const RESULT_GROUP_LABEL: Partial<Record<PublicSearchResult['type'], string>> = {
  product: 'Catalog',
  collection: 'Catalog',
  location: 'Locations',
  qa: 'Q&A',
  post: 'Posts',
  page: 'Pages',
  blog: 'Articles',
  thread: 'Messages',
  member: 'Team',
  media: 'Photos',
  doc: 'Guides',
  faq: 'Help answers',
}

/**
 * Drives UDashboardSearch in layouts/dashboard.vue: the dashboard's one search.
 * The business's own records come from /api/dashboard/search (AI Search, one
 * corpus, filtered to the site the palette is open on); the settings rows come
 * from the same navigation the Menu shows, filtered in the palette itself.
 */
export function useDashboardSearch() {
  const router = useRouter()
  const menu = useDashboardMenu()
  const navigation = useOrganizationSettingsNavigation(menu.organization, menu.scopeModel)
  const searchTerm = ref('')
  const loading = ref(false)
  /** Why the last search failed; the palette shows it in place of results. */
  const requestError = ref<string | null>(null)
  const error = computed(() => navigation.error.value ? getErrorMessage(navigation.error.value, 'The Menu could not be loaded.') : requestError.value)
  const results = shallowRef<PaletteGroup[]>([])

  // The Menu's rows, for the palette's own filter to work through.
  function navigationGroups(): PaletteGroup[] {
    const groups: PaletteGroup[] = []
    for (const group of navigation.groups.value) {
      const items: CommandPaletteItem[] = []
      for (const item of group.items) {
        const to = item.to
        if (!to) continue
        items.push({ id: item.id, label: item.label, suffix: item.summary, icon: item.icon, onSelect: () => { void router.push(to) } })
      }
      if (items.length) groups.push({ id: `nav-${group.id}`, label: group.label ?? 'Menu', items })
    }
    return groups
  }

  // The business's records from the server first, then the Menu's rows.
  const groups = computed<PaletteGroup[]>(() => results.value.concat(navigationGroups()))

  let debounceHandle: ReturnType<typeof setTimeout> | null = null
  let requestSequence = 0

  function groupResults(rows: PublicSearchResult[]): PaletteGroup[] {
    const byLabel = new Map<string, CommandPaletteItem[]>()
    for (const result of rows) {
      const label = RESULT_GROUP_LABEL[result.type] ?? 'Results'
      const items = byLabel.get(label) ?? []
      const item: CommandPaletteItem = {
        id: result.id,
        label: result.title,
        // A record with no words of its own repeats its title as its snippet; once is enough.
        suffix: result.snippet === result.title ? undefined : result.snippet,
        icon: `i-lucide-${result.icon}`,
        onSelect: () => { void router.push(result.path) },
      }
      items.push(item)
      byLabel.set(label, items)
    }
    // Results are already server-filtered against searchTerm — ignoreFilter stops
    // CommandPalette's own client-side Fuse re-filtering from hiding relevant
    // matches the server already decided to return.
    return [...byLabel.entries()].map(([label, items]) => ({ id: label, label, items, ignoreFilter: true }))
  }

  let activeController: AbortController | null = null

  async function runSearch() {
    activeController?.abort()
    activeController = null
    const normalized = searchTerm.value.trim()
    const organization = menu.organization.value
    if (!normalized || !organization) {
      requestSequence += 1
      results.value = []
      requestError.value = null
      loading.value = false
      return
    }

    const requestId = ++requestSequence
    const controller = new AbortController()
    activeController = controller
    loading.value = true
    requestError.value = null
    try {
      const response = await dashboardFetch<SearchResponse>('/api/dashboard/search', { orgSlug: organization.slug }, {
        signal: controller.signal,
        validate: validateApiShape({ results: 'array' }),
        query: { q: normalized },
      })
      if (requestId !== requestSequence || controller.signal.aborted || menu.organization.value?.id !== organization.id) return
      results.value = groupResults(response.results ?? [])
    } catch (failure) {
      // A search the next keystroke cancelled was replaced, not failed.
      if (requestId !== requestSequence || controller.signal.aborted || menu.organization.value?.id !== organization.id) return
      results.value = []
      requestError.value = getErrorMessage(failure, 'Search failed')
    } finally {
      if (activeController === controller) activeController = null
      if (requestId === requestSequence) loading.value = false
    }
  }

  watch([searchTerm, () => menu.organization.value?.id], ([_term, organizationId], [_previousTerm, previousOrganizationId]) => {
    if (debounceHandle) clearTimeout(debounceHandle)
    activeController?.abort()
    requestSequence += 1
    if (organizationId !== previousOrganizationId) {
      results.value = []
      requestError.value = null
      loading.value = false
    }
    debounceHandle = setTimeout(() => { void runSearch() }, 120)
  })

  onBeforeUnmount(() => {
    if (debounceHandle) clearTimeout(debounceHandle)
    activeController?.abort()
    activeController = null
  })

  return { searchTerm, loading: computed(() => loading.value || navigation.pending.value), error, groups }
}
