export interface PublicResourceProviderOptions {
  organizationId: string | null
  resourceKind: 'shell' | 'page' | 'config' | 'document' | 'inquiry'
  url: string
  query: Record<string, string | undefined>
  signal?: AbortSignal
}

export type PublicResourceProvider = (
  _options: PublicResourceProviderOptions,
) => Promise<unknown>
