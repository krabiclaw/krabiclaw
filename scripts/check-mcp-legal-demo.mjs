#!/usr/bin/env node

/**
 * Executes the full legal website setup dry run via MCP against Cedar Legal Demo.
 * Validates the real-world flow an attorney/law firm or AI agent executes using
 * KrabiClaw's canonical MCP tools.
 */
import { createHash } from 'node:crypto'
import { authHeaders, BASE_URL, expectValue, fail, mcp, pass, run, toolData } from './utils/mcp-check.mjs'

const CEDAR_ORG_ID = '5WebMejsoVLyZLHC29wHH5GbQx1jlvCd'
const CEDAR_LOCATION_ID = 'loc-abce1341-c462-4e8d-ab8c-f4f6657f07cf'
// Each practice area belongs to the attorney who handles it, as NCLS's do: the
// managing partner holds most, a second attorney holds litigation and real
// estate. Their member IDs are the demo organization's own memberships.
const ELENA_VANCE = 'znN3lhZxAUX8X6S4jBAjPF8Ff9ghw1c4'
const MARCUS_THORNE = 'mem_cedar_review_app_2026'
const ATTORNEYS = [
  { member_id: ELENA_VANCE, public_name: 'Elena Vance, Esq.', public_bio: 'Managing Partner at Cedar Legal. Advises high-growth businesses on entity formation, commercial contracts, corporate governance, and employment law across North Carolina. J.D., Duke University School of Law.' },
  { member_id: MARCUS_THORNE, public_name: 'Marcus Thorne, Esq.', public_bio: 'Senior Litigation Partner at Cedar Legal. Represents clients in complex civil litigation, commercial contract disputes, fiduciary claims, and commercial real estate transactions. J.D., UNC School of Law.' },
]
const WEEKDAY_HOURS = [1, 2, 3, 4, 5].map(weekday => ({ weekday, start: '09:00', end: '17:00' }))

function expectSuccess(label, response) {
  if (response.status === 200 && response.body?.result && response.body.result.isError !== true) {
    pass(label)
    return toolData(response.body)
  }
  fail(`${label}: expected successful tool result, got status ${response.status}`, response.body)
  throw new Error(`${label} failed`)
}

const LEGAL_IMAGES = [
  {
    key: 'cedar-legal-logo',
    file_id: 'cedar-legal-logo',
    file_name: 'cedar-legal-logo.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/cedar-legal-logo.jpg',
    description: 'Cedar Legal Crest & Wordmark Logo',
    placement: { owner_type: 'organization', owner_id: CEDAR_ORG_ID, slot: 'logo' },
  },
  {
    key: 'cedar-legal-favicon',
    file_id: 'cedar-legal-favicon',
    file_name: 'cedar-legal-favicon.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/cedar-legal-favicon.jpg',
    description: 'Cedar Legal Favicon & Shield Emblem',
    placement: { owner_type: 'organization', owner_id: CEDAR_ORG_ID, slot: 'favicon' },
  },
  {
    key: 'cedar-hero-background',
    file_id: 'cedar-hero-background',
    file_name: 'cedar-hero-background.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/cedar-hero-background.jpg',
    description: 'Cedar Legal Raleigh Boardroom Hero Background',
  },
  {
    key: 'raleigh-office',
    file_id: 'raleigh-office',
    file_name: 'raleigh-office.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/raleigh-office.jpg',
    description: 'Downtown Raleigh Law Office Building & Reception',
    placement: { owner_type: 'business_location', owner_id: CEDAR_LOCATION_ID, slot: 'hero' },
  },
  {
    key: 'attorney-elena-vance',
    file_id: 'attorney-elena-vance',
    file_name: 'attorney-elena-vance.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/attorney-elena-vance.jpg',
    description: 'Elena Vance, Esq. Managing Partner',
  },
  {
    key: 'attorney-marcus-thorne',
    file_id: 'attorney-marcus-thorne',
    file_name: 'attorney-marcus-thorne.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/attorney-marcus-thorne.jpg',
    description: 'Marcus Thorne, Esq. Senior Litigation Partner',
  },
  {
    key: 'attorney-sarah-lin',
    file_id: 'attorney-sarah-lin',
    file_name: 'attorney-sarah-lin.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/attorney-sarah-lin.jpg',
    description: 'Sarah Lin, Esq. Estate Planning Partner',
  },
  {
    key: 'practice-corporate',
    file_id: 'practice-corporate',
    file_name: 'practice-corporate.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/practice-corporate.jpg',
    description: 'Business Formation & Corporate Counsel Practice',
  },
  {
    key: 'practice-estate',
    file_id: 'practice-estate',
    file_name: 'practice-estate.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/practice-estate.jpg',
    description: 'Estate Planning, Wills & Trusts Practice',
  },
  {
    key: 'practice-litigation',
    file_id: 'practice-litigation',
    file_name: 'practice-litigation.jpg',
    download_url: 'https://media.krabiclaw.com/demo/cedar/practice-litigation.jpg',
    description: 'Civil Litigation & Dispute Resolution Practice',
  },
]

async function main() {
  console.log(`Starting Legal Website Setup MCP dry run at ${BASE_URL}\n`)
  const headers = await authHeaders()

  // 1. Workspace Context
  console.log('── Step 1: Discover & Select Workspace ──')
  const orgList = await mcp(headers, 'list_organizations')
  expectSuccess('list_organizations succeeds', orgList)

  const setContext = await mcp(headers, 'set_workspace_context', { organization_id: CEDAR_ORG_ID, location_id: CEDAR_LOCATION_ID })
  expectSuccess('set_workspace_context succeeds', setContext)

  const workspaceContext = await mcp(headers, 'get_workspace_context')
  expectSuccess('get_workspace_context succeeds', workspaceContext)

  // 2. Organization Branding & Settings
  console.log('\n── Step 2: Configure Legal Brand, Typography, Palette & Recipe Tokens ──')
  const currentSettingsRes = await mcp(headers, 'get_organization_settings')
  const currentSettings = expectSuccess('get_organization_settings succeeds', currentSettingsRes)?.settings
  expectValue('current settings returned', Boolean(currentSettings?.id), currentSettings)

  const updateSettingsRes = await mcp(headers, 'update_organization_settings', {
    name: 'Cedar Legal',
    brand_description: 'Premier legal counsel for businesses, individuals, and families throughout North Carolina. Practical solutions, unwavering integrity, and dedicated courtroom advocacy.',
    font_preset: 'cormorant-garamond',
    palette: {
      light: {
        ground: '#FBFBFA',
        surface: '#FFFFFF',
        text: '#1E293B',
        muted: '#64748B',
        action: '#1E3A5F',
        accent: '#B4833E',
      },
      dark: {
        ground: '#0B0F19',
        surface: '#111827',
        text: '#F8FAFC',
        muted: '#94A3B8',
        action: '#254D7A',
        accent: '#C89B55',
      },
    },
    contact_email: 'contact@cedarlegal.com',
    timezone: 'America/New_York',
  })
  const updatedSettings = expectSuccess('update_organization_settings succeeds', updateSettingsRes)
  expectValue('update_organization_settings returned ok', updatedSettings?.ok === true, updatedSettings)

  // 3. Media Assets & Placements
  console.log('\n── Step 3: Register Media Assets & Placements ──')
  const mediaMap = {}
  for (const img of LEGAL_IMAGES) {
    const saveRes = await mcp(headers, 'save_media_attachment', {
      file: {
        download_url: img.download_url,
        file_id: img.file_id,
        file_name: img.file_name,
        mime_type: 'image/jpeg',
      },
      idempotency_key: `cedar-legal-media-${img.key}`,
      description: img.description,
      ...(img.placement ? { placement: img.placement } : {}),
    })
    const saved = expectSuccess(`save_media_attachment (${img.key}) succeeds`, saveRes)
    expectValue(`asset_id returned for ${img.key}`, Boolean(saved?.asset_id), saved)
    mediaMap[img.key] = saved.asset_id
  }

  // Also ensure social_share has a prominent card
  if (mediaMap['cedar-legal-favicon']) {
    const setSocial = await mcp(headers, 'set_media', {
      placement: { owner_type: 'organization', owner_id: CEDAR_ORG_ID, slot: 'social_share' },
      asset_id: mediaMap['cedar-legal-favicon'],
    })
    expectSuccess('set_media on social_share succeeds', setSocial)
  }

  // 4. Office Location & Hours
  console.log('\n── Step 4: Configure Law Office Location & Consultation Hours ──')
  const updateLocationRes = await mcp(headers, 'update_location', {
    location_id: CEDAR_LOCATION_ID,
    title: 'Downtown Raleigh Office',
    description: "Cedar Legal's primary law office located in downtown Raleigh, NC, accessible for client consultations, corporate closings, and depositions.",
    address: {
      regionCode: 'US',
      addressLines: ['420 Fayetteville St', 'Suite 1100'],
      locality: 'Raleigh',
      administrativeArea: 'NC',
      postalCode: '27601',
    },
    phone: '(919) 555-0140',
    email: 'raleigh@cedarlegal.com',
    opening_hours: {
      periods: [
        { open: { day: 1, hour: 8, minute: 30 }, close: { day: 1, hour: 17, minute: 30 } },
        { open: { day: 2, hour: 8, minute: 30 }, close: { day: 2, hour: 17, minute: 30 } },
        { open: { day: 3, hour: 8, minute: 30 }, close: { day: 3, hour: 17, minute: 30 } },
        { open: { day: 4, hour: 8, minute: 30 }, close: { day: 4, hour: 17, minute: 30 } },
        { open: { day: 5, hour: 8, minute: 30 }, close: { day: 5, hour: 17, minute: 30 } },
      ],
    },
  })
  const updatedLocation = expectSuccess('update_location succeeds', updateLocationRes)
  expectValue('office update returned ok', updatedLocation?.ok === true, updatedLocation)

  // 5. Products & Practice Areas
  console.log('\n── Step 5: Configure Practice Areas & Legal Offerings ──')
  const existingProductsRes = await mcp(headers, 'list_location_products', { location_id: CEDAR_LOCATION_ID })
  const existingProducts = expectSuccess('list_location_products succeeds', existingProductsRes)?.products || []

  const allProductIds = []


  // Attorneys: the public profile clients see on each consultation they host,
  // and the hours their consultations are booked in.
  for (const attorney of ATTORNEYS) {
    const currentRes = await mcp(headers, 'get_member_scheduling', { member_id: attorney.member_id })
    const current = expectSuccess(`get_member_scheduling ${attorney.public_name} succeeds`, currentRes)?.scheduling
    const schedulingRes = await mcp(headers, 'set_member_scheduling', {
      member_id: attorney.member_id,
      expected_updated_at: current?.updated_at ?? null,
      timezone: 'America/New_York',
      weekly: WEEKDAY_HOURS,
      time_off: [],
      public_name: attorney.public_name,
      public_bio: attorney.public_bio,
      public_photo_url: current?.public_photo_url ?? null,
      public_approved: true,
    })
    expectSuccess(`set_member_scheduling ${attorney.public_name} succeeds`, schedulingRes)
  }

  // 5 Canonical Practice Areas — each a paid 30-minute consultation, held
  // online in its attorney's hours and booked on the practice area's own page.
  // There is no separate free intake: a client books the area they need.
  const practiceAreas = [
    {
      name: 'Business Formation & Corporate Counsel',
      slug: 'business-counsel',
      description: 'Entity selection, operating agreements, commercial contracts, and ongoing outside general counsel for growing companies across North Carolina.',
      imageKey: 'practice-corporate',
      host: ELENA_VANCE,
      unit_amount: 9000,
    },
    {
      name: 'Estate Planning, Wills & Trusts',
      slug: 'estate-planning',
      description: 'Comprehensive wealth preservation, revocable living trusts, healthcare directives, and estate administration.',
      imageKey: 'practice-estate',
      host: ELENA_VANCE,
      unit_amount: 8000,
    },
    {
      name: 'Employment & Labor Advisory',
      slug: 'employment-law',
      description: 'Employment agreements, non-competes, workplace policy development, and executive compensation negotiations.',
      imageKey: 'practice-corporate',
      host: ELENA_VANCE,
      unit_amount: 8000,
    },
    {
      name: 'Real Estate & Commercial Transactions',
      slug: 'real-estate',
      description: 'Commercial leasing, property acquisitions, title examination, and land development advisory across North Carolina.',
      imageKey: 'practice-estate',
      host: MARCUS_THORNE,
      unit_amount: 9000,
    },
    {
      name: 'Civil Litigation & Dispute Resolution',
      slug: 'civil-litigation',
      description: 'Breach of contract claims, business partnership dissolutions, and fiduciary litigation in state and federal courts.',
      imageKey: 'practice-litigation',
      host: MARCUS_THORNE,
      unit_amount: 8000,
    },
  ]

  for (const area of practiceAreas) {
    const existing = existingProducts.find(p => p.name === area.name || p.slug === area.slug)
    let productId = existing?.id

    if (!productId) {
      const createRes = await mcp(headers, 'create_product', {
        name: area.name,
        description: area.description,
        slug: area.slug,
      })
      const created = expectSuccess(`create_product ${area.name} succeeds`, createRes)?.product
      productId = created?.id
    }

    if (productId) {
      allProductIds.push(productId)

      const pubRes = await mcp(headers, 'set_product_publication', { product_id: productId, published: true })
      expectSuccess(`set_product_publication ${area.name} succeeds`, pubRes)

      const productRes = await mcp(headers, 'get_product', { product_id: productId })
      const product = expectSuccess(`get_product ${area.name} succeeds`, productRes)?.product
      const variant = product?.variants?.[0]
      expectValue(`${area.name} has a variant`, Boolean(variant?.id), product)
      const price = variant.prices.find(entry => entry.currency === 'USD' && entry.location_id === null)
      const consultation = {
        product_id: productId,
        unit_label: 'consultation',
        variants: [{ id: variant.id, prices: [{ ...(price ? { id: price.id } : {}), currency: 'USD', unit_amount: area.unit_amount, type: 'one_time', location_id: null }] }],
        booking: { location_id: null, duration_minutes: 30, default_capacity: 1, scheduling_mode: 'provider', assigned_member_id: area.host, assigned_team_id: null, confirmation_mode: 'instant', online_payment_required: true },
      }
      // The key names this exact request, so a changed consultation is a new write rather than a refused replay.
      const bookingRes = await mcp(headers, 'update_product', {
        ...consultation,
        idempotency_key: `cedar-legal-consultation-${createHash('sha256').update(JSON.stringify(consultation)).digest('hex').slice(0, 32)}`,
      })
      const booked = expectSuccess(`update_product booking ${area.name} succeeds`, bookingRes)?.product
      expectValue(`${area.name} is bookable online`, booked?.booking?.held_online === true && booked?.booking_readiness?.ready === true, booked)

      if (mediaMap[area.imageKey]) {
        const mediaRes = await mcp(headers, 'set_media', {
          placement: { owner_type: 'product', owner_id: productId, slot: 'image' },
          asset_id: mediaMap[area.imageKey],
        })
        expectSuccess(`set_media on ${area.name} succeeds`, mediaRes)
      }
    }
  }

  // A practice books the area it needs; there is no separate free intake. An
  // earlier run of this demo created one, and it stays withheld.
  const legacyIntake = existingProducts.find(p => p.name === 'Initial Legal Consultation')
  if (legacyIntake) {
    const withheld = await mcp(headers, 'set_product_publication', { product_id: legacyIntake.id, published: false })
    expectSuccess('set_product_publication withholds the legacy free intake', withheld)
  }

  // 6. Canonical Pages & Blocks
  console.log('\n── Step 6: Update Canonical Legal Pages, Shield Dividers & Block Layouts ──')

  const pagesListRes = await mcp(headers, 'list_site_pages')
  const pages = expectSuccess('list_site_pages succeeds', pagesListRes)?.pages || []

  async function updatePageByPath(path, title, blocks) {
    const pageSummary = pages.find(p => p.path === path)
    if (!pageSummary) throw new Error(`Page not found for path: ${path}`)

    const pageRes = await mcp(headers, 'get_site_page', { variant_id: pageSummary.id })
    const pageData = expectSuccess(`get_site_page ${path} succeeds`, pageRes)?.page
    const existingBlocks = pageData?.blocks || []
    const removedBlockIds = existingBlocks.map(b => b.id)

    const updateRes = await mcp(headers, 'update_site_page', {
      variant_id: pageSummary.id,
      expected_updated_at: pageData.updated_at,
      path,
      title,
      pageType: pageSummary.page_type,
      recipe: pageSummary.recipe,
      sortOrder: pageSummary.sort_order,
      removed_block_ids: removedBlockIds,
      blocks,
    })
    return expectSuccess(`update_site_page ${path} succeeds`, updateRes)
  }

  const teamBlockMedia = [
    { slot: 'items.0.image', asset_id: mediaMap['attorney-elena-vance'] },
    { slot: 'items.1.image', asset_id: mediaMap['attorney-marcus-thorne'] },
    { slot: 'items.2.image', asset_id: mediaMap['attorney-sarah-lin'] },
  ].filter(m => Boolean(m.asset_id))

  const attorneyTeamData = {
    title: 'Attorneys & Counsel',
    description: 'Meet the legal team dedicated to protecting your interests.',
    items: [
      { first_name: 'Elena', last_name: 'Vance, Esq.', title: 'Managing Partner', bio: 'Corporate governance, M&A transactions, and outside general counsel. Duke University School of Law, J.D.' },
      { first_name: 'Marcus', last_name: 'Thorne, Esq.', title: 'Senior Litigation Partner', bio: 'Complex commercial litigation, contract disputes, and appellate advocacy. UNC School of Law, J.D.' },
      { first_name: 'Sarah', last_name: 'Lin, Esq.', title: 'Partner — Estate & Wealth Planning', bio: 'Trusts, estates, business succession, and asset preservation. Wake Forest University School of Law, J.D.' },
    ],
  }

  // Home page
  await updatePageByPath('/', 'Trusted Legal Counsel in Raleigh, NC', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Attorneys & Counselors at Law',
        title: 'Decisive Legal Counsel. Practical Solutions.',
        subtitle: 'Cedar Legal delivers strategic guidance and courtroom advocacy for businesses, entrepreneurs, and families across North Carolina.',
        cta_label: 'Request a Consultation',
        cta_url: '/schedule',
        secondary_label: 'Our Practice Areas',
        secondary_url: '/services',
      },
      media: mediaMap['cedar-hero-background'] ? [{ slot: 'media', asset_id: mediaMap['cedar-hero-background'] }] : [],
    },
    {
      type: 'divider',
      data: {},
    },
    {
      type: 'feature_grid',
      data: {
        title: 'Why Clients Choose Cedar Legal',
        items: [
          { title: 'Direct Partner Access', description: 'Your legal matter is managed directly by experienced senior counsel, not handed off to junior associates.' },
          { title: 'Transparent Flat-Fee Pricing', description: 'Clear upfront scoping and predictable billing for business transactions, estate plans, and corporate formations.' },
          { title: 'Courtroom-Tested Advocacy', description: 'Tenacious representation backed by extensive trial experience in North Carolina state and federal courts.' },
          { title: 'Focused on Practical Outcomes', description: 'We resolve disputes and structure deals to achieve your commercial and personal objectives efficiently.' },
        ],
      },
    },
    {
      type: 'product_grid',
      data: {
        title: 'Practice Areas',
        description: 'Specialized legal disciplines tailored to complex business and personal matters.',
        product_ids: allProductIds,
      },
    },
    {
      type: 'team_grid',
      data: attorneyTeamData,
      media: teamBlockMedia,
    },
    {
      type: 'testimonial_grid',
      data: {
        title: 'Client Representations',
        description: 'Trusted counsel for business leaders and families throughout North Carolina.',
      },
    },
    {
      type: 'faq',
      data: {
        title: 'Frequently Asked Questions',
        source: 'organization_qa',
      },
    },
    {
      type: 'contact_cta',
      data: {
        title: 'Speak with an Attorney Today',
        description: 'Contact our downtown Raleigh office to discuss your legal matter in confidence.',
        label: 'Schedule Consultation',
        url: '/schedule',
      },
    },
  ])

  // About page
  await updatePageByPath('/about', 'About Our Firm', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Our Heritage & Philosophy',
        title: 'Unwavering Advocacy. Principled Guidance.',
        subtitle: 'Founded in Raleigh, Cedar Legal combines the sophistication of a large corporate practice with the responsiveness and personal attention of a boutique firm.',
      },
    },
    {
      type: 'divider',
      data: {},
    },
    {
      type: 'markdown',
      data: {
        markdown: `### Dedicated to Client Success

At Cedar Legal, we believe effective legal counsel begins with listening. We take the time to understand each client's unique personal or business landscape, tailoring our strategy to mitigate risks before they escalate into costly disputes.

Whether navigating an intricate corporate merger, safeguarding family assets for future generations, or representing clients in state and federal courts, we maintain uncompromising ethical standards and rigorous legal acumen.`,
        editor_mode: 'source',
      },
    },
    {
      type: 'stat_grid',
      data: {
        title: 'Firm by the Numbers',
        items: [
          { value: '25+', title: 'Years Combined Experience' },
          { value: '500+', title: 'Corporate Formations & Deals' },
          { value: '$120M+', title: 'Client Transactions Handled' },
          { value: '98%', title: 'Client Satisfaction Rate' },
        ],
      },
    },
    {
      type: 'team_grid',
      data: attorneyTeamData,
      media: teamBlockMedia,
    },
    {
      type: 'contact_cta',
      data: {
        title: 'Ready to Discuss Your Case?',
        label: 'Contact Us',
        url: '/contact',
      },
    },
  ])

  // Services page
  await updatePageByPath('/services', 'Practice Areas', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Our Capabilities',
        title: 'Specialized Legal Services',
        subtitle: 'From contract drafting and entity formation to complex litigation and wealth planning, our practice areas cover the legal lifecycles of individuals and companies.',
      },
    },
    {
      type: 'divider',
      data: {},
    },
    {
      type: 'product_grid',
      data: {
        title: 'Core Practice Areas',
        product_ids: allProductIds,
      },
    },
    {
      type: 'contact_cta',
      data: {
        title: 'Inquire About Specific Practice Areas',
        description: 'Our attorneys are available for detailed preliminary evaluations.',
        label: 'Request Consultation',
        url: '/schedule',
      },
    },
  ])

  // Contact page
  await updatePageByPath('/contact', 'Contact', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Get In Touch',
        title: 'Contact Our Offices',
        subtitle: 'We welcome prospective clients and corporate inquiries. Reach out to schedule a consultation at our downtown Raleigh office or via secure video conference.',
      },
    },
    {
      type: 'divider',
      data: {},
    },
    {
      type: 'location_grid',
      data: {
        title: 'Office Location & Contact Info',
        location_ids: [CEDAR_LOCATION_ID],
      },
    },
    {
      type: 'contact_form',
      data: {},
    },
  ])

  // Schedule page
  await updatePageByPath('/schedule', 'Schedule a Consultation', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Consultations',
        title: 'Schedule a Consultation',
        subtitle: 'Choose your practice area and book a 30-minute consultation with the attorney who handles it.',
      },
    },
    {
      type: 'divider',
      data: {},
    },
    {
      type: 'how_to',
      data: {
        title: 'Our 3-Step Consultation Process',
        steps: [
          { name: 'Step 1: Conflict Check', text: 'Upon receiving your request, we immediately verify that our firm does not have an active conflict of interest with any opposing party.' },
          { name: 'Step 2: Preliminary Intake', text: 'We review relevant documents, agreements, or court records in advance to maximize our time together.' },
          { name: 'Step 3: Strategy Session', text: 'You meet directly with an attorney to evaluate risk, clarify options, and establish an actionable timeline.' },
        ],
      },
    },
    {
      type: 'callout',
      data: {
        title: 'Attorney-Client Privilege Notice',
        body: 'Information submitted through this intake form is held in strict confidence. However, submitting an inquiry does not create a binding attorney-client relationship until an engagement letter is countersigned.',
      },
    },
  ])

  console.log('\n All MCP operations completed successfully for Cedar Legal Demo!\n')
}

run(main)
