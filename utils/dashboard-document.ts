export function rendersDashboardCalendar(path: string, query: Record<string, unknown>) {
  return /^\/dashboard\/[^/]+\/calendar(?:\/\d{4}-\d{2}-\d{2})?\/?$/.test(path)
    && query.product_id === undefined && query.location_id === undefined && query.view !== 'year'
}
