function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface PublicAnnouncement {
  headline: string
  description: string | null
  cta_label: string | null
  cta_url: string | null
  dismissible: boolean
  enabled?: boolean
  format?: 'modal' | 'banner'
  image_url: string | null
}

export const isPublicAnnouncement = (value: unknown): value is PublicAnnouncement =>
  isRecord(value) && typeof value.headline === 'string'
  && (value.description === null || typeof value.description === 'string')
  && (value.cta_label === null || typeof value.cta_label === 'string')
  && (value.cta_url === null || typeof value.cta_url === 'string')
  && typeof value.dismissible === 'boolean'
  && (value.image_url === null || typeof value.image_url === 'string')
  && (value.format === undefined || value.format === null || value.format === 'modal' || value.format === 'banner')

export async function usePublicAnnouncement() {
  const { id: organizationId } = useTenantOrganization().organization
  const requestEvent = useRequestEvent()
  const route = useRoute()
  const isPublicSurface = !route.path.startsWith('/dashboard') && !route.path.startsWith('/api')

  const announcement = useState<PublicAnnouncement | null>(`public-announcement-state:${organizationId}`, () => null)

  if (isPublicSurface && !announcement.value) {
    const { data, error } = await useAsyncData(
      `public-announcement:${organizationId}`,
      () => loadPublicResourcePayload<{ announcement: PublicAnnouncement | null }>({
        organizationId,
        resourceKind: 'config',
        url: '/api/public/config',
        key: `public-announcement:${organizationId}`,
        query: {},
        requestEvent,
        failureMessage: 'Public site configuration failed',
        validate: (value): value is { announcement: PublicAnnouncement | null } =>
          isRecord(value) && ('announcement' in value) && (value.announcement === null || isPublicAnnouncement(value.announcement)),
      }),
      { server: true },
    )
    if (error.value) throw createError(error.value)
    announcement.value = data.value?.announcement ?? null
  }

  const storageKey = computed(() => {
    if (!announcement.value) return null
    if (announcement.value.format === 'banner') {
      return `announcement-dismissed:${organizationId}:banner:${announcement.value.headline}:${announcement.value.description ?? ''}`
    }
    return `announcement-dismissed:${organizationId}:${announcement.value.headline}:${announcement.value.description ?? ''}`
  })

  return {
    organizationId,
    announcement,
    storageKey,
  }
}
