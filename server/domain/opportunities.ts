import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { assertRoleAllows, roleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { readBookingWelcomes } from '~/server/utils/business-outcomes'
import { listIntegrations } from '~/server/utils/organization-integrations'
import { getOrganizationEntitlements } from '~/server/utils/billing-access'
import { readStripeCheckoutSetup } from '~/server/utils/stripe-connect'
import { listProducts, listOrganizationProducts, resolveVariantPrice } from '~/server/utils/product-management'
import { firstExperienceSetupProgress } from '~/server/utils/experience-setup'
import { firstMenuSetupLocation } from '~/server/utils/first-menu-setup'
import { firstPracticeAreaSetupIncomplete } from '~/server/utils/practice-area-setup'
import { firstExperienceSetupPath, firstHomeSetupPath, firstMenuSectionSetupPath, firstPracticeAreaPath, guestConversationPath, productEditorPath, productPaymentPath } from '~/server/utils/dashboard-links'
import { businessGoalStrategySchema, type BusinessGoalStrategy } from '~/shared/business-progress'
import type { BusinessProgressOperation } from '~/shared/business-outcomes'
import type { CurrencyCode } from '~/shared/currencies'
import { resolveBookingPresentation } from '~/utils/booking-presentation'

/*
  What Today suggests, read from what the business has already stored. Setup the
  business has not finished (payments, a domain, a social account, Google Ads, a
  first offering, a price, taking payment) is read from its own rows, and a booked
  guest who has not heard from the business since booking is read from the
  booking and its conversation. Nothing here is recorded or recomputed: each one
  goes away when the write that finishes it lands.
*/

/** A suggestion as the insight face of the `.tc` card draws it. */
export interface OpportunityView {
  id: string
  /** What part of the business: "Payments", "Catalog". */
  status_line: string
  title: string
  detail: string
  icon: string
  /** Where the owner does it in the dashboard. */
  path: string
  product_id: string | null
  location_id: string | null
  /** The guest conversation a welcome is sent in; null for every setup item. */
  conversation_id: string | null
  /** The welcome it pre-writes from the business's own records, for the owner to review and send. */
  message: string | null
}

const AREA: Partial<Record<BusinessProgressOperation, string>> = {
  'social.connect': 'Social', 'google_ads.connect': 'Marketing', 'payments.connect': 'Payments', 'domain.connect': 'Website',
  'product.create': 'Catalog', 'product.payment': 'Payments', 'product.readiness': 'Catalog', 'booking.welcome': 'Messages',
}

const SOCIAL_PROVIDERS = ['instagram', 'facebook', 'discord']

async function authorize(principal: MemberAccessPrincipal) {
  // Suggestions are the owner's decisions about the business; a member is given the tasks they lead to.
  await assertRoleAllows({ ...principal, permissions: { task: ['assign'] } })
}

/** The setup the business has not finished, from its own rows, in the order it matters. */
export async function listOpportunities(db: DbClient, principal: MemberAccessPrincipal, input: { now?: Date; locationId?: string } = {}): Promise<{ opportunities: OpportunityView[] }> {
  await authorize(principal)
  const now = input.now ?? new Date(), organizationId = principal.organizationId
  const [canWrite, canOperate, canManagePayments, canUpdateBilling, canCreateProducts] = await Promise.all([
    roleAllows({ ...principal, permissions: { content: ['update'] } }), roleAllows({ ...principal, permissions: { operations: ['update'] } }),
    roleAllows({ ...principal, permissions: { payments: ['integration'] } }), roleAllows({ ...principal, permissions: { billing: ['update'] } }),
    roleAllows({ ...principal, permissions: { products: ['create'] } }),
  ])
  const [organization, goals, integrations, draft, products, customDomain, entitlements] = await Promise.all([
    queryFirst<{ slug: string; vertical: string; status: string; default_currency: CurrencyCode }>(db, 'SELECT slug, vertical, status, default_currency FROM organization WHERE id = ?', [organizationId]),
    queryAll<{ strategy_json: string }>(db, "SELECT strategy_json FROM organization_goals WHERE organization_id = ? AND status = 'active' AND strategy_json IS NOT NULL ORDER BY updated_at DESC, id DESC", [organizationId]),
    listIntegrations(db, organizationId),
    input.locationId ? null : queryFirst<{ payload_json: string }>(db, "SELECT payload_json FROM onboarding_drafts WHERE organization_id = ? AND status = 'committed' LIMIT 1", [organizationId]),
    queryAll<{ id: string; name: string; kind: string; online_payment_required: number | null }>(db, `SELECT p.id, p.name, p.kind, c.online_payment_required FROM products p
      LEFT JOIN product_booking_configs c ON c.organization_id = p.organization_id AND c.product_id = p.id
      WHERE p.organization_id = ? AND p.active = 1 ${input.locationId ? 'AND EXISTS (SELECT 1 FROM product_locations l WHERE l.organization_id = p.organization_id AND l.product_id = p.id AND l.location_id = ?)' : ''}
      ORDER BY p.created_at, p.id`, [organizationId, ...(input.locationId ? [input.locationId] : [])]),
    queryFirst(db, "SELECT id FROM organization_domains WHERE organization_id = ? AND type = 'custom' AND status <> 'deleted' LIMIT 1", [organizationId]),
    getOrganizationEntitlements(principal.env, organizationId),
  ])
  if (!organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  const strategies = goals.map(goal => businessGoalStrategySchema.parse(JSON.parse(goal.strategy_json)))
  const strategyFor = (channel: BusinessGoalStrategy['channels'][number] | 'payments') => strategies.some(strategy => channel === 'payments' ? strategy.payments === true : strategy.channels.includes(channel))
  const base = `/dashboard/${encodeURIComponent(organization.slug)}`
  const setupDraft = organization.status !== 'suspended' ? draft : null
  // A business that has not gone live sees only what it needs to go live.
  const firstRun = organization.status === 'inactive' && setupDraft !== null
  const items: Array<OpportunityView & { rank: number }> = []
  const offer = (operation: BusinessProgressOperation, subjectId: string, title: string, detail: string, path: string, rank: number, icon: string, productId: string | null = null) =>
    items.push({ id: `${operation}:${subjectId}`, status_line: AREA[operation]!, title, detail, icon, path, product_id: productId, location_id: input.locationId ?? null, conversation_id: null, message: null, rank })

  if (!firstRun && canOperate && strategyFor('google_ads') && !integrations.some(integration => integration.provider === 'google_ads')) {
    offer('google_ads.connect', organizationId, 'Connect Google Ads to your marketing goal', 'Connect the existing Google Ads integration to measure which articles your ads bring customers to.', `${base}/integrations`, 100, 'i-logos-google-ads')
  }
  if (!firstRun && canWrite) {
    if (entitlements.managed_service !== true) {
      offer('social.connect', organizationId, 'Enable social publishing', 'Your social marketing strategy can use connected publishing when its plan requirement is met. You can prepare content now.', `${base}/billing`, 55, 'i-lucide-link')
    } else if (!integrations.some(integration => SOCIAL_PROVIDERS.includes(integration.provider))) {
      offer('social.connect', organizationId, 'Connect your social account', 'Connect the account where customers follow you, so posts can be published and their outcomes tracked here.', `${base}/integrations`, 55, 'i-lucide-link')
    }
  }
  if (firstRun && !customDomain && (entitlements.custom_domains === true || canUpdateBilling)) {
    offer('domain.connect', organizationId, 'Connect a custom domain', 'Use your own website address.', `${base}/website/preferences/domains`, 120, 'i-lucide-globe')
  }
  if (setupDraft && canCreateProducts) {
    const firstProduct = {
      lodging: ['stay', 'Add your first home', 'Start your listing.'],
      experience: ['experience', 'Add your first experience', 'Give guests something to book.'],
      restaurant: ['dish', 'Add your first dish', 'Start your menu.'],
      service: ['service', 'Add your first practice area', 'Start with the name clients will see.'],
    } as const
    const nextProduct = firstProduct[organization.vertical as keyof typeof firstProduct]
    const experienceSetup = organization.vertical === 'experience' ? await firstExperienceSetupProgress(db, organizationId) : null
    if (experienceSetup && !experienceSetup.complete) {
      offer('product.create', organizationId, 'Continue experience setup', 'Finish setting up your first session.', firstExperienceSetupPath(organization.slug), 110, 'i-lucide-list-checks')
    } else if (nextProduct) {
      const [kind, title, detail] = nextProduct
      const areas = kind === 'service' ? await listOrganizationProducts(db, { organizationId, kind, window: { limit: 2, offset: 0 } }) : []
      const existing = kind === 'service' ? areas.length : products.filter(product => product.kind === kind).length
      const menuLocation = kind === 'dish' ? await firstMenuSetupLocation(db, organizationId, setupDraft.payload_json, !firstRun || existing > 0) : null
      if (menuLocation) {
        offer('product.create', organizationId, menuLocation.started ? 'Continue your menu setup' : 'Set up your menu', menuLocation.started ? 'Pick up where you left off.' : detail,
          firstMenuSectionSetupPath(organization.slug, menuLocation.id), 110, 'i-lucide-list-checks')
      } else if (areas.length === 1) {
        const area = areas[0]!
        if (area.page?.path && !area.order_url && await firstPracticeAreaSetupIncomplete({ db, env: principal.env, organizationId, orgSlug: organization.slug, actorId: principal.userId, principal }, area.id)) {
          offer('product.create', organizationId, 'Continue consultation setup', area.name, `${firstPracticeAreaPath(organization.slug)}/${encodeURIComponent(area.id)}`, 110, 'i-lucide-list-checks')
        }
      } else if (!existing && firstRun) {
        const to = kind === 'stay' ? firstHomeSetupPath(organization.slug) : kind === 'experience' ? firstExperienceSetupPath(organization.slug)
          : kind === 'service' ? firstPracticeAreaPath(organization.slug) : `${productEditorPath(organization.slug, 'new')}?kind=${kind}`
        offer('product.create', organizationId, title, detail, to, 110, 'i-lucide-list-checks')
      }
    }
  }
  // Offerings booked by the session or consultation: one without a price cannot be booked, and one with a price can take payment.
  const booked = canOperate && (organization.vertical === 'experience' || organization.vertical === 'service')
    ? (await listProducts(db, organizationId)).filter(product => product.active && product.kind === organization.vertical && products.some(row => row.id === product.id))
    : []
  // The offering's one-time prices where it is booked: none means it cannot be booked; a free one can be.
  const prices = (product: typeof booked[number]) => {
    const locations = input.locationId ? [input.locationId] : [null, ...product.locations.map(location => location.location_id)]
    return product.variants.filter(variant => variant.active).flatMap(variant => locations.flatMap((locationId) => {
      const price = resolveVariantPrice(variant, { currency: organization.default_currency, location_id: locationId, at: now.toISOString(), billing: { type: 'one_time' } })
      return price ? [price.unit_amount] : []
    }))
  }
  const priced = (product: typeof booked[number]) => prices(product).some(amount => amount > 0)
  // A consultation may have no price; an experience without one cannot be booked.
  if (!firstRun && organization.vertical === 'experience') for (const product of booked.filter(product => !prices(product).length)) {
    offer('product.readiness', product.id, `Set a booking price for “${product.name}”`, 'This offering needs a price before guests can book it on your site.', `${productEditorPath(organization.slug, product.id)}/price`, 95, 'i-lucide-list-checks', product.id)
  }
  const bookingPayments = canOperate && (strategyFor('payments') || organization.vertical === 'experience' && entitlements.payments === true)
  const unpaid = bookingPayments ? booked.filter(product => products.find(row => row.id === product.id)?.online_payment_required === 0 && priced(product)) : []
  if (unpaid.length || firstRun && canManagePayments) {
    const setup = await readStripeCheckoutSetup(db, organizationId, principal.env)
    const waiting = setup.connected?.status === 'pending_review'
    const needsConnect = setup.missing.some(field => ['payments.account', 'payments.account_ready', 'payments.account_mode'].includes(field))
    if (firstRun && canManagePayments && needsConnect && !waiting) {
      offer('payments.connect', organizationId, setup.connected ? 'Finish setting up payments' : 'Set up payments', 'Connect with Stripe.', `${base}/payments/payout-method`, 130, 'i-lucide-credit-card')
    } else if (canManagePayments && unpaid.length && setup.missing.length && !waiting) {
      offer('payments.connect', organizationId, setup.connected ? 'Finish your payment setup' : organization.vertical === 'service' ? 'Set up payments for your consultations' : 'Set up payments for your experiences',
        'Complete the existing Stripe setup before requiring payment at booking. A subscription alone does not activate payment acceptance.', `${base}/payments/payout-method`, 100, 'i-lucide-credit-card')
    }
    if (!setup.missing.length) for (const product of unpaid) {
      offer('product.payment', product.id, `Take payment when ${organization.vertical === 'service' ? 'clients' : 'guests'} book “${product.name}”`,
        `Payments are ready, but this offering does not require advance payment. Enable it for a priced offering to collect before ${organization.vertical === 'service' ? 'confirming a consultation' : 'reserving places'}.`,
        productPaymentPath(organization.slug, product.id), 100, 'i-lucide-credit-card', product.id)
    }
  }
  return { opportunities: items.sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id)).map(({ rank: _rank, ...item }) => item) }
}

/** The welcome each booked guest who has not heard from the business since booking is due, by conversation. */
export async function listBookingWelcomes(db: DbClient, principal: MemberAccessPrincipal, input: { now: Date; locationId?: string }): Promise<Map<string, OpportunityView>> {
  if (!await roleAllows({ ...principal, permissions: { operations: ['reply'] } })) return new Map()
  const organization = await queryFirst<{ slug: string; vertical: string }>(db, 'SELECT slug, vertical FROM organization WHERE id = ?', [principal.organizationId])
  if (!organization) throw new HTTPError({ statusCode: 404, message: 'Organization not found' })
  const welcomes = await readBookingWelcomes(db, principal.organizationId, { now: input.now, locationId: input.locationId })
  return new Map(welcomes.map(welcome => [welcome.requestId, {
    id: `booking.welcome:${welcome.requestId}`, status_line: AREA['booking.welcome']!,
    title: welcome.kind === 'stay' ? 'Share info about your place' : 'Share how to prepare',
    detail: `Help ${welcome.guestFirstName ?? `your ${welcome.kind === 'stay' ? 'guest' : resolveBookingPresentation(welcome.productKind, organization.vertical).counterpartyNoun}`} get ready`,
    icon: 'i-lucide-messages-square', path: guestConversationPath(organization.slug, welcome.requestId),
    product_id: welcome.productId, location_id: welcome.locationId, conversation_id: welcome.requestId, message: welcome.message,
  }]))
}

/** Everything Today suggests to a manager: the unfinished setup, then each booked guest's welcome. MCP and the opportunities route read this. */
export async function listSuggestions(db: DbClient, principal: MemberAccessPrincipal, input: { now?: Date; locationId?: string } = {}): Promise<{ opportunities: OpportunityView[] }> {
  const now = input.now ?? new Date()
  const [setup, welcomes] = await Promise.all([listOpportunities(db, principal, { now, locationId: input.locationId }), listBookingWelcomes(db, principal, { now, locationId: input.locationId })])
  return { opportunities: [...setup.opportunities, ...welcomes.values()] }
}
