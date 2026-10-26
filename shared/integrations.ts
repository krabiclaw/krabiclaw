/**
 * What each connection is, in the words the dashboard shows: the one canonical
 * description the Connections index and every leaf read.
 *
 * A **sync** keeps two sides in step on its own (Google Calendar, Airbnb,
 * Google Maps); a **connection** links an account once and is used from here.
 * `entitlement` names the plan capability a connection needs; the index says
 * which plan includes it, and its leaf offers that plan.
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

export type IntegrationGroup = 'sync' | 'connection'

export interface IntegrationDefinition {
  key: IntegrationKey
  name: string
  logo: string
  group: IntegrationGroup
  /** One sentence: what connecting it gets the business. */
  purpose: string
  /** The plan capability it needs; absent when every plan has it. */
  entitlement?: string
}

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    key: 'google-calendar', name: 'Google Calendar sync', logo: 'i-logos-google-calendar', group: 'sync', entitlement: 'calendar_sync',
    purpose: 'Busy on your calendar? Booked out on your website. New bookings show up on your calendar.',
  },
  {
    key: 'airbnb', name: 'Airbnb sync', logo: 'i-simple-icons-airbnb', group: 'sync', entitlement: 'channel_sync',
    purpose: 'Reservations, nightly rates and open dates stay in step with Airbnb, so no night is sold twice.',
  },
  {
    key: 'google-maps', name: 'Google Maps sync', logo: 'i-logos-google-maps', group: 'sync', entitlement: 'google_places',
    purpose: 'Hours, photos, rating and reviews from each location’s Google Maps listing; the rating and reviews refresh weekly.',
  },
  {
    key: 'google-analytics', name: 'Google Analytics', logo: 'i-logos-google-analytics', group: 'connection',
    purpose: 'See who visits your website and which pages turn into bookings.',
  },
  {
    key: 'google-search-console', name: 'Google Search Console', logo: 'i-logos-google-search-console', group: 'connection',
    purpose: 'Show Google this site is yours so every page can be found.',
  },
  {
    key: 'google-ads', name: 'Google Ads', logo: 'i-logos-google-ads', group: 'connection', entitlement: 'marketing',
    purpose: 'Run Search campaigns from your dashboard and ChatGPT, and see what they bring in.',
  },
  {
    key: 'facebook', name: 'Facebook', logo: 'i-logos-facebook', group: 'connection', entitlement: 'managed_service',
    purpose: 'Publish posts from your site to your Facebook Page.',
  },
  {
    key: 'instagram', name: 'Instagram', logo: 'i-skill-icons-instagram', group: 'connection', entitlement: 'managed_service',
    purpose: 'Publish photo posts to your Instagram professional account.',
  },
  {
    key: 'discord', name: 'Discord', logo: 'i-logos-discord-icon', group: 'connection', entitlement: 'managed_service',
    purpose: 'Post announcements to one channel in your server.',
  },
]

export function integrationDefinition(key: IntegrationKey): IntegrationDefinition {
  const definition = INTEGRATIONS.find(integration => integration.key === key)
  if (!definition) throw new Error(`Unknown integration ${key}`)
  return definition
}
