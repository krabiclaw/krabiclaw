export type EntitlementValue = string | number | boolean
export type EntitlementsMap = Record<string, EntitlementValue>

/**
 * The single application-owned plan policy used by Better Auth Stripe hooks,
 * entitlement projection, and feature checks. Stripe identifies the plan; it
 * does not define application capability policy.
 */
export function getPlanEntitlements(plan: string): EntitlementsMap {
  if (plan !== 'free' && plan !== 'growth' && plan !== 'commerce' && plan !== 'marketing' && plan !== 'business') {
    throw new Error(`Unsupported runtime billing plan "${plan}"`)
  }
  const base: EntitlementsMap = {
    plan,
    payments: false,
    custom_pages: false,
    custom_domains: false,
    google_places: false,
    managed_service: false,
    messaging: false,
    review_requests: false,
    additional_languages: false,
    google_ads_management: false,
    calendar_sync: false,
    channel_sync: false,
  }

  switch (plan) {
    case 'growth':
    case 'commerce':
    case 'marketing':
    case 'business':
      return {
        ...base,
        payments: plan !== 'growth',
        // Creating and changing campaigns; reading them is free with the connection.
        google_ads_management: plan === 'marketing' || plan === 'business',
        // Two-way Google Calendar sync and the Airbnb channel: Business keeps
        // both sides in step for a team; Growth takes bookings on the site.
        calendar_sync: plan === 'business',
        channel_sync: plan === 'business',
        custom_pages: true,
        google_places: true,
        custom_domains: true,
        managed_service: true,
        messaging: true,
        review_requests: true,
        additional_languages: true,
      }
    default:
      return base
  }
}
