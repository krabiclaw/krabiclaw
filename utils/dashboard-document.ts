import { STAY_ARRIVAL_SECTIONS } from '~/shared/stay-arrival'

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

export function rendersWebsiteDocument(panel: string, _query: Record<string, unknown>) {
  return Boolean(websitePageVariant(panel) || websiteBlogPost(panel) || websiteQuestion(panel)
    || websiteSocialPost(panel)
    || /^\/website\/(?:blog\/categories|reviews\/[^/]+)(?:\/|$)/.test(panel)
    || /^\/website\/brand(?:\/|$)/.test(panel)
    || /^\/website\/preferences\/(?:status|currency|booking|reviews|domains|localization)(?:\/|$)/.test(panel)) || /^\/website(?:\/(?:pages|reviews|brand|preferences|blog|posts|qa))?\/?$/.test(panel)
}

export function dashboardProductId(panel: string) {
  const segment = /^\/products\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment && !['new', 'menu', 'first-menu', 'first-experience'].includes(segment) ? decodeURIComponent(segment) : null
}

export function rendersProductCreation(panel: string, query: Record<string, unknown>) {
  return /^\/products\/new(?:\/|$)/.test(panel) && !(query.kind === 'stay' && query.setup === 'guided')
}

export function rendersCatalogEditor(panel: string) {
  return /^\/products\/(?:menu(?:\/|$)|[^/]+\/collections(?:\/|$))/.test(panel)
}

export function dashboardLocationSlug(panel: string) {
  const segment = /^\/locations\/([^/]+)(?:\/|$)/.exec(panel)?.[1]
  return segment && segment !== 'new' ? decodeURIComponent(segment) : null
}

export function rendersProductArrival(panel: string, query: Record<string, unknown>) {
  return Boolean(dashboardProductId(panel)) && (query.guide === 'arrival' || (STAY_ARRIVAL_SECTIONS as readonly string[]).includes(panel.split('/')[3] ?? ''))
}

/** Independent record editors own their reads; the hidden Website index does not. */
export function needsWebsiteSettings(panel: string) {
  return !/^\/website\/(?:(?:posts|reviews)\/[^/]+|blog\/categories)(?:\/|$)/.test(panel)
}
