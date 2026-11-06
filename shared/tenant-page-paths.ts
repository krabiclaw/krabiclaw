import { ARTICLE_COLLECTIONS } from '../utils/article-collections'
// Whether a site may hold a tenant page document at a path.
//
// One rule, over the two things that decide it: what the shared site definition maps to
// a page document, and what the route table already claims. It replaced six
// hand-maintained lists that disagreed with each other — the last disagreement
// left six NCLS pages uneditable for two months, because pages/services/ was
// deleted and a reserved list was not.

import type { ClaimedRoute } from '../build/claimed-public-routes'
import type { PublicSiteDefinition } from '../utils/site-routing'

/**
 * Does a route pattern cover this concrete path?
 *
 * Patterns keep their `:param()` segments so segment counts are preserved: a
 * `[param]` claims exactly one segment, and only a `[...slug]` claims a subtree.
 * `/blog/:slug()` therefore says nothing about `/blog/a/b`.
 */
function patternMatchesPath(claim: ClaimedRoute, path: string): boolean {
  const claimSegments = claim.pattern.split('/').filter(Boolean).map(parseClaimSegment)
  const pathSegments = path.split('/').filter(Boolean)
  // A trailing `?` or `*` segment may be absent from the path it claims.
  while (claimSegments.length > pathSegments.length && claimSegments[claimSegments.length - 1]!.optional) claimSegments.pop()
  if (claim.subtree ? pathSegments.length < claimSegments.length : pathSegments.length !== claimSegments.length) {
    return false
  }
  return claimSegments.every((segment, index) => segment.matches(pathSegments[index]!))
}

function parseClaimSegment(segment: string): { optional: boolean; matches: (value: string) => boolean } {
  // `:name(pattern)` carries a constraint — the locale aliases are
  // `:locale(th)` — and honouring it keeps `/foo/about` unclaimed while
  // `/th/about` is claimed. A trailing `*`, `+` or `?` is vue-router's repeat
  // modifier; how many segments a claim covers is `claim.subtree`'s job, and
  // `?` and `*` additionally allow the segment to be absent.
  const param = /^:[\w-]+(?:\((.*)\))?([*+?])?([^()]*)$/.exec(segment)
  if (!param) return { optional: false, matches: value => segment.toLowerCase() === value.toLowerCase() }
  const constraint = param[1] || '.+'
  // Nitro keeps static suffixes, e.g. :slug.md; those claim only .md paths.
  const suffix = param[3]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`^(?:${constraint})${suffix}$`, 'i')
  return { optional: param[2] === '?' || param[2] === '*', matches: value => matcher.test(value) }
}

export function isClaimedPublicPath(claims: readonly ClaimedRoute[], path: string): boolean {
  return claims.some(claim => patternMatchesPath(claim, path))
}

/** Paths where this site renders a tenant page document. */
export function sitePageDocumentPaths(site: PublicSiteDefinition): string[] {
  return [...new Set([...Object.values(site.pageDocuments.recipes), ...site.pageDocuments.paths])]
}

export function siteRendersPageDocumentAt(site: PublicSiteDefinition, path: string): boolean {
  // Article indexes read optional authored titles and summaries on every site.
  return Object.values(ARTICLE_COLLECTIONS).some(collection => collection.pathPrefix === path)
    || sitePageDocumentPaths(site).includes(path)
    || (site.pageDocuments.patterns ?? []).some(pattern => patternMatchesPath({ pattern, subtree: false }, path))
    || site.pageDocuments.prefixes.some(prefix => path.startsWith(prefix))
}

/** A document is writable where the shared renderer reads it, or on an unclaimed path. */
export function siteAllowsPageDocumentAt(
  site: PublicSiteDefinition,
  claims: readonly ClaimedRoute[],
  path: string,
): boolean {
  if (siteRendersPageDocumentAt(site, path)) return true
  return !isClaimedPublicPath(claims, path)
}
