export type EntitlementValue = string | number | boolean
export type EntitlementsMap = Record<string, EntitlementValue>

/**
 * The single application-owned plan policy used by Better Auth Stripe hooks,
 * entitlement projection, and feature checks. Stripe identifies the plan; it
 * does not define application capability policy.
 */
export function getPlanEntitlements(plan: string): EntitlementsMap {
  if (plan !== 'free' && plan !== 'growth' && plan !== 'commerce' && plan !== 'marketing') {
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
    marketing: false,
  }

  switch (plan) {
    case 'growth':
    case 'commerce':
    case 'marketing':
      return {
        ...base,
        payments: plan !== 'growth',
        marketing: plan === 'marketing',
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
