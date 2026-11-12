import { HTTPError } from 'nitro'
import { linkedAccountAccessToken, type CloudflareEnv } from './auth'
import { readIntegration, storeIntegration } from './organization-integrations'
import { requireRecordedManagedSpend } from '~/server/domain/payments/ad-spend'
import { formBody, metaGraphRequest } from './meta-graph'

export const META_ADS_GRAPH_VERSION = 'v25.0'
const GRAPH_BASE = `https://graph.facebook.com/${META_ADS_GRAPH_VERSION}`

export interface MetaAdAccount {
  id: string
  account_id: string
  name: string
  currency: string
  timezone_name: string
  account_status: number
  amount_spent?: string
  is_manager?: boolean
  not_enabled?: boolean
  error?: string
}

export interface MetaAdsCampaign {
  id: string
  name: string
  status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | string
  objective?: string
  dailyBudget?: string
  lifetimeBudget?: string
}

export interface MetaAdsPerformanceSummary {
  costCents: number
  impressions: number
  clicks: number
  reach: number
  conversions: number
  currency: string
}

/** Formats an ad account ID ensuring the 'act_' prefix Meta requires for ad accounts. */
export function formatMetaAdAccountId(rawId: string): string {
  const trimmed = rawId.trim()
  return trimmed.startsWith('act_') ? trimmed : `act_${trimmed}`
}

/** Strips the 'act_' prefix for clean account ID display. */
export function rawMetaAdAccountId(rawId: string): string {
  return rawId.trim().replace(/^act_/, '')
}

/** The Meta Ad Accounts the connected Facebook/Meta account has access to. */
export async function listMetaAdAccounts(accessToken: string): Promise<MetaAdAccount[]> {
  const url = `${GRAPH_BASE}/me/adaccounts?fields=id,name,account_id,currency,timezone_name,account_status,amount_spent&limit=100`
  const response = await metaGraphRequest<{ data?: Array<Record<string, unknown>> }>(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  if (!Array.isArray(response.data)) return []

  return response.data.map((item) => {
    const id = String(item.id ?? '')
    const account_id = String(item.account_id ?? rawMetaAdAccountId(id))
    const name = String(item.name ?? account_id)
    if (typeof item.currency !== 'string' || !item.currency) {
      throw new Error(`Meta Ad Account ${id} is missing required currency`)
    }
    const currency = item.currency
    if (typeof item.timezone_name !== 'string' || !item.timezone_name) {
      throw new Error(`Meta Ad Account ${id} is missing required timezone_name`)
    }
    const timezone_name = item.timezone_name
    if (typeof item.account_status !== 'number') {
      throw new Error(`Meta Ad Account ${id} is missing required account_status`)
    }
    const account_status = item.account_status
    // Meta account_status 1 = ACTIVE; 2 = DISABLED, 3 = UNSETTLED, 100 = PENDING_CLOSURE, 101 = CLOSED
    const not_enabled = account_status !== 1

    return {
      id,
      account_id,
      name,
      currency,
      timezone_name,
      account_status,
      amount_spent: typeof item.amount_spent === 'string' ? item.amount_spent : undefined,
      not_enabled,
      is_manager: false,
    }
  })
}

/** Fetches one Meta Ad Account by id. */
export async function getMetaAdAccount(accessToken: string, adAccountId: string): Promise<MetaAdAccount> {
  const actId = formatMetaAdAccountId(adAccountId)
  const url = `${GRAPH_BASE}/${actId}?fields=id,name,account_id,currency,timezone_name,account_status,amount_spent`
  const item = await metaGraphRequest<Record<string, unknown>>(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  })

  const id = String(item.id ?? actId)
  const account_id = String(item.account_id ?? rawMetaAdAccountId(id))
  if (typeof item.currency !== 'string' || !item.currency) {
    throw new Error(`Meta Ad Account ${id} is missing required currency`)
  }
  if (typeof item.timezone_name !== 'string' || !item.timezone_name) {
    throw new Error(`Meta Ad Account ${id} is missing required timezone_name`)
  }
  if (typeof item.account_status !== 'number') {
    throw new Error(`Meta Ad Account ${id} is missing required account_status`)
  }

  return {
    id,
    account_id,
    name: String(item.name ?? account_id),
    currency: item.currency,
    timezone_name: item.timezone_name,
    account_status: item.account_status,
    amount_spent: typeof item.amount_spent === 'string' ? item.amount_spent : undefined,
  }
}

/** Connects the Meta Ad Account to the organization. */
export async function selectMetaAdAccount(
  env: CloudflareEnv,
  organizationId: string,
  account_id: string,
  adAccountId: string,
  adAccountName: string,
): Promise<string> {
  await requireRecordedManagedSpend(env.DB, env, organizationId)
  if (await readIntegration(env.DB, organizationId, 'meta_ads')) {
    throw new HTTPError({ statusCode: 409, message: 'Disconnect Meta Ads before connecting again.' })
  }

  const { accessToken } = await linkedAccountAccessToken(env, account_id)
  const targetId = formatMetaAdAccountId(adAccountId)
  const account = await getMetaAdAccount(accessToken, targetId)
  if (account.account_status !== 1) {
    throw new HTTPError({ statusCode: 422, message: 'That Meta Ad Account is not active or has been disabled.' })
  }

  return await storeIntegration(env.DB, organizationId, 'meta_ads', {
    account_id: account_id,
    target_id: targetId,
    target_name: adAccountName || account.name,
  }, { revision: null })
}

/** Queries performance metrics for a given date range. */
export async function getMetaAdsPerformanceSummary(
  accessToken: string,
  adAccountId: string,
  startDate: string,
  endDate: string,
): Promise<MetaAdsPerformanceSummary> {
  const actId = formatMetaAdAccountId(adAccountId)
  const timeRange = JSON.stringify({ since: startDate, until: endDate })
  const params = new URLSearchParams({
    time_range: timeRange,
    fields: 'spend,impressions,reach,clicks,actions,account_currency',
  })

  const response = await metaGraphRequest<{ data?: Array<{ spend?: string; impressions?: string; reach?: string; clicks?: string; account_currency?: string; actions?: Array<{ action_type: string; value: string }> }> }>(
    `${GRAPH_BASE}/${actId}/insights?${params.toString()}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )

  const row = response.data?.[0]
  const spendDollar = row?.spend ? parseFloat(row.spend) : 0
  const costCents = Math.round(spendDollar * 100)
  const impressions = row?.impressions ? parseInt(row.impressions, 10) : 0
  const reach = row?.reach ? parseInt(row.reach, 10) : 0
  const clicks = row?.clicks ? parseInt(row.clicks, 10) : 0

  let currency = row?.account_currency
  if (!currency) {
    const account = await getMetaAdAccount(accessToken, adAccountId)
    currency = account.currency
  }

  let conversions = 0
  if (Array.isArray(row?.actions)) {
    const actionTypes = new Set(row.actions.map(a => a.action_type))
    for (const action of row.actions) {
      const type = action.action_type
      const isPurchase = type === 'omni_purchase' || (type === 'purchase' && !actionTypes.has('omni_purchase'))
      const isSchedule = type === 'omni_schedule' || (type === 'schedule' && !actionTypes.has('omni_schedule'))
      const isReg = type === 'omni_complete_registration' || (type === 'complete_registration' && !actionTypes.has('omni_complete_registration'))
      const isLead = type === 'lead' || type === 'contact'
      if (isPurchase || isSchedule || isReg || isLead) {
        conversions += parseInt(action.value || '0', 10)
      }
    }
  }

  return {
    costCents,
    impressions,
    reach,
    clicks,
    conversions,
    currency,
  }
}

/** Reads a campaign to check its owning ad account. */
export async function getMetaCampaignAccountId(accessToken: string, campaignId: string): Promise<string> {
  const response = await metaGraphRequest<{ account_id?: string }>(
    `${GRAPH_BASE}/${campaignId}?fields=account_id`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  if (!response.account_id) throw new HTTPError({ statusCode: 404, message: 'Campaign not found in Meta' })
  return response.account_id
}

/** Lists campaigns under the connected Ad Account. */
export async function listMetaAdsCampaigns(accessToken: string, adAccountId: string): Promise<MetaAdsCampaign[]> {
  const actId = formatMetaAdAccountId(adAccountId)
  const params = new URLSearchParams({
    fields: 'id,name,status,objective,daily_budget,lifetime_budget',
    limit: '100',
  })

  const response = await metaGraphRequest<{ data?: Array<{ id: string; name: string; status: string; objective?: string; daily_budget?: string; lifetime_budget?: string }> }>(
    `${GRAPH_BASE}/${actId}/campaigns?${params.toString()}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )

  if (!Array.isArray(response.data)) return []
  return response.data.map(item => ({
    id: item.id,
    name: item.name,
    status: item.status,
    objective: item.objective,
    dailyBudget: item.daily_budget,
    lifetimeBudget: item.lifetime_budget,
  }))
}

/** Creates a new campaign in PAUSED status with special ad category NONE. */
export async function createMetaAdsCampaign(
  accessToken: string,
  adAccountId: string,
  input: { name: string; dailyBudgetCents?: number; objective?: string },
): Promise<{ id: string }> {
  const actId = formatMetaAdAccountId(adAccountId)
  const fields: Record<string, string | number | undefined> = {
    name: input.name,
    objective: input.objective ?? 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: JSON.stringify([]),
  }
  if (input.dailyBudgetCents && input.dailyBudgetCents > 0) {
    fields.daily_budget = input.dailyBudgetCents
  }

  const response = await metaGraphRequest<{ id?: string }>(
    `${GRAPH_BASE}/${actId}/campaigns`,
    {
      ...formBody(fields),
      headers: { authorization: `Bearer ${accessToken}` },
    },
  )

  if (!response.id) throw new Error('Meta did not return a campaign ID')
  return { id: response.id }
}

/** Updates campaign status or daily budget. */
export async function updateMetaAdsCampaign(
  accessToken: string,
  campaignId: string,
  input: { status?: 'ACTIVE' | 'PAUSED'; dailyBudgetCents?: number },
): Promise<{ success: boolean }> {
  const fields: Record<string, string | number | undefined> = {}
  if (input.status) fields.status = input.status
  if (input.dailyBudgetCents !== undefined && input.dailyBudgetCents > 0) {
    fields.daily_budget = input.dailyBudgetCents
  }

  const response = await metaGraphRequest<{ success?: boolean }>(
    `${GRAPH_BASE}/${campaignId}`,
    {
      ...formBody(fields),
      headers: { authorization: `Bearer ${accessToken}` },
    },
  )

  return { success: response.success === true }
}
