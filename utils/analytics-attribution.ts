export const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
] as const

export type AttributionKey = typeof ATTRIBUTION_KEYS[number]
export type AttributionParams = Partial<Record<AttributionKey, string>>

export interface AttributionTouch {
  source: string
  medium: string
  campaign: string | null
  term: string | null
  content: string | null
  referrerHost: string | null
  gclid: string | null
  gbraid: string | null
  wbraid: string | null
  fbclid: string | null
  msclkid: string | null
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 31 || code === 127
  })
}

function normalizeValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || hasControlCharacter(trimmed)) return null
  return Array.from(trimmed).slice(0, 255).join('')
}

export function readAttributionParams(searchParams: URLSearchParams): AttributionParams {
  const result: AttributionParams = {}
  for (const key of ATTRIBUTION_KEYS) {
    for (const candidate of searchParams.getAll(key)) {
      const normalized = normalizeValue(candidate)
      if (normalized) {
        result[key] = normalized
        break
      }
    }
  }
  return result
}

export function sanitizeAttributionParams(value: unknown): AttributionParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const result: AttributionParams = {}
  for (const key of ATTRIBUTION_KEYS) {
    const normalized = normalizeValue(record[key])
    if (normalized) result[key] = normalized
  }
  return result
}

export function normalizeReferrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null
  try {
    const url = new URL(referrer)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * What a request actually carried: the sanitized allowlisted parameters and the external referrer
 * host, exactly as observed, with nothing defaulted, classified or inherited. A partial input
 * (a campaign with no source, a referrer only, click IDs only) is kept as it arrived. Null when the
 * request carried none of them. This is the fact an event stores; `AttributionTouch` is the
 * derived last-touch classification computed from it.
 */
export interface ObservedAttribution {
  source: string | null
  medium: string | null
  campaign: string | null
  term: string | null
  content: string | null
  referrerHost: string | null
  gclid: string | null
  gbraid: string | null
  wbraid: string | null
  fbclid: string | null
  msclkid: string | null
}

export function observeAttribution(params: AttributionParams, referrerHost: string | null): ObservedAttribution | null {
  const observed: ObservedAttribution = {
    source: params.utm_source ?? null, medium: params.utm_medium ?? null, campaign: params.utm_campaign ?? null,
    term: params.utm_term ?? null, content: params.utm_content ?? null, referrerHost: referrerHost?.toLowerCase() ?? null,
    gclid: params.gclid ?? null, gbraid: params.gbraid ?? null, wbraid: params.wbraid ?? null,
    fbclid: params.fbclid ?? null, msclkid: params.msclkid ?? null,
  }
  return Object.values(observed).some(value => value !== null) ? observed : null
}

/** The channel a touch's source and medium belong to, as an owner reads them. Raw values stay on the event. */
export const ATTRIBUTION_CHANNELS = ['Google Ads', 'Instagram', 'Facebook', 'Organic search', 'Direct', 'Referral', 'Other', 'Not recorded'] as const
export type AttributionChannel = typeof ATTRIBUTION_CHANNELS[number]
const PAID_MEDIA = new Set(['paid', 'cpc', 'ppc', 'paid_social', 'paidsocial'])
const SEARCH_HOST = /(^|\.)(google|bing|yahoo|duckduckgo|kagi|ecosia|baidu|yandex|startpage)\.[a-z.]+$|^search\.brave\.com$/

export function attributionChannel(source: string | null, medium: string | null): AttributionChannel {
  if (!source || !medium) return 'Not recorded'
  const s = source.toLowerCase()
  const m = medium.toLowerCase()
  if (s === 'instagram' || s === 'ig' || s.endsWith('instagram.com')) return 'Instagram'
  if (s === 'facebook' || s === 'fb' || s.endsWith('facebook.com')) return 'Facebook'
  if (s === 'google' && PAID_MEDIA.has(m)) return 'Google Ads'
  if (s === 'direct' && m === '(none)') return 'Direct'
  if (m === 'organic' || (m === 'referral' && SEARCH_HOST.test(s))) return 'Organic search'
  if (m === 'referral') return 'Referral'
  return 'Other'
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

export function resolveAttributionTouch(
  params: AttributionParams,
  referrerHost: string | null,
  internalHosts: Iterable<string>,
): AttributionTouch | null {
  const clickIds = {
    gclid: params.gclid ?? null,
    gbraid: params.gbraid ?? null,
    wbraid: params.wbraid ?? null,
    fbclid: params.fbclid ?? null,
    msclkid: params.msclkid ?? null,
  }
  let paidSource: string | null = null
  if (params.gclid || params.gbraid || params.wbraid) paidSource = 'Google'
  else if (params.fbclid) paidSource = 'Facebook'
  else if (params.msclkid) paidSource = 'Microsoft'

  // Any campaign parameter makes this a campaign touch, and every one that arrived is kept: a
  // campaign or content without a source is a touch with an unknown source, not a discarded input.
  if (UTM_KEYS.some(key => params[key])) {
    return {
      source: params.utm_source ?? paidSource ?? '(not set)',
      medium: params.utm_medium ?? (!params.utm_source && paidSource ? 'paid' : '(none)'),
      campaign: params.utm_campaign ?? null,
      term: params.utm_term ?? null,
      content: params.utm_content ?? null,
      referrerHost: null,
      ...clickIds,
    }
  }
  if (paidSource) {
    return {
      source: paidSource,
      medium: 'paid',
      campaign: null,
      term: null,
      content: null,
      referrerHost: null,
      ...clickIds,
    }
  }

  const normalizedInternalHosts = new Set(
    Array.from(internalHosts, host => host.trim().toLowerCase()).filter(Boolean),
  )
  if (referrerHost && !normalizedInternalHosts.has(referrerHost.toLowerCase())) {
    return {
      source: referrerHost.toLowerCase(),
      medium: 'referral',
      campaign: null,
      term: null,
      content: null,
      referrerHost: referrerHost.toLowerCase(),
      gclid: null,
      gbraid: null,
      wbraid: null,
      fbclid: null,
      msclkid: null,
    }
  }
  return null
}
