type HeadLink =
  | { key: string; rel: 'icon'; href: string; type?: string }
  | { key: string; rel: 'apple-touch-icon'; href: string }

export interface TenantHeadLinkOptions {
  isPlatform: boolean
  organizationMedia?: Array<{ slot: string; public_url: string | null }> | null
}

/**
 * The platform's own pages carry the KrabiClaw mark. A tenant carries its
 * `favicon` placement, or no icon links at all: serving our mark on a
 * customer's domain presented it as theirs, and made a tenant that was never
 * asked for a favicon look like one that has one.
 */
export function buildTenantHeadLinks(options: TenantHeadLinkOptions): HeadLink[] {
  if (options.isPlatform) {
    // The SVG is the canonical symbol and stays crisp at every tab size; the
    // ICO is only here for browsers that do not take an SVG favicon.
    return [
      { key: 'app-icon-svg', rel: 'icon', type: 'image/svg+xml', href: '/platform/krabiclaw-symbol.svg' },
      { key: 'app-icon', rel: 'icon', href: '/platform/favicon.ico' },
      { key: 'app-icon-apple', rel: 'apple-touch-icon', href: '/platform/apple-touch-icon.png' },
    ]
  }

  const tenantFaviconUrl = options.organizationMedia?.find(item => item.slot === 'favicon')?.public_url
  if (!tenantFaviconUrl) return []

  return [
    { key: 'app-icon', rel: 'icon', href: tenantFaviconUrl },
    { key: 'app-icon-apple', rel: 'apple-touch-icon', href: tenantFaviconUrl },
  ]
}
