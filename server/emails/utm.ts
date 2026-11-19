export interface EmailUtmParams {
  source?: string
  medium?: string
  campaign?: string
  content?: string
}

/**
 * Appends standard UTM parameters to an HTTP(S) URL, preserving existing query parameters.
 * If utm_source or utm_medium already exist, they are preserved.
 */
export function appendEmailUtms(rawUrl: string | null | undefined, params: EmailUtmParams): string {
  if (!rawUrl || typeof rawUrl !== 'string') return ''
  const trimmed = rawUrl.trim()
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return rawUrl

  try {
    const url = new URL(trimmed)
    if (url.pathname.startsWith('/dashboard/')) return rawUrl

    if (!url.searchParams.has('utm_source')) {
      url.searchParams.set('utm_source', params.source ?? 'blawby')
    }
    if (!url.searchParams.has('utm_medium')) {
      url.searchParams.set('utm_medium', params.medium ?? 'email')
    }
    if (params.campaign && !url.searchParams.has('utm_campaign')) {
      url.searchParams.set('utm_campaign', params.campaign)
    }
    if (params.content && !url.searchParams.has('utm_content')) {
      url.searchParams.set('utm_content', params.content)
    }
    return url.toString()
  } catch {
    return rawUrl
  }
}

/**
 * Replaces HTTP(S) links in markdown text with UTM-tagged equivalents.
 */
export function tagMarkdownLinks(markdown: string | undefined, params: EmailUtmParams): string {
  if (!markdown || typeof markdown !== 'string') return markdown ?? ''
  return markdown.replace(/\[([^\]]+)\]\((https?:\/\/[^\s()]+(?:\([^\s()]+\)[^\s()]*)*)\)/g, (_match, label, url) => {
    return `[${label}](${appendEmailUtms(url, { ...params, content: params.content ?? 'body_link' })})`
  })
}
