export function rendersDashboardCalendar(path: string, query: Record<string, unknown>) {
  return /^\/dashboard\/[^/]+\/calendar(?:\/\d{4}-\d{2}-\d{2})?\/?$/.test(path)
    && query.product_id === undefined && query.location_id === undefined && query.view !== 'year'
}
export function rendersWebsiteDocument(panel: string, query: Record<string, unknown>) {
  return /^\/website(?:\/(?:pages|reviews|brand|preferences|blog|posts|qa))?\/?$/.test(panel)
    && (!/^\/website\/(?:posts|qa)\/?$/.test(panel) || query.location_id === undefined)
}
