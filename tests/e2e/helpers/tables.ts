import { seededTenant } from '../seed/manifest'

/** A seeded dining room's tables, as the restaurant seed made them: one table product per location. */
export function seededTables(location: 'brooklyn') {
  const tables = seededTenant('restaurant').products[`tables-${location}`]
  if (!tables) throw new Error(`The seeded restaurant has no tables at ${location}`)
  return tables
}
