// Whether a site may hold a tenant page document at a path.
//
// One rule, over the two things that decide it: what the site's template maps to
// a page document, and what the route table already claims. It replaced six
// hand-maintained lists that disagreed with each other — the last disagreement
// left six NCLS pages uneditable for two months, because pages/services/ was
// deleted and a reserved list was not.

import type { ClaimedRoute } from '../build/claimed-public-routes'
import type { PublicTemplateDefinition } from '../utils/template-registry'

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

/** Paths where this template renders a tenant page document. */
export function templatePageDocumentPaths(template: PublicTemplateDefinition): string[] {
  return [...new Set([...Object.values(template.pageDocuments.recipes), ...template.pageDocuments.paths])]
}

export function templateRendersPageDocumentAt(template: PublicTemplateDefinition, path: string): boolean {
  return templatePageDocumentPaths(template).includes(path)
    || (template.pageDocuments.patterns ?? []).some(pattern => patternMatchesPath({ pattern, subtree: false }, path))
    || template.pageDocuments.prefixes.some(prefix => path.startsWith(prefix))
}

/**
 * A site may hold a page document at a path when its template renders one
 * there, or when the template reaches unclaimed paths through
 * pages/[...tenantPath].vue and nothing claims this one.
 *
 * Reaching the catch-all is a template property, not a universal one: the
 * catch-all throws 404 for platform sites, so the platform template can hold no
 * tenant page at all until its own renderer reads page documents.
 */
export function templateAllowsPageDocumentAt(
  template: PublicTemplateDefinition,
  claims: readonly ClaimedRoute[],
  path: string,
): boolean {
  if (templateRendersPageDocumentAt(template, path)) return true
  if (!template.pageDocuments.catchAll) return false
  return !isClaimedPublicPath(claims, path)
}
