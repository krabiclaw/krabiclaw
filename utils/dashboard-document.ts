export function rendersDashboardCalendar(path: string, query: Record<string, unknown>) {
  return /^\/dashboard\/[^/]+\/calendar(?:\/\d{4}-\d{2}-\d{2})?\/?$/.test(path)
    && query.product_id === undefined && query.location_id === undefined && query.view !== 'year'
}
export function websitePageVariant(panel: string) {
  const segment = /^\/website\/pages\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment ? decodeURIComponent(segment) : null
}

export function websiteBlogPost(panel: string) {
  const segment = /^\/website\/blog\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment && segment !== 'categories' ? decodeURIComponent(segment) : null
}

export function websiteSocialPost(panel: string) {
  const segment = /^\/website\/posts\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment ? decodeURIComponent(segment) : null
}

export function websiteQuestion(panel: string) {
  const segment = /^\/website\/qa\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment ? decodeURIComponent(segment) : null
}

export function rendersWebsiteDocument(panel: string, query: Record<string, unknown>) {
  return Boolean(websitePageVariant(panel) || websiteBlogPost(panel) || websiteQuestion(panel)
    || (query.location_id === undefined && websiteSocialPost(panel))) || /^\/website(?:\/(?:pages|reviews|brand|preferences|blog|posts|qa))?\/?$/.test(panel)
}

export function dashboardProductId(panel: string) {
  const segment = /^\/products\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment && !['new', 'menu', 'first-menu', 'first-experience'].includes(segment) ? decodeURIComponent(segment) : null
}
