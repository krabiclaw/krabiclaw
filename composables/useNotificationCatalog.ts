export interface CatalogPreview {
  id: string
  title: string
  audience: 'owner' | 'guest'
  subject: string
  html: string
  text: string
  channels: string[]
  whatsapp: { template: string; text: string } | null
}

/**
 * The rendered catalog, fetched once and shared by the index and the leaf, so a
 * row's preview and the message it opens cannot disagree.
 */
export async function useNotificationCatalog() {
  const { data, error: fetchError } = await useAsyncData('notification-catalog', () =>
    applicationFetch('/api/dev/notifications-preview', { validate: (value): value is { entries: CatalogPreview[] } =>
      isRecord(value) && Array.isArray(value.entries) && value.entries.every(entry => isRecord(entry)
        && typeof entry.id === 'string' && typeof entry.title === 'string' && (entry.audience === 'owner' || entry.audience === 'guest')
        && typeof entry.subject === 'string' && typeof entry.html === 'string' && typeof entry.text === 'string'
        && Array.isArray(entry.channels) && entry.channels.every(channel => typeof channel === 'string')
        && (entry.whatsapp === null || (isRecord(entry.whatsapp) && typeof entry.whatsapp.template === 'string' && typeof entry.whatsapp.text === 'string')))
    }), { default: () => ({ entries: [] }), server: false })

  const entries = computed(() => data.value?.entries ?? [])
  const error = computed(() => (fetchError.value ? fetchError.value.message || 'Failed to load the message catalog' : null))
  return { entries, error }
}
