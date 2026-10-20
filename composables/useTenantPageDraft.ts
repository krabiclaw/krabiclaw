import { slugifyTitle } from '~/utils/post-slugs'
import type { TenantPageBlock, TenantPageType } from '~/utils/tenant-page-blocks'

/**
 * One page, one draft, one commit.
 *
 * A page stores its whole self in a single content document, so every level of
 * the Pages chain — the page's own fields, its sections, a section's parts, a
 * record inside one of those — edits the same snapshot and persists through the
 * same PATCH. This composable is where that snapshot lives, so no level has to
 * know how any other level saves.
 *
 * The draft is `useState` keyed to the record rather than a `reactive` here:
 * moving between levels remounts the component that was showing the draft, and
 * a plain `reactive` loses it on the way (`DESIGN.md`, Creating).
 */
export interface TenantPageDraft {
  id: string
  page_id: string
  product_id?: string | null
  locale: string
  path: string
  title: string
  summary: string
  page_type: TenantPageType
  recipe: string
  sort_order: number
  blocks: TenantPageBlock[]
}

export interface TenantPageResponse {
  id: string
  page_id: string
  product_id?: string | null
  organization_id: string
  locale: string
  path: string
  title: string
  summary: string | null
  page_type: TenantPageType
  recipe: string | null
  sort_order: number
  blocks: TenantPageBlock[]
  document: { updated_at: string }
  updated_at: string
}

export interface TenantPageListRow {
  id: string
  page_id: string
  locale: string
  path: string
  title: string
  page_type: TenantPageType
  recipe: string | null
  sort_order: number
  updated_at: string
  /** The product the source page belongs to, or null for an ordinary page. */
  product_id: string | null
  /** False when the site's template renders a document at this path; see deleteTenantPage. */
  removable: boolean
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === 'string'
}

export function isTenantPageResponse(value: unknown): value is { page: TenantPageResponse } {
  if (!isRecord(value) || !isRecord(value.page)) return false
  const page = value.page
  return ['id', 'page_id', 'organization_id', 'locale', 'path', 'title', 'page_type', 'updated_at']
    .every(field => typeof page[field] === 'string')
    && ['summary', 'recipe'].every(field => isOptionalString(page[field]))
    && typeof page.sort_order === 'number'
    && Array.isArray(page.blocks)
    && isRecord(page.document) && typeof page.document.updated_at === 'string'
}

export interface TenantPageRow {
  id: string
  recipe: string | null
  title: string
  summary: string
  /** Stated by the server: a page the template renders a document at cannot be removed. */
  removable: boolean
  /** The delete endpoint takes the timestamp the row was last seen at. */
  updatedAt: string
}

/**
 * The rows the Pages list shows, in its order: every page document, including
 * a page a product owns — Pages is where every page is edited. The links page
 * leads: it is the page a tenant shares most, it opens its own editor, and it
 * is listed before its row exists because that editor creates the row on the
 * first save. Then the front page, then the rest.
 */
export function tenantPageRows(pages: readonly TenantPageListRow[]): TenantPageRow[] {
  const links = pages.find(page => page.recipe === 'links')
  return [
    { id: links?.id ?? 'links', recipe: 'links', title: 'Links page', summary: '/links', removable: false, updatedAt: links?.updated_at ?? '' },
    ...pages
      .filter(page => page.recipe !== 'links')
      .sort((left, right) => Number(right.path === '/') - Number(left.path === '/'))
      .map(page => ({
        id: page.id,
        recipe: page.recipe,
        title: page.path === '/' ? 'Home' : page.title,
        summary: page.path === '/' ? 'Homepage' : page.path,
        removable: page.removable,
        updatedAt: page.updated_at,
      })),
  ]
}

export function isTenantPageListResponse(value: unknown): value is { pages: TenantPageListRow[] } {
  return isRecord(value) && Array.isArray(value.pages)
    && value.pages.every(page => isRecord(page) && typeof page.id === 'string'
      && typeof page.page_id === 'string' && typeof page.title === 'string' && typeof page.path === 'string'
      && (page.product_id === null || typeof page.product_id === 'string')
      && typeof page.removable === 'boolean')
}

function isEditorContextResponse(value: unknown): value is { context: { previewToken: string; sourceLocale: string; organization: { subdomain: string | null } } } {
  return isRecord(value) && isRecord(value.context) && typeof value.context.previewToken === 'string' && typeof value.context.sourceLocale === 'string'
    && isRecord(value.context.organization)
}

function emptyDraft(sourceLocale = ''): TenantPageDraft {
  return {
    id: '',
    page_id: '',
    locale: sourceLocale,
    path: '',
    title: '',
    summary: '',
    page_type: 'custom',
    recipe: '',
    sort_order: 0,
    blocks: [],
  }
}

function toDraft(page: TenantPageResponse): TenantPageDraft {
  return {
    id: page.id,
    page_id: page.page_id,
    product_id: page.product_id,
    locale: page.locale,
    path: page.path,
    title: page.title,
    summary: page.summary ?? '',
    page_type: page.page_type,
    recipe: page.recipe ?? '',
    sort_order: page.sort_order,
    blocks: structuredClone(toRaw(page.blocks)),
  }
}

export function useTenantPageDraft(organizationId: string, pageId: string) {
  const dashboardApi = useDashboardApi()
  const runtimeConfig = useRuntimeConfig()
  const isNew = computed(() => pageId === 'new')
  const key = `tenant-page-${organizationId}-${pageId}`

  // Every level calls this, and Nuxt shares one request and one state per key,
  // so opening a leaf four levels down costs no fetch the page has not made.
  // The page level awaits `load`, so every level below renders the loaded page.
  const load = useAsyncData(
    key,
    async () => {
      const [context, page] = await Promise.all([
        dashboardApi<{ context: { previewToken: string; sourceLocale: string; organization: { subdomain: string | null } } }>(
          `/api/editor/organizations/${organizationId}/context`,
          { validate: isEditorContextResponse },
        ),
        pageId === 'new'
          ? Promise.resolve(null)
          : dashboardApi<{ page: TenantPageResponse }>(`/api/editor/organizations/${organizationId}/pages/${pageId}`, { validate: isTenantPageResponse }),
      ])
      return { context: context.context, page: page?.page ?? null }
    },
  )
  const { data, error } = load

  const draft = useState<TenantPageDraft>(`${key}-draft`, emptyDraft)
  /** The draft as it was last seeded or committed, so Save knows there is something to save. */
  const baseline = useState<string>(`${key}-baseline`, () => JSON.stringify(emptyDraft()))
  /** Which loaded document the draft was seeded from, so a re-read does not discard an edit. */
  const seededFrom = useState<string>(`${key}-seeded-from`, () => '')

  /** The page the draft was last seeded from — what `revert`, `savedBlockIds` and the preview read. */
  const accepted = useState<TenantPageResponse | null>(`${key}-accepted`, () => null)

  function seed(page: TenantPageResponse | null) {
    accepted.value = page
    draft.value = page ? toDraft(page) : emptyDraft(data.value?.context.sourceLocale)
    baseline.value = JSON.stringify(draft.value)
    seededFrom.value = page?.document.updated_at ?? 'new'
  }

  watch(data, (value) => {
    if (!value) return
    const stamp = value.page?.document.updated_at ?? 'new'
    if (seededFrom.value === stamp) return
    // Every level that opens re-reads this key, so a read can still be in
    // flight when the level above it writes. Landing afterwards, that read is
    // not an update — it is the page as it was before the write, and seeding it
    // put the editor back a step: a section created a moment ago was gone from
    // the draft while its row existed in D1, and the route that had just been
    // sent to it answered "not found".
    if (stamp !== 'new' && seededFrom.value && seededFrom.value !== 'new' && stamp < seededFrom.value) {
      // And it does not get to sit in `data` either, or revert, the saved-block
      // set and the preview would read the page as it was before the write.
      data.value = { ...value, page: accepted.value }
      return
    }
    seed(value.page)
    // `flush: 'sync'`, because a queued watcher never runs during the server
    // render: the read above resolves after this composable's setup, and a
    // deferred seed left every level rendering the empty draft server-side —
    // hydration mismatches, and controls that came back disabled because the
    // page they describe was not there yet when the markup was made.
  }, { immediate: true, flush: 'sync' })

  const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)

  /** Discards the draft and returns to the values the page was loaded with. */
  function revert() {
    seed(data.value?.page ?? null)
  }

  /**
   * A block exists as a `content_blocks` row only once the page has been saved
   * with it present. Before that its gallery has nothing to attach to, so the
   * gallery leaf edits media locally instead of calling the placement routes.
   */
  const savedBlockIds = computed(() => new Set((data.value?.page?.blocks ?? []).map(block => block.id)))

  /**
   * The preview is the site on its own host, never a platform-hosted copy, so
   * links, navigation and templates are exactly the public ones.
   */
  const previewUrl = computed(() => {
    const page = data.value?.page
    const token = data.value?.context.previewToken
    const subdomain = data.value?.context.organization.subdomain
    if (!page || !token || !subdomain) return ''
    const path = page.path === '/' ? '' : page.path
    const localizedPath = page.id === page.page_id ? path : `/${page.locale}${path}`
    const origin = tenantOrganizationOrigin({
      platformDomain: String(runtimeConfig.public.platformDomain),
      freeOrganizationDomain: String(runtimeConfig.public.freeOrganizationDomain),
      subdomain,
    })
    if (!origin) return ''
    const url = new URL(`${origin}${localizedPath || '/'}`)
    url.searchParams.set('preview_token', token)
    return url.toString()
  })

  /**
   * The whole page, every time. Adding a section, renaming it, reordering the
   * list and editing a button four levels down are all this one write, which is
   * what keeps a single snapshot the source of truth at every depth.
   */
  async function commit(): Promise<TenantPageResponse> {
    const title = draft.value.title.trim()
    if (!title) throw new Error('Add a page title before saving.')
    const blocks = draft.value.blocks.map((block, position) => ({ ...block, position }))
    // The server takes the path as given; deriving it from the title is the
    // editor's job, and only while the page does not exist yet.
    const path = draft.value.id ? draft.value.path : `/${slugifyTitle(title)}`
    if (!draft.value.id && path === '/') throw new Error('Choose a more specific page title.')
    const body = {
      id: draft.value.id || undefined,
      pageId: draft.value.page_id || undefined,
      productId: draft.value.id && draft.value.id === draft.value.page_id ? draft.value.product_id : undefined,
      locale: draft.value.locale,
      path,
      title,
      summary: draft.value.summary,
      pageType: draft.value.page_type,
      recipe: draft.value.recipe || null,
      sortOrder: draft.value.sort_order,
      blocks,
      // Optimistic concurrency: a page another writer changed under us comes
      // back 409, which stays on screen as an error the tenant can retry.
      // The stamp the draft was seeded from, not whatever the last read left
      // in `data`: those are the same page except when a straggler read is
      // ignored above, and then only this one describes what is being edited.
      expectedUpdatedAt: draft.value.id ? seededFrom.value : undefined,
    }
    const response = draft.value.id
      ? await dashboardApi<{ page: TenantPageResponse }>(`/api/editor/organizations/${organizationId}/pages/${draft.value.id}`, { method: 'PATCH', body, validate: isTenantPageResponse })
      : await dashboardApi<{ page: TenantPageResponse }>(`/api/editor/organizations/${organizationId}/pages`, { method: 'POST', body, validate: isTenantPageResponse })
    if (data.value) data.value = { ...data.value, page: response.page }
    seed(response.page)
    return response.page
  }

  return { load, data, error, draft, dirty, revert, commit, isNew, savedBlockIds, previewUrl }
}

/**
 * The section being added, before the page has one.
 *
 * It lives beside the page draft rather than in the component that started it:
 * choosing a type and filling in what the type needs are two levels, and the
 * level that owns the commit bar changes between them.
 */
export function useTenantPageNewBlock(organizationId: string, pageId: string) {
  return useState<TenantPageBlock | null>(`tenant-page-new-block-${organizationId}-${pageId}`, () => null)
}

/**
 * The block a route points at: the page draft's own object, or the pending new
 * one. Every screen that edits a block resolves it here, so a control writes
 * the draft rather than a copy handed down as a prop.
 */
export function useTenantPageBlock(organizationId: string, pageId: string, blockId: MaybeRefOrGetter<string>) {
  const { draft } = useTenantPageDraft(organizationId, pageId)
  const newBlock = useTenantPageNewBlock(organizationId, pageId)
  return computed<TenantPageBlock>(() => {
    const id = toValue(blockId)
    const existing = draft.value.blocks.find(item => item.id === id)
    if (existing) return existing
    // The pending block answers to the route that creates it and to its own
    // id, and to nothing else: returning it for any unknown id meant a stale
    // link edited the new block instead of saying the section was gone.
    if (newBlock.value && (id === 'new' || id === newBlock.value.id)) return newBlock.value
    throw createError({ statusCode: 404, statusMessage: 'Section not found' })
  })
}
