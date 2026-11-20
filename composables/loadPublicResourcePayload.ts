import type { H3Event } from 'h3'

interface PublicResourceLoadOptions<T> {
  organizationId: string | null
  resourceKind: 'shell' | 'page' | 'config' | 'document' | 'inquiry'
  url: string
  key: string
  query: Record<string, string | undefined>
  validate: Validator<T>
  failureMessage: string
  signal?: AbortSignal
  requestEvent?: H3Event
}

export async function loadPublicResourcePayload<T>(
  options: PublicResourceLoadOptions<T>,
): Promise<T> {
  const providerOptions = {
    organizationId: options.organizationId,
    resourceKind: options.resourceKind,
    url: options.url,
    query: options.query,
    signal: options.signal,
  }
  const value = import.meta.server
    ? await ((options.requestEvent ?? useRequestEvent())?.context.publicResourceProvider as
        | import('~/utils/public-resource-provider').PublicResourceProvider
        | undefined)?.(providerOptions)
    : await publicApiRequest<T>(options.url, {
        coalesceKey: options.key,
        signal: options.signal,
        validate: options.validate,
      })
  if (value === undefined) {
    throw createError({ statusCode: 500, statusMessage: `${options.failureMessage} provider unavailable` })
  }
  // The client branch above already validates inside publicApiRequest and
  // throws on a contract mismatch — only the SSR provider branch (which
  // doesn't validate itself) still needs a check here. The explicit cast
  // reflects that both branches are guaranteed valid T by this point, just
  // via different validators — TS can't see across that boundary.
  if (import.meta.server && !options.validate(value)) {
    throw new ApiClientError(
      `${options.failureMessage}: response did not match its contract`,
      502,
      'INVALID_API_RESPONSE',
      null,
    )
  }
  return value as T
}
