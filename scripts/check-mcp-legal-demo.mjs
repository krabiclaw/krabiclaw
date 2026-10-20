#!/usr/bin/env node

/**
 * Executes the full legal website setup dry run via MCP against Cedar Legal Demo.
 * Validates the real-world flow an attorney/law firm or AI agent executes using
 * KrabiClaw's canonical MCP tools.
 */
import { authHeaders, BASE_URL, expectValue, fail, mcp, pass, run, toolData } from './utils/mcp-check.mjs'

const CEDAR_ORG_ID = '5WebMejsoVLyZLHC29wHH5GbQx1jlvCd'
const CEDAR_LOCATION_ID = 'loc-abce1341-c462-4e8d-ab8c-f4f6657f07cf'

function expectSuccess(label, response) {
  if (response.status === 200 && response.body?.result && response.body.result.isError !== true) {
    pass(label)
    return toolData(response.body)
  }
  fail(`${label}: expected successful tool result, got status ${response.status}`, response.body)
  throw new Error(`${label} failed`)
}

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
  console.log('\n── Step 2: Configure Legal Brand, Typography & Palette ──')
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

  // 3. Office Location & Hours
  console.log('\n── Step 3: Configure Law Office Location & Consultation Hours ──')
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

  // 4. Products & Practice Areas
  console.log('\n── Step 4: Configure Practice Areas & Legal Offerings ──')
  const existingProductsRes = await mcp(headers, 'list_location_products', { location_id: CEDAR_LOCATION_ID })
  const existingProducts = expectSuccess('list_location_products succeeds', existingProductsRes)?.products || []

  // Ensure Initial Consultation product
  const consultationProduct = existingProducts.find(p => p.name.toLowerCase().includes('consultation'))
  if (consultationProduct) {
    const updateConsultation = await mcp(headers, 'update_product', {
      product_id: consultationProduct.id,
      name: 'Initial Legal Consultation',
      description: 'Confidential 45-minute preliminary case review and strategic consultation with a Cedar Legal attorney under North Carolina law.',
    })
    expectSuccess('update_product on initial consultation succeeds', updateConsultation)
  }

  // 5 Canonical Practice Areas
  const practiceAreas = [
    {
      name: 'Business Formation & Corporate Counsel',
      slug: 'business-counsel',
      description: 'Entity selection, operating agreements, commercial contracts, and ongoing outside general counsel for growing companies across North Carolina.',
    },
    {
      name: 'Estate Planning, Wills & Trusts',
      slug: 'estate-planning',
      description: 'Comprehensive wealth preservation, revocable living trusts, healthcare directives, and estate administration.',
    },
    {
      name: 'Employment & Labor Advisory',
      slug: 'employment-law',
      description: 'Employment agreements, non-competes, workplace policy development, and executive compensation negotiations.',
    },
    {
      name: 'Real Estate & Commercial Transactions',
      slug: 'real-estate',
      description: 'Commercial leasing, property acquisitions, title examination, and land development advisory across North Carolina.',
    },
    {
      name: 'Civil Litigation & Dispute Resolution',
      slug: 'civil-litigation',
      description: 'Breach of contract claims, business partnership dissolutions, and fiduciary litigation in state and federal courts.',
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
      const pubRes = await mcp(headers, 'set_product_publication', { product_id: productId, published: true })
      expectSuccess(`set_product_publication ${area.name} succeeds`, pubRes)

      const locRes = await mcp(headers, 'set_product_location', { product_id: productId, location_id: CEDAR_LOCATION_ID, active: true, published: true })
      expectSuccess(`set_product_location ${area.name} succeeds`, locRes)
    }
  }

  // 5. Canonical Pages & Blocks
  console.log('\n── Step 5: Update Canonical Legal Pages & Block Layouts ──')

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

  // Home page
  await updatePageByPath('/', 'Cedar Legal | Trusted Legal Counsel in Raleigh, NC', [
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
      },
    },
    {
      type: 'team_grid',
      data: {
        title: 'Attorneys & Counsel',
        description: 'Meet the legal team dedicated to protecting your interests.',
        items: [
          { first_name: 'Elena', last_name: 'Vance, Esq.', title: 'Managing Partner', bio: 'Corporate governance, M&A transactions, and outside general counsel. Duke University School of Law, J.D.' },
          { first_name: 'Marcus', last_name: 'Thorne, Esq.', title: 'Senior Litigation Partner', bio: 'Complex commercial litigation, contract disputes, and appellate advocacy. UNC School of Law, J.D.' },
          { first_name: 'Sarah', last_name: 'Lin, Esq.', title: 'Partner — Estate & Wealth Planning', bio: 'Trusts, estates, business succession, and asset preservation. Wake Forest University School of Law, J.D.' },
        ],
      },
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
  await updatePageByPath('/about', 'About Our Firm | Cedar Legal', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Our Heritage & Philosophy',
        title: 'Unwavering Advocacy. Principled Guidance.',
        subtitle: 'Founded in Raleigh, Cedar Legal combines the sophistication of a large corporate practice with the responsiveness and personal attention of a boutique firm.',
      },
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
      data: {
        title: 'Our Leadership Team',
        items: [
          { first_name: 'Elena', last_name: 'Vance, Esq.', title: 'Managing Partner' },
          { first_name: 'Marcus', last_name: 'Thorne, Esq.', title: 'Senior Litigation Partner' },
          { first_name: 'Sarah', last_name: 'Lin, Esq.', title: 'Partner — Estate & Wealth Planning' },
        ],
      },
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
  await updatePageByPath('/services', 'Practice Areas | Cedar Legal', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Our Capabilities',
        title: 'Specialized Legal Services',
        subtitle: 'From contract drafting and entity formation to complex litigation and wealth planning, our practice areas cover the legal lifecycles of individuals and companies.',
      },
    },
    {
      type: 'product_grid',
      data: {
        title: 'Core Practice Areas',
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
  await updatePageByPath('/contact', 'Contact Cedar Legal | Raleigh Law Office', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Get In Touch',
        title: 'Contact Our Offices',
        subtitle: 'We welcome prospective clients and corporate inquiries. Reach out to schedule a consultation at our downtown Raleigh office or via secure video conference.',
      },
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
  await updatePageByPath('/schedule', 'Schedule a Consultation | Cedar Legal', [
    {
      type: 'hero',
      data: {
        eyebrow: 'Legal Intake',
        title: 'Schedule an Initial Consultation',
        subtitle: 'Take the first step toward resolving your legal matter. Reserve a 45-minute confidential intake consultation with our legal team.',
      },
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
    {
      type: 'booking_cta',
      data: {
        title: 'Book Your Intake Consultation',
        description: 'Select an available appointment time with our attorneys.',
        label: 'Select Appointment Slot',
        url: '#booking',
      },
    },
  ])

  console.log('\n All MCP operations completed successfully for Cedar Legal Demo!\n')
}

run(main)
