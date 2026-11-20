import { readdirSync } from 'node:fs'

import { isLocalizedPublicAliasPath, DOCUMENT_ONLY_PUBLIC_PATHS } from '../shared/public-locale-routes'

const localizedCatalogLocales = readdirSync(new URL('../i18n/catalogs/', import.meta.url))
  .flatMap(file => /^([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(file)?.[1] ?? [])

if (!localizedCatalogLocales.length) throw new Error('At least one reviewed localized platform catalog is required')

const localeRouteSegment = `:locale(${localizedCatalogLocales.join('|')})`

export function localizedPublicRouteAliases<T extends { name?: string; path: string }>(pages: readonly T[]): T[] {
  return pages.flatMap((page) => {
    // A one-segment path is ambiguous with a tenant CMS page. The catch-all
    // resolves that path against the tenant's published locales at runtime.
    if (!page.name || page.path === '/' || !isLocalizedPublicAliasPath(page.path)) return []
    return [{
      ...page,
      name: `localized-${page.name}`,
      path: `/${localeRouteSegment}${page.path}`,
    }]
  })
}

export const publicDocumentRouteRules = Object.fromEntries(DOCUMENT_ONLY_PUBLIC_PATHS.flatMap(path =>
  [path, ...localizedCatalogLocales.map(locale => `/${locale}${path}`)].flatMap(path => [[path, { noScripts: true }], [`${path}/`, { noScripts: true }]]),
))
