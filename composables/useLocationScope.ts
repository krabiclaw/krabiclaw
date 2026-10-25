/**
 * The location a dashboard list or record is scoped to by its URL's
 * `?location_id=`, or null for the whole organization. Catalog and Posts read
 * their scope here, so a reload, a deep link and a shared link all mean the
 * same thing; a scope is never carried over from an earlier screen.
 */
export function useLocationScope() {
  const route = useRoute()
  return computed(() => {
    const value = route.query.location_id
    if (value === undefined || value === null) return null
    if (typeof value !== 'string' || !value.trim()) throw createError({ statusCode: 400, statusMessage: 'Choose one location or the whole website' })
    return value
  })
}
