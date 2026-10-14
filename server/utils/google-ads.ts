import type { CloudflareEnv } from './auth'
import { storeIntegration } from './organization-integrations'

/**
 * Google Ads as a product of its own, over a Better Auth linked Google
 * account. This module owns the Google Ads customer chosen, and the
 * `account_id` it was chosen through; the account and its tokens are Better Auth's.
 */

export interface GoogleAdsCustomer {
  customerId: string
  formattedCustomerId: string
  descriptiveName: string
  currencyCode?: string
  timeZone?: string
  isManager?: boolean
}

/** Formats a 10-digit customer ID as XXX-XXX-XXXX */
export function formatGoogleAdsCustomerId(customerId: string): string {
  const digits = customerId.replace(/\D/g, '')
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return customerId
}

/** The Google Ads accounts the connected Google account has access to. */
export async function listGoogleAdsAccounts(accessToken: string, developerToken?: string): Promise<GoogleAdsCustomer[]> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
  }
  if (developerToken) {
    headers['developer-token'] = developerToken
  }

  // 1. List accessible customers
  const listResponse = await fetch('https://googleads.googleapis.com/v25/customers:listAccessibleCustomers', {
    headers,
  })

  if (!listResponse.ok) {
    throw new Error(`${listResponse.status} ${listResponse.statusText}: ${(await listResponse.text()).slice(0, 300)}`)
  }

  const listData = (await listResponse.json()) as { resourceNames?: string[] }
  const resourceNames = listData.resourceNames ?? []
  if (resourceNames.length === 0) {
    return []
  }

  // 2. Query descriptive names and details for each customer
  const customers: GoogleAdsCustomer[] = []
  for (const resourceName of resourceNames) {
    const customerId = resourceName.replace(/^customers\//, '')
    const formattedCustomerId = formatGoogleAdsCustomerId(customerId)

    try {
      const searchResponse = await fetch(`https://googleads.googleapis.com/v25/customers/${customerId}/googleAds:search`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.status FROM customer LIMIT 1',
        }),
      })

      if (searchResponse.ok) {
        const searchData = (await searchResponse.json()) as {
          results?: Array<{
            customer?: {
              id?: string
              descriptiveName?: string
              currencyCode?: string
              timeZone?: string
              manager?: boolean
            }
          }>
        }
        const c = searchData.results?.[0]?.customer
        customers.push({
          customerId,
          formattedCustomerId,
          descriptiveName: c?.descriptiveName || `Google Ads (${formattedCustomerId})`,
          currencyCode: c?.currencyCode,
          timeZone: c?.timeZone,
          isManager: c?.manager ?? false,
        })
        continue
      }
    } catch {
      // If querying account details fails (e.g. permission or deactivated sub-account),
      // still include the customer ID so the tenant sees their accessible ID.
    }

    customers.push({
      customerId,
      formattedCustomerId,
      descriptiveName: `Google Ads (${formattedCustomerId})`,
    })
  }

  return customers
}

/** Connects the Google Ads customer to the organization. */
export async function selectGoogleAdsCustomer(
  env: CloudflareEnv,
  organizationId: string,
  accountId: string,
  customerId: string,
  customerName: string,
  expected?: { revision: string | null },
): Promise<string> {
  return await storeIntegration(env.DB, organizationId, 'google_ads', {
    account_id: accountId,
    target_id: customerId,
    target_name: customerName,
  }, expected)
}
