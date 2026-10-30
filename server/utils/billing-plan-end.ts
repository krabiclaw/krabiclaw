import type Stripe from 'stripe'
import { queryAll } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { planFromSubscriptions, readOrganizationSubscriptions } from '~/server/utils/billing-access'
import { liveHomeSql } from '~/server/utils/billing'
import { setProductPublication } from '~/server/utils/product-management'
import { stopAirbnbSyncForPlanEnd } from '~/server/integrations/channex/airbnb-sync'
import { BASIC_HOMES, isKnownRecurringPlan } from '~/shared/billing-model'

/** A home's publication records who changed it; KrabiClaw's own changes carry this actor, as its other scheduled work does. */
const SYSTEM_ACTOR = 'system'

/**
 * A paid plan ended: Stripe deleted its subscription, or paused it when a
 * trial ended without a card. The organization is on Basic now, so its newest
 * live homes past what Basic includes go back to drafts: a home is taken off
 * the site and its Airbnb sync stopped (the airbnb-sync task runs the stop).
 * The oldest stay as they are. Locations are not counted, so none is turned
 * off. Nothing changes while another subscription still entitles a paid plan.
 */
export async function returnExtrasToDraftsForPlanEnd(env: CloudflareEnv, db: D1Database, event: Stripe.Event): Promise<void> {
  if (event.account) return
  if (event.type !== 'customer.subscription.deleted' && !(event.type === 'customer.subscription.updated' && event.data.object.status === 'paused')) return
  const subscription = event.data.object
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const organizations = await queryAll<{ id: string }>(db, 'SELECT id FROM organization WHERE "stripeCustomerId"=?', [customerId])
  if (organizations.length > 1) throw new Error('Stripe customer belongs to more than one organization')
  const organizationId = organizations[0]?.id
  if (!organizationId) return
  const rows = (await readOrganizationSubscriptions(env, [organizationId])).get(organizationId) ?? []
  if (isKnownRecurringPlan(planFromSubscriptions(organizationId, rows))) return

  const homes = await queryAll<{ id: string; published: number; syncing: number }>(db, `SELECT p.id,
      EXISTS (SELECT 1 FROM product_publications pp WHERE pp.organization_id = p.organization_id AND pp.product_id = p.id AND pp.published = 1) AS published,
      EXISTS (SELECT 1 FROM product_channel_mappings pm WHERE pm.organization_id = p.organization_id AND pm.product_id = p.id AND pm.enabled = 1) AS syncing
    FROM products p WHERE p.organization_id = ? AND ${liveHomeSql('p')} ORDER BY p.created_at DESC, p.id DESC`, [organizationId])
  const extraHomes = homes.slice(0, Math.max(0, homes.length - BASIC_HOMES))
  for (const home of extraHomes.filter(row => row.published)) {
    await setProductPublication(db, { organizationId, productId: home.id, published: false, actor: { actorId: SYSTEM_ACTOR }, env })
  }
  await stopAirbnbSyncForPlanEnd(db, organizationId, extraHomes.filter(row => row.syncing).map(row => row.id))
}
