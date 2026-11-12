// Which public paths a route already claims, derived from the real route table.
//
// A tenant page document renders at a path only when nothing else answers that
// path first, so the writer has to know what Nuxt and Nitro already claim.
// Transcribing that by hand is what broke /services: pages/services/[slug].vue
// was deleted and the hand list was not, leaving six tenant pages uneditable.
// This reads the resolved route tree instead, so deleting a file under pages/
// frees its path in the same build.

/** A claim is one segment (`[param]`), a whole subtree (`[...slug]`), or exact. */
export interface ClaimedRoute {
  /** Path with `:param` segments kept, so segment count is preserved. */
  pattern: string
  /** True for `[...slug]`: the pattern's prefix claims every deeper path. */
  subtree: boolean
}

interface RouteTreeNode {
  path: string
  children?: readonly RouteTreeNode[]
  alias?: string | readonly string[]
  file?: string
}

// The catch-all is what renders an unclaimed path, so it never claims one.
const TENANT_CATCH_ALL_SEGMENT = ':tenant_path('

// Reserve the API namespace, plus build output and Worker media served before
// routes. File-based server routes are collected from Nitro's scanned handlers.
const NON_ROUTE_CLAIMED_SUBTREES = ['/api', '/_nuxt', '/__media']

function joinRoutePath(parent: string, child: string): string {
  // A child path that is already rooted is absolute in vue-router and replaces
  // the parent's path rather than extending it.
  if (child.startsWith('/')) return child
  if (!child) return parent
  return `${parent === '/' ? '' : parent}/${child}`
}

function normalizePattern(pattern: string): string {
  const trimmed = pattern.replace(/\/+$/, '')
  return trimmed || '/'
}

function isSubtreePattern(pattern: string): boolean {
  // vue-router spells a catch-all `:slug(.*)*` or `:slug(.*)`; Nuxt generates
  // both shapes from `[...slug]`.
  return /:[^/]*\(\.\*\)\*?$/.test(pattern)
}

function subtreeBase(pattern: string): string {
  return normalizePattern(pattern.replace(/\/?:[^/]*\(\.\*\)\*?$/, ''))
}

function collectPatterns(nodes: readonly RouteTreeNode[], parent: string, into: Set<string>): void {
  for (const node of nodes) {
    const paths = [node.path, ...(typeof node.alias === 'string' ? [node.alias] : node.alias ?? [])]
    for (const path of paths) {
      const joined = normalizePattern(joinRoutePath(parent, path))
      // A node with children may be a layout wrapper with no page of its own,
      // but claiming its path is still correct: vue-router resolves it.
      if (!joined.includes(TENANT_CATCH_ALL_SEGMENT)) into.add(joined)
      if (node.children?.length) collectPatterns(node.children, joined, into)
    }
  }
}

/**
 * Flatten Nuxt's resolved page tree into the paths it claims.
 *
 * `pages` is a tree: nested directories arrive as `children` whose `path` is
 * relative unless it is already rooted. Reading only the top level, the way
 * localized-public-routes.ts safely can for its own purpose, would miss every
 * nested route and hand the writer a path the renderer never reaches.
 */
export function claimedRoutesFromPages(pages: readonly RouteTreeNode[]): ClaimedRoute[] {
  const patterns = new Set<string>()
  collectPatterns(pages, '', patterns)
  return claimedRoutesFromPatterns(patterns)
}

/**
 * Nitro handler routes, minus the ones that answer everything.
 *
 * Middleware runs on every request and the SSR renderer is registered on `/**`,
 * so including either would claim the whole site and reserve every tenant path.
 */
export function claimedRoutesFromHandlers(
  handlers: readonly { route?: string; middleware?: boolean }[],
): ClaimedRoute[] {
  const patterns = new Set<string>()
  for (const handler of handlers) {
    if (handler.middleware) continue
    const route = handler.route?.trim()
    // '/**' and '/*' are the patterns that answer everything; an exact '/' is an
    // ordinary claim on the root and is kept.
    if (!route || route === '/**' || route === '/*') continue
    patterns.add(normalizePattern(route.replaceAll('/**', '/:rest(.*)').replaceAll('/*', '/:one')))
  }
  return claimedRoutesFromPatterns(patterns)
}

function claimedRoutesFromPatterns(patterns: Iterable<string>): ClaimedRoute[] {
  const claims = new Map<string, ClaimedRoute>()
  for (const pattern of patterns) {
    const subtree = isSubtreePattern(pattern)
    const key = subtree ? subtreeBase(pattern) : pattern
    // A subtree claim subsumes an exact one at the same base.
    if (subtree || !claims.has(key)) claims.set(key, { pattern: key, subtree })
  }
  return [...claims.values()].sort((a, b) => a.pattern.localeCompare(b.pattern))
}

export function nonRouteClaimedRoutes(): ClaimedRoute[] {
  return NON_ROUTE_CLAIMED_SUBTREES.map(pattern => ({ pattern, subtree: true }))
}

export function mergeClaimedRoutes(...groups: readonly ClaimedRoute[][]): ClaimedRoute[] {
  return claimedRoutesFromPatterns(
    groups.flat().map(claim => (claim.subtree ? `${claim.pattern}/:rest(.*)` : claim.pattern)),
  )
}
