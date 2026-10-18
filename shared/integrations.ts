/**
 * What each integration is, in the words the dashboard shows: the one canonical
 * description the Integrations index and every leaf read. Each entry says what
 * the connection actually does here and offers prompts the KrabiClaw app can
 * run — only work a tool performs, never a capability the product lacks.
 */
export type IntegrationKey =
  | 'google-maps'
  | 'google-analytics'
  | 'google-ads'
  | 'google-search-console'
  | 'google-calendar'
  | 'facebook'
  | 'instagram'
  | 'discord'

export type IntegrationGroup = 'found' | 'reach' | 'day'

export const INTEGRATION_GROUP_LABELS: Record<IntegrationGroup, string> = {
  found: 'Be found',
  reach: 'Reach people',
  day: 'Run the day',
}

export interface IntegrationDefinition {
  key: IntegrationKey
  name: string
  logo: string
  group: IntegrationGroup
  /** One sentence: what connecting it gets the business. */
  purpose: string
  /** What the connection does here, as concrete reads and writes. */
  does: readonly string[]
  /** Prompts the KrabiClaw app answers with this connection; brackets mark what the reader fills in. */
  prompts: readonly string[]
  /** The linked account the connection acts through. */
  linkedAccount: 'Google' | 'Facebook' | 'Instagram' | 'Discord'
  /** The plan entitlement the connection needs, when it is not on every plan. */
  entitlement?: 'marketing'
}

export const INTEGRATIONS: readonly IntegrationDefinition[] = [
  {
    key: 'google-maps', name: 'Google Maps', logo: 'i-logos-google-maps', group: 'found', linkedAccount: 'Google',
    purpose: 'Each location matched to its Google Maps place: hours, photos, rating and reviews.',
    does: [
      'Imports a location’s hours, address, photos and rating from its Google Maps place',
      'Refreshes its Google reviews every week and shows them on your site',
    ],
    prompts: [
      'Import the hours and photos from our Google Maps listing',
      'What are our newest Google reviews saying?',
      'Which of our locations isn’t connected to Google Maps yet?',
    ],
  },
  {
    key: 'google-search-console', name: 'Google Search Console', logo: 'i-logos-google-search-console', group: 'found', linkedAccount: 'Google',
    purpose: 'Proof to Google that this site is yours.',
    does: [
      'Verifies your site with Google Search Console through the Google account you choose',
      'Keeps the verification on your pages so Google continues to treat the site as yours',
    ],
    prompts: [],
  },
  {
    key: 'google-analytics', name: 'Google Analytics', logo: 'i-logos-google-analytics', group: 'found', linkedAccount: 'Google',
    purpose: 'Website traffic, and where your bookings come from.',
    does: [
      'Reads sessions, page views and attribution from the GA4 property you choose',
      'Shows them in Insights and answers questions about them',
    ],
    prompts: [
      'How many people visited the site last week, and from where?',
      'Which pages led to bookings this month?',
      'Compare this month’s traffic with last month’s',
    ],
  },
  {
    key: 'facebook', name: 'Facebook', logo: 'i-logos-facebook', group: 'reach', linkedAccount: 'Facebook',
    purpose: 'Posts from your site, published to your Facebook Page.',
    does: [
      'Publishes the posts you choose to the Page',
      'Includes the Page in a launch across every connected channel',
    ],
    prompts: [
      'Post this week’s special to Facebook',
      'Share the new blog post on Facebook and Instagram',
    ],
  },
  {
    key: 'instagram', name: 'Instagram', logo: 'i-skill-icons-instagram', group: 'reach', linkedAccount: 'Instagram',
    purpose: 'Photo posts, published to your Instagram professional account.',
    does: [
      'Publishes the photo posts you choose to the account',
      'Includes the account in a launch across every connected channel',
    ],
    prompts: [
      'Post the new dish photo to Instagram with a short caption',
      'Share the event on Instagram and Facebook',
    ],
  },
  {
    key: 'discord', name: 'Discord', logo: 'i-logos-discord-icon', group: 'reach', linkedAccount: 'Discord',
    purpose: 'Announcements, posted to one channel in your server.',
    does: [
      'Posts the announcements you choose to the channel',
      'Includes the channel in a launch across every connected channel',
    ],
    prompts: [
      'Announce the new menu in Discord',
      'Post tonight’s availability to Discord',
    ],
  },
  {
    key: 'google-ads', name: 'Google Ads', logo: 'i-logos-google-ads', group: 'reach', linkedAccount: 'Google', entitlement: 'marketing',
    purpose: 'Search campaigns, run from your dashboard and ChatGPT.',
    does: [
      'Lists your campaigns with spend, clicks and conversions',
      'Creates, clones, pauses and budgets Search campaigns when you ask',
      'Reads each finished day’s spend for the 10% ad-spend fee',
    ],
    prompts: [
      'Create a Search campaign for [page] with a daily budget of [amount]',
      'Pause any campaign that spent money this week without a conversion',
      'Clone our best campaign for the new blog post',
    ],
  },
  {
    key: 'google-calendar', name: 'Google Calendar', logo: 'i-logos-google-calendar', group: 'day', linkedAccount: 'Google',
    purpose: 'Your bookings on the calendar your team already uses.',
    does: [
      'Adds each confirmed booking to the calendar you choose and updates it when the booking changes',
      'Removes it when the booking is cancelled',
    ],
    prompts: [
      'What’s booked tomorrow?',
      'Block next Friday afternoon',
    ],
  },
]

export function integrationDefinition(key: IntegrationKey): IntegrationDefinition {
  const definition = INTEGRATIONS.find(integration => integration.key === key)
  if (!definition) throw new Error(`Unknown integration ${key}`)
  return definition
}
