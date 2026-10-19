import type { MaybeRefOrGetter } from 'vue'
import type { PublicProvider } from '~/shared/member-scheduling'
import { isRecord, publicApiRequest } from '~/utils/api-clients'

const isHost = (value: unknown): value is PublicProvider => isRecord(value) && typeof value.name === 'string' && (value.photo_url === null || typeof value.photo_url === 'string') && (value.bio === null || typeof value.bio === 'string')

/**
 * Who hosts an offering, read once per page: the "Hosted by" line and the
 * host card share it. A chosen session whose host's hours are the schedule
 * names that session's member.
 */
export function useProductHosts(input: MaybeRefOrGetter<{ organizationId: string; productId: string; slug: string; sessionId?: string }>) {
  const value = () => toValue(input)
  return useAsyncData(() => `public-hosts:${value().organizationId}:${value().productId}`, async () => {
    const { organizationId, productId, slug, sessionId } = value()
    if (import.meta.server) {
      const event = useRequestEvent()
      if (!event) throw new Error('Request required')
      const [{ cloudflareEnv }, { publicProductHosts }] = await Promise.all([
        import('~/server/utils/api-response'),
        import('~/server/utils/public-provider'),
      ])
      return { hosts: await publicProductHosts(cloudflareEnv(event).DB, organizationId, productId, sessionId) }
    }
    return await publicApiRequest<{ hosts: PublicProvider[] }>(`/api/public/products/${encodeURIComponent(slug)}/provider`, {
      query: sessionId ? { session_id: sessionId } : {},
      validate: (response): response is { hosts: PublicProvider[] } => isRecord(response) && Array.isArray(response.hosts) && response.hosts.every(isHost),
    })
  }, { watch: [() => value().sessionId] })
}
