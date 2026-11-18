import { HTTPError } from 'nitro'
import { addLocalDays, isValidCalendarDate, isValidTimezone, localDateAt } from '~/utils/timezone'
import { searchGoogleAdsRows, type GoogleAdsConnection } from './google-ads'

type AdsObject = Record<string, unknown>
type AdsRow = Record<string, AdsObject | undefined>
type ReportRange = { start_date: string; end_date: string }

function reportDates(range: ReportRange) {
  if (!isValidCalendarDate(range.start_date) || !isValidCalendarDate(range.end_date) || range.start_date > range.end_date) {
    throw new HTTPError({ statusCode: 400, message: 'Supply valid calendar days with start_date on or before end_date.' })
  }
  return `segments.date BETWEEN '${range.start_date}' AND '${range.end_date}'`
}

function campaignFilter(campaignId: string) {
  if (!/^\d+$/u.test(campaignId)) throw new HTTPError({ statusCode: 400, message: 'Supply a numeric Google Ads campaign_id.' })
  return `campaign.id = ${campaignId}`
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function booleanField(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function numberField(value: unknown): number | null {
  return (typeof value === 'number' || (typeof value === 'string' && value !== '')) && Number.isFinite(Number(value)) ? Number(value) : null
}

function objectField(value: unknown): AdsObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AdsObject : null
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function requireAdsRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new HTTPError({ statusCode: 404, message })
  return row
}

export async function queryGoogleAdsChangeHistory(connection: GoogleAdsConnection, range: ReportRange, limit: number, now = new Date()) {
  reportDates(range)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HTTPError({ statusCode: 400, message: 'limit must be 1 to 500.' })
  const [row] = await searchGoogleAdsRows<AdsRow>(connection, 'SELECT customer.time_zone FROM customer LIMIT 1', 'Google Ads account timezone failed')
  const timezone = stringField(row?.customer?.timeZone)
  if (!isValidTimezone(timezone)) throw new Error('Google Ads did not return a valid account timezone')
  const today = localDateAt(now, timezone)
  const earliest = addLocalDays(today, -29)
  if (range.start_date < earliest || range.end_date > today) {
    throw new HTTPError({ statusCode: 400, message: `Google Ads API change events are available from ${earliest} through ${today} in ${timezone}. Use Change history in the Google Ads console for earlier events.` })
  }

  const rows = await searchGoogleAdsRows<AdsRow>(connection, `
    SELECT change_event.resource_name, change_event.change_date_time, change_event.user_email, change_event.client_type,
      change_event.change_resource_type, change_event.change_resource_name, change_event.resource_change_operation,
      change_event.campaign, change_event.ad_group, change_event.changed_fields, change_event.old_resource, change_event.new_resource
    FROM change_event
    WHERE change_event.change_date_time >= '${range.start_date} 00:00:00'
      AND change_event.change_date_time < '${addLocalDays(range.end_date, 1)} 00:00:00'
    ORDER BY change_event.change_date_time DESC LIMIT ${limit + 1}
  `, 'Google Ads change history failed')

  const changes = rows.slice(0, limit).map(({ changeEvent }) => {
    if (!changeEvent?.resourceName || !changeEvent.changeDateTime) throw new Error('Google Ads returned a change without its ID or timestamp')
    return {
      resource_name: String(changeEvent.resourceName),
      changed_at: String(changeEvent.changeDateTime),
      actor_email: stringField(changeEvent.userEmail), client_type: stringField(changeEvent.clientType),
      resource_type: stringField(changeEvent.changeResourceType), changed_resource: stringField(changeEvent.changeResourceName),
      operation: stringField(changeEvent.resourceChangeOperation),
      campaign: stringField(changeEvent.campaign), ad_group: stringField(changeEvent.adGroup),
      changed_fields: typeof changeEvent.changedFields === 'string'
        ? changeEvent.changedFields.split(',').filter(Boolean) : strings(objectField(changeEvent.changedFields)?.paths),
      old_resource: objectField(changeEvent.oldResource), new_resource: objectField(changeEvent.newResource),
    }
  })
  return { customer_id: connection.customerId, time_zone: timezone, ...range, changes, has_more: rows.length > limit }
}

const biddingFields = [
  'maximize_conversions.target_cpa_micros', 'maximize_conversion_value.target_roas',
  'target_cpa.target_cpa_micros', 'target_roas.target_roas', 'target_spend.cpc_bid_ceiling_micros',
  'target_impression_share.cpc_bid_ceiling_micros', 'target_impression_share.location_fraction_micros',
  'target_impression_share.location',
]

export async function getCampaignBiddingSettings(connection: GoogleAdsConnection, campaignId: string) {
  const filter = campaignFilter(campaignId)
  const [row] = await searchGoogleAdsRows<AdsRow>(connection, `
    SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign.bidding_strategy_system_status,
      campaign.bidding_strategy, campaign.accessible_bidding_strategy, customer.currency_code,
      ${biddingFields.map(field => `campaign.${field}`).join(', ')}
    FROM campaign WHERE ${filter} LIMIT 1
  `, 'Google Ads campaign bidding settings failed')
  const campaign = requireAdsRow(row?.campaign, 'Google Ads campaign not found')
  const resourceName = stringField(campaign.accessibleBiddingStrategy)
  let strategy = campaign
  if (resourceName) {
    if (!/^customers\/\d+\/accessibleBiddingStrategies\/\d+$/u.test(resourceName)) throw new Error('Google Ads returned an invalid accessible bidding strategy resource name')
    const [portfolio] = await searchGoogleAdsRows<AdsRow>(connection, `
      SELECT accessible_bidding_strategy.resource_name, accessible_bidding_strategy.name,
        accessible_bidding_strategy.owner_customer_id, ${biddingFields.map(field => `accessible_bidding_strategy.${field}`).join(', ')}
      FROM accessible_bidding_strategy WHERE accessible_bidding_strategy.resource_name = '${resourceName}' LIMIT 1
    `, 'Google Ads portfolio bidding settings failed')
    strategy = requireAdsRow(portfolio?.accessibleBiddingStrategy, 'The campaign portfolio bidding strategy is unavailable to this Google Ads account')
  } else if (campaign.biddingStrategy) {
    throw new Error('Google Ads did not return an accessible portfolio bidding strategy')
  }
  return {
    customer_id: connection.customerId, campaign_id: campaignId, campaign_name: stringField(campaign.name),
    currency: stringField(row?.customer?.currencyCode), strategy_type: stringField(campaign.biddingStrategyType),
    system_status: stringField(campaign.biddingStrategySystemStatus),
    portfolio_strategy: stringField(campaign.biddingStrategy), portfolio_name: resourceName ? stringField(strategy.name) : null,
    portfolio_owner_customer_id: resourceName ? stringField(strategy.ownerCustomerId) : null,
    target_cpa_micros: numberField(objectField(strategy.maximizeConversions)?.targetCpaMicros ?? objectField(strategy.targetCpa)?.targetCpaMicros),
    target_roas: numberField(objectField(strategy.maximizeConversionValue)?.targetRoas ?? objectField(strategy.targetRoas)?.targetRoas),
    cpc_bid_ceiling_micros: numberField(objectField(strategy.targetSpend)?.cpcBidCeilingMicros ?? objectField(strategy.targetImpressionShare)?.cpcBidCeilingMicros),
    impression_share_target_micros: numberField(objectField(strategy.targetImpressionShare)?.locationFractionMicros),
    impression_share_location: stringField(objectField(strategy.targetImpressionShare)?.location),
  }
}

const audienceCriterionFields = [
  'criterion_id', 'type', 'status', 'negative', 'user_list.user_list', 'user_interest.user_interest_category',
  'custom_audience.custom_audience', 'combined_audience.combined_audience',
]
const audienceCriterionTypes = "'USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE', 'AGE_RANGE', 'GENDER'"

function targetingCriterion(criterion: AdsObject | undefined) {
  return {
    criterion_id: stringField(criterion?.criterionId), type: stringField(criterion?.type),
    status: stringField(criterion?.status), negative: criterion?.negative === true,
    resource: stringField(objectField(criterion?.location)?.geoTargetConstant
      ?? objectField(criterion?.language)?.languageConstant ?? objectField(criterion?.userList)?.userList
      ?? objectField(criterion?.userInterest)?.userInterestCategory ?? objectField(criterion?.audience)?.audience
      ?? objectField(criterion?.customAudience)?.customAudience ?? objectField(criterion?.combinedAudience)?.combinedAudience),
  }
}

export async function getCampaignDeliveryDiagnostics(connection: GoogleAdsConnection, campaignId: string, range: ReportRange) {
  const filter = campaignFilter(campaignId)
  const dates = reportDates(range)
  const [settings, performance, criteria, adGroupCriteria, ads] = await Promise.all([
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.primary_status_reasons,
        campaign.keyword_match_type, campaign.ai_max_setting.enable_ai_max, campaign.broad_match_migration_date_time, campaign.targeting_setting.target_restrictions,
        campaign.geo_target_type_setting.positive_geo_target_type, campaign.geo_target_type_setting.negative_geo_target_type,
        campaign_budget.id, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count,
        customer.status, customer.currency_code, customer.time_zone
      FROM campaign WHERE ${filter} LIMIT 1
    `, 'Google Ads campaign delivery settings failed'),
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
        metrics.search_impression_share, metrics.search_rank_lost_impression_share, metrics.search_budget_lost_impression_share
      FROM campaign WHERE ${filter} AND ${dates} LIMIT 1
    `, 'Google Ads campaign delivery metrics failed'),
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT ${audienceCriterionFields.map(field => `campaign_criterion.${field}`).join(', ')},
        campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant,
        campaign_criterion.proximity.radius, campaign_criterion.proximity.radius_units
      FROM campaign_criterion WHERE ${filter} AND campaign_criterion.status != 'REMOVED'
        AND campaign_criterion.type IN ('LOCATION', 'PROXIMITY', 'LANGUAGE', ${audienceCriterionTypes})
      ORDER BY campaign_criterion.criterion_id LIMIT 501
    `, 'Google Ads campaign targeting failed'),
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT ad_group.id, ad_group_criterion.audience.audience, ${audienceCriterionFields.map(field => `ad_group_criterion.${field}`).join(', ')}
      FROM ad_group_criterion WHERE ${filter} AND ad_group_criterion.status != 'REMOVED'
        AND ad_group_criterion.type IN ('AUDIENCE', ${audienceCriterionTypes})
      ORDER BY ad_group.id, ad_group_criterion.criterion_id LIMIT 501
    `, 'Google Ads ad group targeting failed'),
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status,
        ad_group_ad.policy_summary.review_status, ad_group_ad.policy_summary.policy_topic_entries,
        ad_group.targeting_setting.target_restrictions
      FROM ad_group_ad WHERE ${filter} AND ad_group_ad.status != 'REMOVED' ORDER BY ad_group.id, ad_group_ad.ad.id LIMIT 501
    `, 'Google Ads ad eligibility failed'),
  ])
  const campaign = requireAdsRow(settings[0]?.campaign, 'Google Ads campaign not found')
  const budget = settings[0]?.campaignBudget
  const customer = settings[0]?.customer
  const metrics = performance[0]?.metrics

  return {
    customer_id: connection.customerId, campaign_id: campaignId, campaign_name: stringField(campaign.name), ...range,
    currency: stringField(customer?.currencyCode), time_zone: stringField(customer?.timeZone), account_status: stringField(customer?.status),
    status: stringField(campaign.status), primary_status: stringField(campaign.primaryStatus),
    primary_status_reasons: strings(campaign.primaryStatusReasons),
    keyword_match_type: stringField(campaign.keywordMatchType),
    ai_max_enabled: booleanField(objectField(campaign.aiMaxSetting)?.enableAiMax),
    broad_match_migration_date_time: stringField(campaign.broadMatchMigrationDateTime),
    budget_id: stringField(budget?.id), daily_budget_micros: numberField(budget?.amountMicros),
    shared_budget: booleanField(budget?.explicitlyShared), budget_reference_count: numberField(budget?.referenceCount),
    positive_geo_target_type: stringField(objectField(campaign.geoTargetTypeSetting)?.positiveGeoTargetType),
    negative_geo_target_type: stringField(objectField(campaign.geoTargetTypeSetting)?.negativeGeoTargetType),
    targeting_restrictions: targetRestrictions(campaign),
    metrics: metrics ? {
      impressions: Number(metrics.impressions ?? 0), clicks: Number(metrics.clicks ?? 0), cost_micros: Number(metrics.costMicros ?? 0),
      conversions: Number(metrics.conversions ?? 0), search_impression_share: numberField(metrics.searchImpressionShare),
      search_rank_lost_impression_share: numberField(metrics.searchRankLostImpressionShare),
      search_budget_lost_impression_share: numberField(metrics.searchBudgetLostImpressionShare),
    } : null,
    campaign_criteria: criteria.slice(0, 500).map(({ campaignCriterion }) => ({
      ...targetingCriterion(campaignCriterion),
      radius: numberField(objectField(campaignCriterion?.proximity)?.radius),
      radius_units: stringField(objectField(campaignCriterion?.proximity)?.radiusUnits),
    })),
    ad_group_criteria: adGroupCriteria.slice(0, 500).map(({ adGroupCriterion, adGroup }) => ({
      ...targetingCriterion(adGroupCriterion), ad_group_id: stringField(adGroup?.id),
    })),
    more_criteria: criteria.length > 500 || adGroupCriteria.length > 500,
    ads: ads.slice(0, 500).map(({ adGroupAd, adGroup }) => {
      const policy = objectField(adGroupAd?.policySummary)
      return {
        ad_group_id: stringField(adGroup?.id), ad_id: stringField(objectField(adGroupAd?.ad)?.id),
        status: stringField(adGroupAd?.status), approval_status: stringField(policy?.approvalStatus),
        review_status: stringField(policy?.reviewStatus), policy_topics: objectArray(policy?.policyTopicEntries).flatMap(topic => typeof topic.topic === 'string' ? [topic.topic] : []),
        targeting_restrictions: targetRestrictions(adGroup),
      }
    }),
    more_ads: ads.length > 500,
  }
}

function objectArray(value: unknown): AdsObject[] {
  return Array.isArray(value) ? value.flatMap(item => { const object = objectField(item); return object ? [object] : [] }) : []
}

function targetRestrictions(resource: AdsObject | undefined) {
  return objectArray(objectField(resource?.targetingSetting)?.targetRestrictions).map(rule => ({
    dimension: stringField(rule.targetingDimension), observation_only: rule.bidOnly === true,
  }))
}

export async function listConversionActions(connection: GoogleAdsConnection) {
  const rows = await searchGoogleAdsRows<AdsRow>(connection, `
    SELECT conversion_action.id, conversion_action.resource_name, conversion_action.name, conversion_action.status,
      conversion_action.type, conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal,
      conversion_action.include_in_conversions_metric, conversion_action.google_analytics_4_settings.event_name,
      conversion_action.google_analytics_4_settings.property_id
    FROM conversion_action ORDER BY conversion_action.id LIMIT 501
  `, 'Google Ads conversion actions failed')
  return {
    customer_id: connection.customerId, has_more: rows.length > 500,
    actions: rows.slice(0, 500).map(({ conversionAction }) => {
      if (!conversionAction?.id || !conversionAction.resourceName) throw new Error('Google Ads returned a conversion action without an ID')
      const ga4 = objectField(conversionAction.googleAnalytics4Settings)
      return {
        id: String(conversionAction.id), resource_name: String(conversionAction.resourceName), name: stringField(conversionAction.name),
        status: stringField(conversionAction.status), type: stringField(conversionAction.type), category: stringField(conversionAction.category),
        origin: stringField(conversionAction.origin), primary_for_goal: booleanField(conversionAction.primaryForGoal),
        include_in_conversions_metric: booleanField(conversionAction.includeInConversionsMetric),
        ga4_event_name: stringField(ga4?.eventName), ga4_property_id: stringField(ga4?.propertyId),
      }
    }),
  }
}

export async function getConversionTrackingHealth(connection: GoogleAdsConnection, range: ReportRange) {
  const dates = reportDates(range)
  const [[account], goals, activity] = await Promise.all([
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT customer.id, customer.auto_tagging_enabled, customer.time_zone,
        customer.conversion_tracking_setting.conversion_tracking_status,
        customer.conversion_tracking_setting.google_ads_conversion_customer
      FROM customer LIMIT 1
    `, 'Google Ads conversion tracking status failed'),
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable
      FROM customer_conversion_goal
    `, 'Google Ads account conversion goals failed'),
    searchGoogleAdsRows<AdsRow>(connection, `
      SELECT customer.id, segments.conversion_action, segments.conversion_action_name, metrics.conversions, metrics.all_conversions
      FROM customer WHERE ${dates} ORDER BY metrics.all_conversions DESC LIMIT 501
    `, 'Google Ads conversion activity failed'),
  ])
  const customer = requireAdsRow(account?.customer, 'Google Ads customer not found')
  const tracking = objectField(customer.conversionTrackingSetting)
  return {
    customer_id: connection.customerId, ...range, time_zone: stringField(customer.timeZone),
    auto_tagging_enabled: booleanField(customer.autoTaggingEnabled), tracking_status: stringField(tracking?.conversionTrackingStatus),
    conversion_customer: stringField(tracking?.googleAdsConversionCustomer),
    account_goals: goals.map(({ customerConversionGoal }) => ({
      category: stringField(customerConversionGoal?.category), origin: stringField(customerConversionGoal?.origin),
      biddable: customerConversionGoal?.biddable === true,
    })),
    activity: activity.slice(0, 500).map(({ segments, metrics }) => ({
      conversion_action: stringField(segments?.conversionAction), name: stringField(segments?.conversionActionName),
      conversions: Number(metrics?.conversions ?? 0), all_conversions: Number(metrics?.allConversions ?? 0),
    })),
    more_activity: activity.length > 500,
  }
}
