import { matchedRouteKey } from 'vue-router'

/**
 * Which level of the route tree the caller is, what is open below it, and
 * where walking up from it goes.
 *
 * The nested route tree is the one parent graph. A level's parent pane and its
 * Back are the same record: the nearest level above it in `route.matched`, found
 * from the record the `<RouterView>` rendering the caller provides through
 * `matchedRouteKey`. A level's URL is its place in the file tree, so the URL,
 * the panes and Back all name the same parent. Levels are counted in matched
 * records, not URL segments, because a directory's `index.vue` adds a record
 * without adding a level.
 *
 * A directory's `index.vue` is a second record at the same URL — `/links/items`
 * matches both `items` and `items/index` — and it is one level, not two.
 *
 * `meta.back` is a destination root's exit: `menu` for the shell's Menu —
 * Website, Account settings — or a named route, Payments to Earnings. A level with a matched
 * parent that declares one would give Back and the pane layout two different
 * parents, so it is refused. Which tab is lit is a separate declaration,
 * `meta.tab`, read by the layout; it never follows an exit.
 *
 * Back is a push to the parent, never `history.back()`. Measured on a live
 * Airbnb host account on 2026-09-21: their in-app Back went to
 * `/hosting/listings` while the previous history entry was the leaf that had
 * just been cancelled, and Cancel, Close and Back all pushed. The destination
 * is a property of where you are, so a deep link, a reload and a redirect after
 * a save all answer the same thing, and a sheet you closed can never become the
 * place Back leads.
 */
export type RouteLevelMode = 'index' | 'pair' | 'yield'

type AppRouter = ReturnType<typeof useRouter>
type RouteRecord = ReturnType<AppRouter['getRoutes']>[number]

/** The matched records that are levels: each directory `index.vue` folds into the record it shares a URL with. */
function levelsOf<T extends RouteRecord>(matched: readonly T[]) {
  return matched.filter((record, at) => at === 0 || record.path !== matched[at - 1]!.path)
}

/**
 * The URL a route record renders at, with the current params its own path names.
 * A record with an `index.vue` child carries no name of its own; the child that
 * shares its URL does. The router refuses a named target handed params it has
 * no place for, so only the record's own keys are passed.
 */
export function routeRecordPath(router: AppRouter, record: RouteRecord, params: Record<string, unknown>): string {
  const name = record.name ?? record.children.find(child => child.path === '')?.name
  if (typeof name !== 'string') throw new Error(`Route record "${record.path}" has no name and no index child to resolve it by`)
  const keys = [...record.path.matchAll(/:(\w+)/g)].map(match => match[1]!)
  const own: Record<string, string | string[]> = {}
  for (const key of keys) {
    const value = params[key]
    if (typeof value !== 'string' && !Array.isArray(value)) throw new Error(`Route "${name}" needs the "${key}" param, which the current route does not carry`)
    own[key] = value
  }
  return router.resolve({ name, params: own }).path
}

export function useRouteLevel() {
  // Nuxt's page route: while a page is on its way out, it keeps the route that
  // page rendered for, so the screen being left stays whole until the next one
  // is ready (Nuxt's RouteProvider).
  const route = useRoute()
  const router = useRouter()
  // The shell's Menu, for a root whose exit is `menu`.
  const menu = useDashboardMenu()
  // The record this level renders, read once: a component is mounted for one
  // record and never becomes another. Vue Router's ref follows the live route,
  // so during a navigation it named the next screen's record while `route`
  // still named this one — the level found itself nowhere, yielded, and its
  // pane vanished while its open child stayed on screen.
  const ownRecord = inject(matchedRouteKey, null)?.value ?? null

  const levels = computed(() => levelsOf(route.matched))

  /**
   * Where this level sits among the matched levels, or `-1` once it sits nowhere.
   *
   * A component whose own record is not in its route is not a level any more.
   * Answering with the deepest level instead makes every question below report
   * for somebody else's level.
   *
   * A component mounted outside a page has no record to find and takes the
   * deepest level, which is the one it is drawn inside.
   */
  const index = computed(() => {
    if (!ownRecord) return levels.value.length - 1
    return levels.value.findIndex(level => level.path === ownRecord.path)
  })

  /**
   * How much is open below this level. Two levels are on screen at once unless
   * the immediate child declares that it needs the frame. Anything deeper also
   * belongs to a descendant, so this level renders only the route beneath it.
   */
  const mode = computed<RouteLevelMode>(() => {
    if (index.value === -1) return 'yield'
    const below = levels.value.length - 1 - index.value
    if (below === 0) return 'index'
    if (below === 1) return levels.value[index.value + 1]?.meta.dashboardFrame === true ? 'yield' : 'pair'
    return 'yield'
  })

  const urlOf = (record: RouteRecord) => routeRecordPath(router, record, route.params)

  /** This level's own URL, which is where dismissing what it has open leads. */
  const path = computed(() => {
    const record = levels.value[index.value]
    return record ? urlOf(record) : route.path
  })

  /** Names the open child — the last segment of the level below — for the active row and for a section that is a screen of its own. */
  const child = computed<string | null>(() => {
    const record = levels.value[index.value + 1]
    return index.value === -1 || !record ? null : urlOf(record).split('/').filter(Boolean).at(-1) ?? null
  })

  /**
   * Where Back goes, or `null` at a tab root, which has nothing above it.
   * The query rides along, as it does through `close()`: the calendar's
   * location and view are in it, and a leaf's Close must land on the same
   * calendar it came from.
   */
  const to = computed<string | null>(() => {
    if (index.value === -1) return null
    const own = levels.value[index.value]!
    const parent = levels.value[index.value - 1]
    const declared = own.meta?.back
    if (parent && declared !== undefined) {
      throw new Error(`Route "${own.path}" declares meta.back but is nested under "${parent.path}"; its route parent is its Back`)
    }
    const path = parent ? urlOf(parent) : declared === 'menu' ? menu.menuPageTo.value : typeof declared === 'string' ? resolveNamed(declared) : null
    return path === null ? null : router.resolve({ path, query: route.query }).fullPath
  })

  /** A root's declared destination, which may sit in another workspace. */
  function resolveNamed(name: string): string | null {
    const target = router.getRoutes().find(candidate => candidate.name === name)
    if (!target) throw new Error(`Route "${name}" named in meta.back does not exist`)
    const keys = [...target.path.matchAll(/:(\w+)/g)].map(match => match[1]!)
    const missing = keys.find(key => route.params[key] === undefined)
    if (missing) throw new Error(`Route "${name}" named in meta.back needs the "${missing}" param, which "${route.path}" does not carry`)
    return routeRecordPath(router, target, route.params)
  }

  /**
   * Dismissing a child — a sheet's Close, a drawer that shuts — is the same
   * navigation as that child's own Back, so it is a push to here.
   */
  function close() {
    return navigateTo({ path: path.value, query: route.query })
  }

  return { mode, to, path, child, close }
}
