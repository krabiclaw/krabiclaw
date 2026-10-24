/**
 * What each integration is, in the words the dashboard shows: the one canonical
 * description the Integrations index and every leaf read.
 */
export type IntegrationKey =
  | 'google-maps'
  | 'google-analytics'
  | 'google-ads'
  | 'google-search-console'
  | 'google-calendar'
  | 'airbnb'
  | 'facebook'
  | 'instagram'
  | 'discord'

export interface IntegrationDefinition {
  key: IntegrationKey
  name: string
  logo: string
  /** One sentence: what connecting it gets the business. */
  purpose: string
}

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    key: 'google-maps', name: 'Google Maps', logo: 'i-logos-google-maps',
    purpose: 'Each location matched to its Google Maps place: hours, photos, rating and reviews.',
  },
  {
    key: 'google-search-console', name: 'Google Search Console', logo: 'i-logos-google-search-console',
    purpose: 'Proof to Google that this site is yours.',
  },
  {
    key: 'google-analytics', name: 'Google Analytics', logo: 'i-logos-google-analytics',
    purpose: 'Website traffic, and where your bookings come from.',
  },
  {
    key: 'facebook', name: 'Facebook', logo: 'i-logos-facebook',
    purpose: 'Posts from your site, published to your Facebook Page.',
  },
  {
    key: 'instagram', name: 'Instagram', logo: 'i-skill-icons-instagram',
    purpose: 'Photo posts, published to your Instagram professional account.',
  },
  {
    key: 'discord', name: 'Discord', logo: 'i-logos-discord-icon',
    purpose: 'Announcements, posted to one channel in your server.',
  },
  {
    key: 'google-ads', name: 'Google Ads', logo: 'i-logos-google-ads',
    purpose: 'Your ad spend and results in Insights, and campaigns run from your dashboard and ChatGPT.',
  },
  {
    key: 'google-calendar', name: 'Google Calendar', logo: 'i-logos-google-calendar',
    purpose: 'Your bookings on the calendar your team already uses.',
  },
  {
    key: 'airbnb', name: 'Airbnb', logo: 'i-simple-icons-airbnb',
    purpose: 'Sync listings, reservations, rates, and guest messages directly to your dashboard.',
  },
]

export function integrationDefinition(key: IntegrationKey): IntegrationDefinition {
  const definition = INTEGRATIONS.find(integration => integration.key === key)
  if (!definition) throw new Error(`Unknown integration ${key}`)
  return definition
}
