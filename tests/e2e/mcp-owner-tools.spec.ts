import { expect, request as playwrightRequest, test, type APIRequestContext, type Page } from '@playwright/test'
import { blawbyBaseURL, blawbyExtraHeaders, dismissPreviewToolbar, openTenantPage, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { MCP_ORGANIZATION_ID, mcpRequest, mcpData, publishOwnHostProfile } from './helpers/mcp'
import { E2E_POTTERY_ORGANIZATION_ID, tenantTestExtraHeaders } from './test-env'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { generateReservationTimes, type OpeningHours, type SpecialHours } from '../../shared/reservation-hours'
import { addLocalDays, localDateAt, localDateTimeToInstant, localNow } from '../../utils/timezone'
import type { OrganizationMembersData } from '../../utils/organization-members'
import type { Product } from '../../server/types/products'
import type { SessionAvailability } from '../../server/utils/availability'

// Split out of mcp.spec.ts (owner tool-coverage tests) — see helpers/mcp.ts
// for why. This group covers the bulk of an owner's MCP tool surface: site
// page/settings, notifications/submissions, location/reviews/QA
// lifecycle, and Product/post/media workflows.

test.describe('stateless MCP server', () => {
  test('saved workspace location survives readback and supplies a location-scoped call while explicit targets win', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)
    const call = async <T>(toolName: string, args: Record<string, unknown>) => {
      const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args })
      expect(response.status()).toBe(200)
      return mcpData<T>(await response.json())
    }
    const locations = await call<{ locations: Array<{ id: string }> }>('list_locations', { organization_id: MCP_ORGANIZATION_ID })
    expect(locations.locations.length).toBeGreaterThan(0)
    const locationId = locations.locations[0]!.id
    await call('set_workspace_context', { organization_id: MCP_ORGANIZATION_ID, location_id: locationId })
    const workspace = await call<{ context: { organization_id: string; location_id: string } }>('get_workspace_context', {})
    expect(workspace.context).toMatchObject({ organization_id: MCP_ORGANIZATION_ID, location_id: locationId })
    const implicit = await call<{ context: { organization_id: string; location_id: string } }>('get_location', {})
    expect(implicit.context).toMatchObject({ organization_id: MCP_ORGANIZATION_ID, location_id: locationId })
    const explicit = await call<{ context: { organization_id: string } }>('get_organization', { organization_id: E2E_POTTERY_ORGANIZATION_ID })
    expect(explicit.context.organization_id).toBe(E2E_POTTERY_ORGANIZATION_ID)
    const unchanged = await call<{ context: { organization_id: string; location_id: string } }>('get_workspace_context', {})
    expect(unchanged.context).toMatchObject({ organization_id: MCP_ORGANIZATION_ID, location_id: locationId })
  })

  test('booking pagination rejects a cursor from a different member filter', async ({ request, baseURL },testInfo) => {
    const release = await acquireTenantMutationLock(testInfo,E2E_POTTERY_ORGANIZATION_ID)
    try {
    await loginAs(request, baseURL!)
    const organizationId = E2E_POTTERY_ORGANIZATION_ID
    const membersResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'get_member_scheduling', args: { organization_id: organizationId } })
    expect(membersResponse.status()).toBe(200)
    const member = mcpData<{ members: Array<{ id: string; self: boolean }> }>(await membersResponse.json()).members.find(member => member.self)
    expect(member).toBeTruthy()
    const firstResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'list_product_bookings', args: { organization_id: organizationId, limit: 1 } })
    expect(firstResponse.status()).toBe(200)
    const first = mcpData<{ bookings: Array<{ operational_booking_id: string }>; page_info: { next_cursor: string | null } }>(await firstResponse.json())
    expect(first.bookings).toHaveLength(1)
    expect(first.page_info.next_cursor).toBeTruthy()
    const nextResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'list_product_bookings', args: { organization_id: organizationId, limit: 1, cursor: first.page_info.next_cursor } })
    expect(nextResponse.status()).toBe(200)
    const next = mcpData<{ bookings: Array<{ operational_booking_id: string }> }>(await nextResponse.json())
    expect(next.bookings).toHaveLength(1)
    expect(next.bookings[0]!.operational_booking_id).not.toBe(first.bookings[0]!.operational_booking_id)
    const filteredResponse = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName: 'list_product_bookings', args: { organization_id: organizationId, assigned_member_id: member!.id, limit: 1, cursor: first.page_info.next_cursor } })
    expect(filteredResponse.status()).toBe(200)
    expect((await filteredResponse.json()).result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Pagination cursor does not belong to this resource.' }] })
    } finally { await release() }
  })

  test('owner can use site content and settings tools', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)
    const organizationId = MCP_ORGANIZATION_ID

    const organizationsList = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'list_organizations',
      args: {},
    })
    expect(organizationsList.status()).toBe(200)
    const organizationsListBody = await organizationsList.json()
    const organizationsListText = organizationsListBody?.result?.content?.[0]?.text as string | undefined
    expect(organizationsListText).toContain('You have')

    const organizationRead = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_organization',
      args: { organization_id: organizationId },
    })
    expect(organizationRead.status()).toBe(200)

    const pageList = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'list_site_pages',
      args: { organization_id: organizationId, locale: 'en' },
    })
    expect(pageList.status()).toBe(200)
    const homeVariant = mcpData<{ pages: Array<{ id: string; path: string }> }>(await pageList.json()).pages.find(page => page.path === '/')
    expect(homeVariant?.id).toBeTruthy()

    const pageBefore = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_site_page',
      args: { organization_id: organizationId, variant_id: homeVariant!.id },
    })
    expect(pageBefore.status()).toBe(200)
    const pageBeforeData = mcpData<{
      page: {
        updated_at: string
        path: string
        title: string
        sort_order: number
        page_type: string
        recipe: string | null
        blocks: Array<{ id: string; type: string; level: number | null; parent_block_id: string | null; source_block_id: string | null; data: Record<string, unknown>; media: unknown[] }>
      }
    }>(await pageBefore.json()).page
    const pageSnapshot = {
      path: pageBeforeData.path, title: pageBeforeData.title,
      sortOrder: pageBeforeData.sort_order, pageType: pageBeforeData.page_type, recipe: pageBeforeData.recipe,
      blocks: pageBeforeData.blocks.map(({ id, type, level, parent_block_id, source_block_id, data, media }) =>
        ({ id, type, level, parent_block_id, source_block_id, data, media })),
    }
    const pageEditorPath = `${baseURL}/api/editor/organizations/${organizationId}/pages/${homeVariant!.id}`
    const editorPageBefore = await request.get(pageEditorPath)
    expect(editorPageBefore.status()).toBe(200)
    const savedPageBefore = (await editorPageBefore.json()).page
    const pathChange = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'update_site_page', args: {
        organization_id: organizationId, variant_id: homeVariant!.id, expected_updated_at: pageBeforeData.updated_at,
        ...pageSnapshot, path: '/another-home-address', title: 'Must not be saved',
      },
    })
    expect(pathChange.status()).toBe(200)
    const pathChangeResult = (await pathChange.json()).result
    expect(pathChangeResult.isError).toBe(true)
    expect(pathChangeResult.content).toHaveLength(1)
    expect(pathChangeResult.content[0].type).toBe('text')
    expect(JSON.parse(pathChangeResult.content[0].text)).toEqual({ status: 400, message: 'A page keeps its saved path' })
    const unchangedPageRead = await request.get(pageEditorPath)
    expect(unchangedPageRead.status()).toBe(200)
    expect((await unchangedPageRead.json()).page).toEqual(savedPageBefore)
    const httpPathChange = await request.patch(pageEditorPath, { data: {
      ...pageSnapshot, expectedUpdatedAt: pageBeforeData.updated_at, path: '/another-home-address', title: 'Must not be saved',
    } })
    expect(httpPathChange.status()).toBe(400)
    const unchangedHttpPageRead = await request.get(pageEditorPath)
    expect(unchangedHttpPageRead.status()).toBe(200)
    expect((await unchangedHttpPageRead.json()).page).toEqual(savedPageBefore)
    for (const [type, data, message] of [
      ['showcase', { items: [{ title: ' ' }] }, /title/],
      ['steps', { items: [{}] }, /required.*title/],
      ['language_reach', { items: [{ title: 'English', locale: 'invalid' }] }, /locale/],
      ['language_reach', { items: [{ locale: 'en' }] }, /required.*title/],
    ] as const) {
      const invalid = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'append_content_block',
        args: { organization_id: organizationId, document_id: homeVariant!.id, type, data },
      })
      expect(invalid.status()).toBe(200)
      const rejected = await invalid.json()
      expect(rejected.result.isError).toBe(true)
      expect(rejected.result.content[0].text).toMatch(message)
    }
    const unchanged = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'get_site_page',
      args: { organization_id: organizationId, variant_id: homeVariant!.id },
    })
    expect(unchanged.status()).toBe(200)
    const unchangedPage = mcpData<{ page: { blocks: unknown[]; updated_at: string } }>(await unchanged.json()).page
    expect(unchangedPage.blocks).toEqual(pageBeforeData.blocks)
    expect(unchangedPage.updated_at).toBe(pageBeforeData.updated_at)
    // update_site_page replaces the document, so the writer states the path,
    // title and identity it read rather than leaving them to be filled in from
    // the stored row. Order is the array's; there is no position to send.
    const renamedPageTitle = `MCP page title ${Date.now()}`
    const contentUpdate = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'update_site_page',
      args: {
        organization_id: organizationId,
        variant_id: homeVariant!.id,
        expected_updated_at: pageBeforeData.updated_at,
        path: pageBeforeData.path,
        title: renamedPageTitle,
        sortOrder: pageBeforeData.sort_order,
        pageType: pageBeforeData.page_type,
        recipe: pageBeforeData.recipe,
        blocks: pageBeforeData.blocks.map(block => ({
          id: block.id,
          type: block.type,
          level: block.level,
          parent_block_id: block.parent_block_id,
          source_block_id: block.source_block_id,
          data: block.type === 'hero'
            ? { ...block.data, title: `MCP Hero ${Date.now()}`, subtitle: 'Drafted through MCP' }
            : block.data,
          media: block.media,
        })),
      },
    })
    expect(contentUpdate.status()).toBe(200)
    expect(mcpData<{ page: { id: string } }>(await contentUpdate.json()).page.id).toBe(homeVariant!.id)

    const contentRead = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_site_page',
      args: { organization_id: organizationId, variant_id: homeVariant!.id },
    })
    expect(contentRead.status()).toBe(200)
    const mergedBody = await contentRead.json()
    const mergedHero = mcpData<{ page: { blocks: Array<{ type: string; data: Record<string, unknown> }> } }>(mergedBody).page.blocks.find(item => item.type === 'hero')
    expect(mergedHero?.data.title).toContain('MCP Hero')
    const renamedPage = await request.get(pageEditorPath)
    expect(renamedPage.status()).toBe(200)
    expect((await renamedPage.json()).page).toMatchObject({ path: pageBeforeData.path, title: renamedPageTitle })

    const settingsBefore = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_organization_settings',
      args: { organization_id: organizationId },
    })
    expect(settingsBefore.status()).toBe(200)

    const settingsUpdate = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'update_organization_settings',
      args: { organization_id: organizationId, brand_description: 'Updated through MCP' },
    })
    expect(settingsUpdate.status()).toBe(200)

    const paletteUpdate = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'update_organization_settings',
      args: { organization_id: organizationId, palette: { light: { action: '#0F4C5C' } } },
    })
    expect(mcpData<{ ok: boolean }>(await paletteUpdate.json()).ok).toBe(true)
    const paletteRead = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_organization_settings',
      args: { organization_id: organizationId },
    })
    const readBack = mcpData<{ settings: { palette: { light: { action: string } }; palette_source: string } }>(await paletteRead.json()).settings
    expect(readBack.palette.light.action).toBe('#0F4C5C')
    expect(readBack.palette_source).toBe('custom')

  })

  test('owner can use submission inquiry tools', async ({ request, baseURL }, testInfo) => {
    // A public reservation here shares the demo location's capacity with the calendar specs.
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, MCP_ORGANIZATION_ID)
    try {
      await loginAs(request, baseURL!)
      const organizationId = MCP_ORGANIZATION_ID

      const locationId = 'loc-demo'

      // Creating the policy is what lets a location take reservations: there is
      // no site-level default underneath it, so a guest cannot book until the
      // owner has said the branch takes tables.
      const currentPolicy = await mcpRequest(request,baseURL!,{method:'tools/call',toolName:'get_reservation_policy',args:{organization_id:organizationId,location_id:locationId}})
      const policyBody = await currentPolicy.json()
      let policyVersion: string | null = null
      if (policyBody.result?.isError) {
        expect(JSON.parse(policyBody.result.content[0].text)).toEqual({ status: 404, code: 'RESERVATION_POLICY_NOT_FOUND', message: 'Reservation policy not found' })
        expect(policyBody.result.structuredContent).toBeUndefined()
      } else {
        policyVersion = mcpData<{policy:{updated_at:string}}>(policyBody).policy.updated_at
      }
      // Clearing the duration selects the standard two-hour table reservation;
      // the existing policy and cancellation fields are preserved.
      const standardDuration = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'update_reservation_policy',
        args: { organization_id: organizationId, location_id: locationId, duration_minutes: null, expected_updated_at: policyVersion },
      })
      expect(standardDuration.status()).toBe(200)
      expect(mcpData<{ ok: boolean }>(await standardDuration.json()).ok).toBe(true)
      const defaultsRead = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/locations/${locationId}/reservation-config`)
      expect(defaultsRead.status()).toBe(200)
      const defaultedPolicy = (await defaultsRead.json()).config
      expect(defaultedPolicy.duration_minutes).toBe(120)
      expect(defaultedPolicy.updated_at).not.toBe(policyVersion)
      if (!policyBody.result?.isError) {
        expect({ ...defaultedPolicy, duration_minutes: policyBody.result.structuredContent.policy.duration_minutes, updated_at: policyVersion }).toEqual(policyBody.result.structuredContent.policy)
      }
      policyVersion = defaultedPolicy.updated_at
      const policySetup = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'update_reservation_policy',
        args: { organization_id: organizationId, location_id: locationId, slot_capacity: 20, duration_minutes: 60, expected_updated_at: policyVersion },
      })
      // Duration and capacity are sent: every other stored field, the cancellation
      // policy included, is kept. The tool result says so, not the HTTP status.
      expect(mcpData<{ ok: boolean }>(await policySetup.json()).ok).toBe(true)
      const policyRead = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'get_reservation_policy',
        args: { organization_id: organizationId, location_id: locationId },
      })
      expect(mcpData<{ policy: { slot_capacity: number | null } }>(await policyRead.json()).policy.slot_capacity).toBe(20)

      // The public routes resolve their tenant from the host, and baseURL is the
      // platform's. This used to land on the right tenant only because
      // ensureOrganization re-provisioned the fixture organization on every run and
      // moved its subdomain; naming the tenant is what the other guest journeys
      // already do, and it does not depend on rewriting a live tenant to work.
      const asTenant = { 'x-preview-tenant': 'demo' }
      const contactEmail = `mcp-contact-${Date.now()}@example.test`
      const reservationEmail = `mcp-res-${Date.now()}@example.test`
      const publicContact = await request.post(`${baseURL}/api/public/contact`, {
        headers: asTenant,
        data: { name: `MCP Contact ${contactEmail}`, email: contactEmail, message: 'hello from MCP e2e' },
      })
      expect(publicContact.status()).toBe(201)
      const publicReservation = await request.post(`${baseURL}/api/public/reservations`, {
        headers: asTenant,
        data: {
          idempotency_key: crypto.randomUUID(),
          name: 'MCP Reservation',
          email: reservationEmail,
          phone: '+14155552673',
          date: '2030-01-15',
          time: '19:00',
          guests: '2',
          location_id: locationId,
        },
      })
      expect(publicReservation.status(), await publicReservation.text()).toBe(201)

      const listContacts = await mcpRequest(request, baseURL!, {
        method: 'tools/call',
        toolName: 'list_guest_conversations',
        args: { organization_id: organizationId, type: 'contact', limit: 100 },
      })
      expect(listContacts.status()).toBe(200)
      const contactsBody = await listContacts.json()
      // The shared demo inbox holds other runs' submissions; read back this test's own.
      const contactSubmission = mcpData<{ conversations: Array<{ request_id: string; guest_name: string; preview: string }> }>(contactsBody)
        .conversations.find(row => row.guest_name === `MCP Contact ${contactEmail}`)
      expect(contactSubmission).toMatchObject({ request_id: expect.any(String), preview: 'hello from MCP e2e' })
      const contactRead = await mcpRequest(request,baseURL!,{method:'tools/call',toolName:'get_guest_conversation',args:{organization_id:organizationId,request_id:contactSubmission!.request_id}})
      expect(mcpData<{conversation:{guest:{email:string}}}>(await contactRead.json()).conversation.guest.email).toBe(contactEmail)

      const listReservations = await mcpRequest(request, baseURL!, {
        method: 'tools/call',
        toolName: 'list_reservation_inquiries',
        args: { organization_id: organizationId },
      })
      expect(listReservations.status()).toBe(200)
      const reservationsBody = await listReservations.json()
      const reservationSubmission = mcpData<{ submissions: Array<{
        id: string
        location_id: string | null
        location_title: string | null
        guests: string
        date: string
        time: string
        email: string
      }> }>(reservationsBody).submissions.find(row => row.email === reservationEmail)
      const reservationSubmissionId = reservationSubmission?.id
      expect(reservationSubmissionId).toEqual(expect.any(String))
      expect(reservationSubmission?.location_id).toEqual(expect.any(String))
      expect(reservationSubmission?.location_title).toEqual(expect.any(String))
      expect(reservationSubmission?.guests).toBe('2')
      expect(reservationSubmission?.date).toBe('2030-01-15')
      expect(reservationSubmission?.time).toBe('19:00')

      const tools = await mcpRequest(request, baseURL!, {
        method: 'tools/list',
        organizationId,
      })
      expect(tools.status()).toBe(200)
      const toolsBody = await tools.json() as { result: { tools: Array<{ name: string }> } }
      const toolNames = toolsBody.result.tools.map(tool => tool.name)
      expect(toolNames).toContain('list_guest_conversations')
      expect(toolNames).toContain('list_reservation_inquiries')
    } finally {
      await releaseTenantMutationLock()
    }
  })

  test('owner reads the calendar, blocks and opens dates, and sets its policy through MCP, and guests see it', async ({ request, page, baseURL }, testInfo) => {
    const organizationId = MCP_ORGANIZATION_ID
    const locationId = 'loc-demo'
    // Far enough out that nothing else in the suite books it, and on a
    // Tuesday and Wednesday: a day the hours never open is unavailable for
    // its own reason, which would make the reopening look like it failed.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    let firstOffset = 45
    while (new Date(day(firstOffset)).getUTCDay() !== 2) firstOffset += 1
    const from = day(firstOffset)
    const to = day(firstOffset + 1)
    const before_ = day(firstOffset - 1)
    const after_ = day(firstOffset + 2)
    const releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, organizationId)
    let priorPolicy: Record<string, unknown> | null = null
    try {
      await loginAs(request, baseURL!)
      const asTenant = { 'x-preview-tenant': 'demo' }
      const guestSlots = async (date: string) => {
        const response = await request.get(`${baseURL}/api/public/reservations/availability`, { headers: asTenant, params: { location_id: locationId, date, days: 1 } })
        expect(response.status(), await response.text()).toBe(200)
        return (await response.json() as { dates: Array<{ slots: unknown[] }> }).dates[0]!.slots.length
      }
      const configUrl = `${baseURL}/api/editor/organizations/${organizationId}/locations/${locationId}/reservation-config`
      const original = await request.get(configUrl)
      expect(original.status()).toBe(200)
      priorPolicy = (await original.json()).config
      const configuredDuration = await request.put(configUrl, { data: { duration_minutes: 60, expected_updated_at: priorPolicy!.updated_at } })
      expect(configuredDuration.status(),await configuredDuration.text()).toBe(200)
      const calendar = async () => {
        const response = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'get_calendar',
          args: { organization_id: organizationId, location_id: locationId, from: before_, to: after_ },
        })
        expect(response.status(), await response.text()).toBe(200)
        return mcpData<{ items: unknown[]; available_kinds: string[]; unavailable_dates: Array<{ date: string; reason: string }> }>(await response.json())
      }

      const before = await calendar()
      expect(before.available_kinds).toContain('reservation')
      expect(before.unavailable_dates.map(entry => entry.date)).not.toContain(from)
      expect(await guestSlots(from)).toBeGreaterThan(0)

      const blocked = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'block_dates',
        args: { organization_id: organizationId, location_id: locationId, from, to, note: 'Private event' },
      })
      expect(blocked.status(), await blocked.text()).toBe(200)
      expect(mcpData<{ ok: boolean; changed_fields: string[] }>(await blocked.json())).toMatchObject({ ok: true, changed_fields: ['special_hours'] })

      // The calendar says the days and why, the guest is offered nothing on
      // them, and the days either side are untouched.
      const during = await calendar()
      expect(during.unavailable_dates).toEqual(expect.arrayContaining([{ date: from, location_id: locationId, reason: 'closure', note: 'Private event' }, { date: to, location_id: locationId, reason: 'closure', note: 'Private event' }]))
      expect(during.unavailable_dates.map(entry => entry.date)).not.toContain(before_)
      expect(await guestSlots(from)).toBe(0)
      expect(await guestSlots(to)).toBe(0)
      expect(await guestSlots(after_)).toBeGreaterThan(0)

      // Opening only the first day cuts the closure, so the second stays closed.
      const opened = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'open_dates',
        args: { organization_id: organizationId, location_id: locationId, from, to: from },
      })
      expect(opened.status(), await opened.text()).toBe(200)
      const after = await calendar()
      expect(after.unavailable_dates.map(entry => entry.date)).not.toContain(from)
      expect(after.unavailable_dates).toEqual(expect.arrayContaining([{ date: to, location_id: locationId, reason: 'closure', note: 'Private event' }]))
      expect(await guestSlots(from)).toBeGreaterThan(0)
      expect(await guestSlots(to)).toBe(0)

      const cleared = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'open_dates',
        args: { organization_id: organizationId, location_id: locationId, from: to, to },
      })
      expect(cleared.status(), await cleared.text()).toBe(200)
      expect((await calendar()).unavailable_dates.map(entry => entry.date)).not.toContain(to)
      expect(await guestSlots(to)).toBeGreaterThan(0)

      // The calendar's settings are MCP's too: a named cancellation policy is
      // what the dashboard's card reads back, and advance notice is what the
      // guest is offered. Notice longer than the days to `from` empties it.
      const policy = async () => {
        const response = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'get_reservation_policy', args: { organization_id: organizationId, location_id: locationId },
        })
        expect(response.status(), await response.text()).toBe(200)
        return mcpData<{ policy: Record<string, unknown>; cancellation_policy: string | null }>(await response.json())
      }
      const currentPolicy = (await policy()).policy
      const firm = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'update_reservation_policy',
        args: { organization_id: organizationId, location_id: locationId, duration_minutes: 60, expected_updated_at: currentPolicy.updated_at, cancellation_policy: 'firm', advance_notice_minutes: (firstOffset + 2) * 1440, deposit_required: false, deposit_trigger_party_size: null, additional_notes_html: '<p>Please call for dietary requests.</p>' },
      })
      expect(firm.status(), await firm.text()).toBe(200)
      const dashboardConfig = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/locations/${locationId}/reservation-config`)
      expect(dashboardConfig.status(), await dashboardConfig.text()).toBe(200)
      expect((await dashboardConfig.json()).config).toMatchObject({ free_cancellation_until_minutes: 2880, reschedule_allowed: true, reschedule_cutoff_minutes: 2880, deposit_required: false, deposit_trigger_party_size: null, additional_notes_html: '<p>Please call for dietary requests.</p>' })
      expect((await policy()).cancellation_policy).toBe('firm')
      expect(await guestSlots(from)).toBe(0)
      // Guests see the actual cancellation and rescheduling terms and the owner's note.
      await dismissPreviewToolbar(page)
      await page.setExtraHTTPHeaders(asTenant)
      expect((await page.goto(`${baseURL}/reservations`))?.status()).toBe(200)
      await waitForNuxtHydration(page)
      await page.locator('label[for="reservation-booking-toggle"][role="button"]').first().click()
      await page.getByRole('dialog').locator('label[role="button"]').click()
      const terms = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Reservation policies', exact: true }) })
      await expect(terms).toContainText('Cancel free up to 2 days before your booking.')
      await expect(terms).toContainText('Please call for dietary requests.')
      await expect(terms).toContainText('You can reschedule up to 2 days before the start time.')
      await expect(terms).not.toContainText(/deposit/i)
    } finally {
      try {
      // Whatever failed above, loc-demo is handed back open and on the policy
      // it had: a closure or a notice left behind would fail every later
      // journey that books it.
      const handedBack = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName: 'open_dates',
        args: { organization_id: organizationId, location_id: locationId, from, to },
      })
      expect(handedBack.status(), await handedBack.text()).toBe(200)
      if (priorPolicy) {
        const current = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/locations/${locationId}/reservation-config`)
        expect(current.status()).toBe(200)
        const restored = await mcpRequest(request, baseURL!, {
          method: 'tools/call', toolName: 'update_reservation_policy',
          args: {
            organization_id: organizationId, location_id: locationId,
            expected_updated_at: (await current.json()).config.updated_at,
            duration_minutes: priorPolicy.duration_minutes,
            deposit_required: priorPolicy.deposit_required ?? false,
            deposit_trigger_party_size: priorPolicy.deposit_trigger_party_size ?? null,
            additional_notes_html: priorPolicy.additional_notes_html ?? null,
            advance_notice_minutes: priorPolicy.advance_notice_minutes ?? null,
            free_cancellation_until_minutes: priorPolicy.free_cancellation_until_minutes ?? null,
            reschedule_allowed: priorPolicy.reschedule_allowed ?? true,
            reschedule_cutoff_minutes: priorPolicy.reschedule_cutoff_minutes ?? null,
          },
        })
        expect(restored.status(), await restored.text()).toBe(200)
      }
      } finally { await releaseTenantMutationLock() }
    }
  })

  test('owner can use location, reviews, and QA lifecycle tools', async ({ request, baseURL }) => {
    await loginAs(request, baseURL!)
    const organizationId = MCP_ORGANIZATION_ID

    const locationId = 'loc-demo'

    const locationRead = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_location',
      args: { organization_id: organizationId, location_id: locationId },
    })
    expect(locationRead.status()).toBe(200)
    const originalLocation = mcpData<{ location: { title: string; slug: string; phone: string | null; updated_at: string } }>(await locationRead.json()).location
    const locationApiPath = `${baseURL}/api/organizations/${organizationId}/locations/${locationId}`
    const locationBefore = await request.get(locationApiPath)
    expect(locationBefore.status()).toBe(200)
    const originalLocationRead = await locationBefore.json()
    for (const path of [locationApiPath, `${baseURL}/api/dashboard/locations/${locationId}`]) {
      const moved = await request.patch(path, { data: { slug: 'another-location-address', title: 'Must not be saved' } })
      expect(moved.status()).toBe(400)
      expect(await moved.json()).toMatchObject({ error: 'A location keeps its saved slug', code: 'INVALID_LOCATION_FIELD', field: 'slug' })
      const unchanged = await request.get(locationApiPath)
      expect(unchanged.status()).toBe(200)
      expect(await unchanged.json()).toEqual(originalLocationRead)
    }

    // Unique per run. A constant would pass on a value a previous run had left
    // on the row, which is the exact failure this read-back exists to catch.
    // Entered with spaces, stored as E.164: the one form every phone is kept in.
    const lineNumber = String(Date.now() % 10000).padStart(4, '0')
    const updatedPhone = `+1 202 555 ${lineNumber}`
    const nationalOnly = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'update_location',
      args: { organization_id: organizationId, location_id: locationId, phone: '081 234 5678' },
    })
    expect(nationalOnly.status()).toBe(200)
    const refused = (await nationalOnly.json()).result
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toMatch(/phone must be an international number with its country calling code/)
    const afterRefusal = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_location',
      args: { organization_id: organizationId, location_id: locationId },
    })
    expect(afterRefusal.status()).toBe(200)
    expect(mcpData<{ location: { phone: string | null } }>(await afterRefusal.json()).location.phone)
      .toBe(originalLocation.phone)
    const renamedLocationTitle = `${originalLocation.title} ${Date.now()}`
    const locationUpdate = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'update_location',
      args: { organization_id: organizationId, location_id: locationId, phone: updatedPhone, title: renamedLocationTitle },
    })
    expect(locationUpdate.status()).toBe(200)
    // A 200 is the tool answering, not the row changing. updateTenantPage
    // carried `canonical_url = ? = ?` for weeks: the batch aborted on a binding
    // count and the route still replied 200, because nothing read the write back
    // through a different path than the one that made it.
    const locationAfter = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'get_location',
      args: { organization_id: organizationId, location_id: locationId },
    })
    expect(locationAfter.status()).toBe(200)
    expect(mcpData<{ location: { phone: string } }>(await locationAfter.json()).location)
      .toMatchObject({ phone: `+1202555${lineNumber}`, title: renamedLocationTitle, slug: originalLocation.slug })
    const independentlyReadLocation = await request.get(locationApiPath)
    expect(independentlyReadLocation.status()).toBe(200)
    expect((await independentlyReadLocation.json()).location).toMatchObject({ title: renamedLocationTitle, slug: originalLocation.slug, phone: `+1202555${lineNumber}` })
    const restoredTitle = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'update_location', args: { organization_id: organizationId, location_id: locationId, title: originalLocation.title },
    })
    expect(restoredTitle.status()).toBe(200)
    expect(mcpData<{ ok: boolean }>(await restoredTitle.json()).ok).toBe(true)
    const locationAfterRestore = await request.get(locationApiPath)
    expect(locationAfterRestore.status()).toBe(200)
    expect((await locationAfterRestore.json()).location).toMatchObject({ title: originalLocation.title, slug: originalLocation.slug, phone: `+1202555${lineNumber}` })

    const reviewsList = await mcpRequest(request, baseURL!, {
      method: 'tools/call',
      toolName: 'list_location_reviews',
      args: { organization_id: organizationId, location_id: locationId },
    })
    expect(reviewsList.status()).toBe(200)

    const qaList = await mcpRequest(request, baseURL!, {
      method: 'tools/call', toolName: 'list_location_qa',
      args: { organization_id: organizationId, location_id: locationId },
    })
    expect(qaList.status()).toBe(200)
    expect(mcpData<{ items: unknown[] }>(await qaList.json()).items).toEqual(expect.any(Array))
  })

  test('authored Q&A shares scoped CMS and MCP writers while reviews remain read-only', async ({ page, browser, request, baseURL }, testInfo) => {
    await loginAs(request, baseURL!)
    const organizationId = MCP_ORGANIZATION_ID
    for (const [toolName, key] of [['list_organization_qa', 'items'], ['list_organization_reviews', 'reviews']]) {
      const response = await mcpRequest(request, baseURL!, {
        method: 'tools/call', toolName, args: { organization_id: organizationId },
      })
      expect(response.status()).toBe(200)
      expect(mcpData<Record<string, unknown[]>>(await response.json())[key!]).toEqual(expect.any(Array))
    }
    const catalog = await mcpRequest(request, baseURL!, { method: 'tools/list', organizationId })
    const tools = (await catalog.json()).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>
    const reviewTools = tools.filter(tool => /(?:_review|_reviews)$/.test(tool.name))
    expect(reviewTools.map(tool => tool.name).sort()).toEqual(['list_location_reviews', 'list_organization_reviews'])
    expect(reviewTools.every(tool => tool.annotations.readOnlyHint)).toBe(true)
    for (const name of ['create_qa', 'update_qa', 'delete_qa', 'reorder_qa']) expect(tools.find(tool => tool.name === name)?.annotations.readOnlyHint).toBe(false)
    // #1001 gave a site the ability to edit the Q&A it wrote, so the CMS does
    // have a Q&A write route — it validates its body like any other, and a 404
    // here would mean that feature had been lost. A review is a guest's words,
    // so no route creates or edits one; the dashboard only moderates its status
    // (PATCH .../reviews/:id).
    const qaWrite = await request.post(`${baseURL}/api/editor/organizations/${organizationId}/qa`, { data: {} })
    expect(qaWrite.status(), await qaWrite.text()).toBe(400)
    const reviewWrite = await request.post(`${baseURL}/api/editor/organizations/${organizationId}/reviews`, { data: {} })
    expect([404, 405]).toContain(reviewWrite.status())

    const qaOrganizationId = 'org-ncls-blawby'
    const qaUrl = `${baseURL}/api/editor/organizations/${qaOrganizationId}/qa`
    const pagePath = '/pricing'
    const question = `Page-scoped CMS question ${crypto.randomUUID()}`
    const answer = 'This published answer belongs only to the pricing page.'
    const publicPage = await browser.newPage()
    const release = await acquireTenantMutationLock(testInfo, qaOrganizationId)
    let createdId: string | undefined
    const localeUrl = `${baseURL}/api/editor/organizations/${qaOrganizationId}/locales`
    const translationLocale = 'th'
    let originalLanguages: Array<{ locale: string; status: string; is_source: number }> | undefined
    try {
      const before = await openTenantPage(publicPage, `${blawbyBaseURL}${pagePath}`, blawbyExtraHeaders)
      expect(before?.status()).toBe(200)
      expect(before?.headers()['cache-control']).toBe('private, no-store, max-age=0')
      expect(before?.headers()['x-edge-cache']).toBeUndefined()
      await expect(publicPage.getByText(question, { exact: true })).toHaveCount(0)
      await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
      const organizationRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_organization', args: { organization_id: qaOrganizationId } })
      expect(organizationRead.status()).toBe(200)
      const slug = mcpData<{ context: { organization_slug: string } }>(await organizationRead.json()).context.organization_slug
      expect(slug).toBeTruthy()
      await page.setViewportSize({ width: 900, height: 800 })
      await openTenantPage(page, `${baseURL}/dashboard/${encodeURIComponent(slug)}/website/qa`, {})
      await page.getByRole('combobox', { name: 'Q&A page scope', exact: true }).click()
      await page.getByRole('option', { name: 'Pricing', exact: true }).click()
      await page.getByRole('button', { name: 'Add a question', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname.includes('/qa/new') && url.searchParams.get('page_path') === pagePath)
      // A question being made opens on its one required step; the answer is the record's once it exists.
      await expect(page).toHaveURL(url => url.pathname.endsWith('/qa/new/question') && url.searchParams.get('page_path') === pagePath)
      await expect(page.locator('#dashboard-panel-organization-qa-record h1')).toHaveText('New question')
      await page.getByRole('textbox', { name: /^Question/ }).fill(question)
      const [created] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === new URL(qaUrl).pathname),
        page.getByRole('button', { name: 'Create question', exact: true }).last().click(),
      ])
      expect(created.status(), await created.text()).toBe(201)
      createdId = (await created.json()).id
      expect(createdId).toBeTruthy()
      await expect(page).toHaveURL(url => url.pathname === `/dashboard/${encodeURIComponent(slug)}/website/qa/${createdId}` && url.searchParams.get('page_path') === pagePath)
      await expect(page.getByRole('link', { name: 'Status Published', exact: true })).toBeVisible()
      await page.getByRole('link', { name: /^Answer / }).click()
      await expect(page).toHaveURL(url => url.pathname.endsWith(`/qa/${createdId}/answer`) && url.searchParams.get('page_path') === pagePath)
      await page.getByRole('textbox', { name: 'Answer', exact: true }).fill(answer)
      const [answered] = await Promise.all([
        page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `${new URL(qaUrl).pathname}/${createdId}`),
        page.locator('#dashboard-panel-organization-qa-answer').getByRole('button', { name: 'Save', exact: true }).click(),
      ])
      expect(answered.status(), await answered.text()).toBe(200)
      await expect(page).toHaveURL(url => url.pathname === `/dashboard/${encodeURIComponent(slug)}/website/qa/${createdId}` && url.searchParams.get('page_path') === pagePath)
      await page.getByTestId('dashboard-navbar-back').filter({ visible: true }).click()
      await expect(page).toHaveURL(url => url.pathname === `/dashboard/${encodeURIComponent(slug)}/website/qa` && url.searchParams.get('page_path') === pagePath)
      await expect(page.getByRole('combobox', { name: 'Q&A page scope', exact: true })).toBeVisible()
      await expect(page.getByRole('combobox', { name: 'Q&A page scope', exact: true })).toHaveText('Pricing')
      const readback = await page.request.get(qaUrl, { params: { id: createdId! } })
      expect(readback.status()).toBe(200)
      expect((await readback.json()).qa).toEqual([expect.objectContaining({ id: createdId, organization_id: qaOrganizationId, location_id: null, page_path: pagePath, question, answer, status: 'published', source: 'manual' })])
      const scoped = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'list_organization_qa', args: { organization_id: qaOrganizationId, page_path: pagePath, limit: 100 } })
      expect(scoped.status()).toBe(200)
      expect(mcpData<{ items: Array<{ id: string; page_path: string }> }>(await scoped.json()).items).toContainEqual(expect.objectContaining({ id: createdId, page_path: pagePath, question, answer }))
      const general = await page.request.get(qaUrl)
      expect(general.status()).toBe(200)
      expect((await general.json()).qa.map((row: { id: string }) => row.id)).not.toContain(createdId)
      await page.setViewportSize({ width: 1024, height: 800 })
      const freshRecord = await openTenantPage(page, `${baseURL}/dashboard/${encodeURIComponent(slug)}/website/qa/${createdId}?page_path=${encodeURIComponent(pagePath)}`, {})
      expect(freshRecord?.status()).toBe(200)
      await expect(page).toHaveURL(url => url.pathname === `/dashboard/${encodeURIComponent(slug)}/website/qa/${createdId}/question` && url.searchParams.get('page_path') === pagePath)
      await expect(page.getByRole('heading', { name: question, exact: true })).toBeVisible()
      await expect(page.getByRole('textbox', { name: /^Question/ })).toBeVisible()
      await expect(page.getByRole('textbox', { name: /^Question/ })).toHaveValue(question)
      await expect(page.getByTestId('dashboard-navbar-close')).not.toBeVisible()
      const published = await publicPage.reload()
      expect(published?.status()).toBe(200)
      expect(published?.headers()['cache-control']).toBe('private, no-store, max-age=0')
      expect(published?.headers()['x-edge-cache']).toBeUndefined()
      const publishedQuestion = publicPage.locator('[data-parity-section="qa"] details').filter({ hasText: question })
      await expect(publishedQuestion.locator('summary')).toHaveText(question)
      await expect(publishedQuestion.locator('summary')).toBeVisible()
      await publishedQuestion.locator('summary').click()
      await expect(publishedQuestion.getByText(answer, { exact: true })).toBeVisible()

      const languages = await page.request.get(localeUrl)
      expect(languages.status()).toBe(200)
      originalLanguages = (await languages.json()).languages
      expect(originalLanguages).not.toContainEqual(expect.objectContaining({ locale: translationLocale }))
      const addedLanguage = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'add_organization_language', args: { organization_id: qaOrganizationId, locale: translationLocale } })
      expect(addedLanguage.status()).toBe(200)
      mcpData(await addedLanguage.json())
      const languageReadback = await page.request.get(localeUrl)
      expect(languageReadback.status()).toBe(200)
      expect((await languageReadback.json()).languages).toContainEqual(expect.objectContaining({ locale: translationLocale, status: 'disabled', is_source: 0 }))
      const localizationPath = `/api/editor/organizations/${qaOrganizationId}/localization/content_document/${createdId}/${translationLocale}`
      // The second open reads the first authored translation back before it is
      // revised. Q&A's canonical writer accepts a question and answer, without SEO.
      for (const [index, translated] of [
        { title: 'คำถามภาษาไทยเกี่ยวกับราคา', summary: 'คำตอบภาษาไทยสำหรับหน้าราคา' },
        { title: 'คำถามภาษาไทยเกี่ยวกับราคาที่แก้ไข', summary: 'คำตอบภาษาไทยที่แก้ไขสำหรับหน้าราคา' },
      ].entries()) {
        await page.getByTestId('localize-resource').click()
        await page.getByTestId('localize-language').click()
        const [loadedTranslation] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname === localizationPath),
          page.getByRole('option', { name: /ไทย \(th\)/ }).click(),
        ])
        expect(loadedTranslation.status()).toBe(index === 0 ? 404 : 200)
        if (index === 1) expect((await loadedTranslation.json()).localization).toMatchObject({ kind: 'qa', title: 'คำถามภาษาไทยเกี่ยวกับราคา', summary: 'คำตอบภาษาไทยสำหรับหน้าราคา', seo_keywords: null })
        await page.getByTestId('localize-field-title').fill(translated.title)
        await page.getByTestId('localize-field-summary').fill(translated.summary)
        const [savedTranslation] = await Promise.all([
          page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === localizationPath),
          page.getByTestId('localize-save').click(),
        ])
        expect(savedTranslation.status(), await savedTranslation.text()).toBe(200)
        await expect(page.getByTestId('localize-language')).toHaveCount(0)
        const translatedReadback = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_resource_localization', args: { organization_id: qaOrganizationId, resource_type: 'content_document', resource_id: createdId, locale: translationLocale } })
        expect(translatedReadback.status()).toBe(200)
        expect(mcpData<{ localization: { kind: string; title: string; summary: string } }>(await translatedReadback.json()).localization).toMatchObject({ kind: 'qa', ...translated })
      }
    } finally {
      try {
        if (createdId) {
          const readback = await page.request.get(qaUrl, { params: { id: createdId } })
          expect(readback.status()).toBe(200)
          const row = (await readback.json()).qa[0] as { page_path: string | null }
          const deleted = await page.request.delete(`${qaUrl}/${createdId}`, { params: row.page_path === null ? undefined : { page_path: row.page_path } })
          expect(deleted.status(), await deleted.text()).toBe(200)
          const after = await page.request.get(qaUrl, { params: { id: createdId } })
          expect(after.status()).toBe(200)
          expect((await after.json()).qa).toEqual([])
        }
      } finally {
        try {
          if (originalLanguages && !originalLanguages.some(language => language.locale === translationLocale)) {
            const languages = await page.request.get(localeUrl)
            expect(languages.status()).toBe(200)
            if ((await languages.json()).languages.some((language: { locale: string }) => language.locale === translationLocale)) {
              const removedLanguage = await page.request.delete(`${localeUrl}/${translationLocale}`)
              expect(removedLanguage.status(), await removedLanguage.text()).toBe(200)
            }
            const restoredLanguages = await page.request.get(localeUrl)
            expect(restoredLanguages.status()).toBe(200)
            expect((await restoredLanguages.json()).languages).toEqual(originalLanguages)
          }
        } finally {
          await Promise.all([publicPage.close(), release()])
        }
      }
    }
  })

  test.describe('owner management workflows', () => {
    // The large-batch spec asserts the demo tenant's whole catalogue under this
    // lock, so every test that adds a Product to it takes the same lock.
    let releaseTenantMutationLock: (() => Promise<void>) | undefined
    let bookedSessionRestore: {
      cleanupRequest: APIRequestContext
      page: Page
      baseURL: string
      organizationId: string
      productId: string | null
      locationId: string
    } | null = null
    test.beforeEach(async ({ request: _request }, testInfo) => {
      releaseTenantMutationLock = await acquireTenantMutationLock(testInfo, MCP_ORGANIZATION_ID)
    })
    test.afterEach(async ({ request: _request }, testInfo) => {
      const release = releaseTenantMutationLock
      releaseTenantMutationLock = undefined
      const restore = bookedSessionRestore
      bookedSessionRestore = null
      const failures: unknown[] = []
      if (restore) {
        try {
          if (testInfo.status !== 'passed' && !restore.page.isClosed()) await restore.page.close()
        } catch (error) { failures.push(error) }
        if (restore.productId) {
          // Preserve booking history while withdrawing the test-owned schedule
          // and listing, even when the test request fixture has timed out.
          const productId = restore.productId
          for (const [toolName, args] of [
            ['replace_product_weekly_schedule', { product_id: productId, location_id: restore.locationId, slots: [] }],
            ['set_product_location', { product_id: productId, location_id: restore.locationId, active: false, published: false }],
            ['set_product_publication', { product_id: productId, published: false }],
          ] as const) {
            try {
              const response = await mcpRequest(restore.cleanupRequest, restore.baseURL, { method: 'tools/call', toolName, args: { organization_id: restore.organizationId, ...args } })
              expect(response.status(), await response.text()).toBe(200)
              mcpData(await response.json())
            } catch (error) { failures.push(error) }
          }
          const url = `/api/editor/organizations/${restore.organizationId}/products/${productId}`
          try {
            const rules = await restore.cleanupRequest.get(`${url}/availability`, { params: { location_id: restore.locationId } })
            expect(rules.status(), await rules.text()).toBe(200)
            expect((await rules.json()).rules).toEqual([])
          } catch (error) { failures.push(error) }
          try {
            const response = await mcpRequest(restore.cleanupRequest, restore.baseURL, { method: 'tools/call', toolName: 'get_product', args: { organization_id: restore.organizationId, product_id: productId } })
            expect(response.status(), await response.text()).toBe(200)
            const retained = mcpData<{ product: Product }>(await response.json()).product
            expect(retained.locations.find(location => location.location_id === restore.locationId)).toMatchObject({ active: false, published: false })
          } catch (error) { failures.push(error) }
          try {
            const response = await restore.cleanupRequest.get(url)
            expect(response.status(), await response.text()).toBe(200)
            const retained = (await response.json() as { product: Product }).product
            expect(retained.locations.find(location => location.location_id === restore.locationId)).toMatchObject({ active: false, published: false })
            expect(retained.publications).toEqual([{ organization_id: restore.organizationId, published: false }])
          } catch (error) { failures.push(error) }
        }
        try {
          await restore.cleanupRequest.dispose()
        } catch (error) { failures.push(error) }
      }
      try {
        await release?.()
      } catch (error) { failures.push(error) }
      if (failures.length) throw new AggregateError(failures, 'Booked-session authority cleanup failed')
    })

    test('HTTP and MCP share booking defaults, weekly replacement and authored Q&A', async ({ request, baseURL }) => {
      await loginAs(request, baseURL!)
      const organizationId = MCP_ORGANIZATION_ID
      const locationId = 'loc-demo'
      const call = async (toolName: string, args: Record<string, unknown>) => {
        const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args: { organization_id: organizationId, ...args } })
        expect(response.status()).toBe(200)
        return await response.json()
      }
      const created = mcpData<{ product: { id: string } }>(await call('create_product', { kind: 'service', active: true, idempotency_key: crypto.randomUUID(), name: 'Shared writer parity' })).product
      const productId = created.id
      const productUrl = `${baseURL}/api/editor/organizations/${organizationId}/products/${productId}`
      const qaUrl = `${baseURL}/api/editor/organizations/${organizationId}/qa`
      const qaIds: string[] = []
      try {
        const enabled = await request.put(`${productUrl}/booking`, { data: { duration_minutes: 60, default_capacity: 9 } })
        expect(enabled.status(), await enabled.text()).toBe(200)
        let product = mcpData<{ product: { booking: unknown } }>(await call('get_product', { product_id: productId })).product
        expect(product.booking).toEqual({ duration_minutes: 60, default_capacity: 9, confirmation_mode: 'instant', online_payment_required: false, held_online: false, scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: null })
        expect((await call('set_product_booking_config', { product_id: productId, default_capacity: 0 })).result.isError).not.toBe(true)
        const httpProduct = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products`)
        expect(httpProduct.status(), await httpProduct.text()).toBe(200)
        expect((await httpProduct.json()).products.find((row: { id: string }) => row.id === productId).booking).toEqual({ duration_minutes: 60, default_capacity: 0, confirmation_mode: 'instant', online_payment_required: false, held_online: false, scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: null })
        expect((await call('set_product_booking_config', { product_id: productId, default_capacity: null })).result.isError).not.toBe(true)
        product = mcpData<{ product: { booking: unknown } }>(await call('get_product', { product_id: productId })).product
        expect(product.booking).toEqual({ duration_minutes: 60, default_capacity: null, confirmation_mode: 'instant', online_payment_required: false, held_online: false, scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: null })
        expect((await request.put(`${productUrl}/booking`, { data: { duration_minutes: 0 } })).status()).toBe(400)
        expect((await call('set_product_booking_config', { product_id: productId, duration_minutes: 0 })).result.isError).toBe(true)
        const schedule = { location_id: locationId, slots: [{ weekday: 2, start_time: '10:00' }] }
        const savedSchedule = await request.put(`${productUrl}/availability`, { data: schedule })
        expect(savedSchedule.status(), await savedSchedule.text()).toBe(200)
        const httpRules = await request.get(`${productUrl}/availability?location_id=${locationId}`)
        expect(httpRules.status(), await httpRules.text()).toBe(200)
        expect((await httpRules.json()).rules).toEqual([expect.objectContaining({
          product_id: productId, location_id: locationId, weekday: 2, start_time: '10:00',
        })])
        const repeated = mcpData<{ rules: Array<{ id: string; timezone: string }>; sessions: { created: number } }>(await call('replace_product_weekly_schedule', { product_id: productId, ...schedule }))
        expect(repeated.sessions.created).toBe(0)
        const rules = await request.get(`${productUrl}/availability?location_id=${locationId}`)
        expect((await rules.json()).rules).toEqual(repeated.rules)
        expect(repeated.rules[0]).not.toHaveProperty('capacity')
        const retiredSlots = { ...schedule, slots: [{ weekday: 2, start_time: '10:00', capacity: 0 }] }
        expect((await request.put(`${productUrl}/availability`, { data: retiredSlots })).status()).toBe(400)
        expect((await call('replace_product_weekly_schedule', { product_id: productId, ...retiredSlots })).result.isError).toBe(true)
        const foreign = { product_id: productId, location_id: 'loc-ncls-main', slots: [] }
        expect((await call('replace_product_weekly_schedule', foreign)).result.isError).toBe(true)
        expect((await request.put(`${productUrl}/availability`, { data: { location_id: foreign.location_id, slots: foreign.slots } })).status()).toBe(404)
        expect(mcpData<{ rules: unknown[] }>(await call('replace_product_weekly_schedule', { product_id: productId, location_id: locationId, slots: [] })).rules).toEqual([])
        expect((await (await request.get(`${productUrl}/availability?location_id=${locationId}`)).json()).rules).toEqual([])

        const policy = { confirmation_mode: 'review', online_payment_required: false }
        // Default local/CI does not configure Payments billing providers.
        const paymentRequiredPolicy = { ...policy, online_payment_required: true }
        const httpPaymentPolicy = await request.put(`${productUrl}/booking`, { data: paymentRequiredPolicy })
        expect(httpPaymentPolicy.status(), await httpPaymentPolicy.text()).toBe(503)
        const paymentPolicyError = (await httpPaymentPolicy.json()).data
        expect(paymentPolicyError.code).toBe('financial_action_required')
        expect(paymentPolicyError.missing).toContain('payments.configuration')
        expect(mcpData<{ product: { booking: unknown } }>(await call('get_product', { product_id: productId })).product.booking).toEqual(product.booking)
        expect((await call('set_product_booking_config', { product_id: productId, ...policy })).result.isError).not.toBe(true)
        const policyRead = await request.get(productUrl)
        expect(policyRead.status()).toBe(200)
        expect((await policyRead.json()).product.booking).toEqual({ duration_minutes: 60, default_capacity: null, ...policy, held_online: false, scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: null })
        // Weekly times belong to a location. Online, the provider's hours are the schedule, so neither surface takes online weekly times.
        const online = { location_id: null, slots: [{ weekday: 3, start_time: '11:30' }] }
        expect((await call('replace_product_weekly_schedule', { product_id: productId, ...online })).result.isError).toBe(true)
        expect((await request.put(`${productUrl}/availability`, { data: online })).status()).toBe(400)
        // Held online needs someone to hold it.
        expect((await request.put(`${productUrl}/booking`, { data: { held_online: true } })).status()).toBe(400)
        const updatedPolicy = await request.put(`${productUrl}/booking`, { data: { confirmation_mode: 'instant', online_payment_required: false } })
        expect(updatedPolicy.status()).toBe(200)
        expect(mcpData<{ product: { booking: unknown } }>(await call('get_product', { product_id: productId })).product.booking).toEqual({ duration_minutes: 60, default_capacity: null, confirmation_mode: 'instant', online_payment_required: false, held_online: false, scheduling_mode: 'legacy', assigned_member_id: null, assigned_team_id: null })

        const viaHttp = await request.post(qaUrl, { data: { question: '  Shared HTTP question  ', answer: 'HTTP answer', page_path: '/parity-check' } })
        expect(viaHttp.status(), await viaHttp.text()).toBe(201)
        const first = await viaHttp.json() as { id: string }
        qaIds.push(first.id)
        const viaMcp = mcpData<{ id: string }>(await call('create_qa', { question: 'Shared MCP question', page_path: '/parity-check' }))
        qaIds.push(viaMcp.id)
        expect((await call('update_qa', { qa_id: first.id, page_path: '/parity-check', answer: 'MCP answer', is_owner_answer: false })).result.isError).not.toBe(true)
        const read = await request.get(`${qaUrl}?page_path=%2Fparity-check`)
        const qa = (await read.json()).qa as Array<{ id: string; question: string; answer: string; is_owner_answer: number }>
        expect(qa.find(row => row.id === first.id)).toMatchObject({ question: 'Shared HTTP question', answer: 'MCP answer', is_owner_answer: 0 })
        expect((await request.patch(`${qaUrl}/${viaMcp.id}`, { data: { page_path: '/parity-check', answer: 'CMS answer' } })).status()).toBe(200)
        const list = mcpData<{ items: Array<{ id: string; answer: string }> }>(await call('list_organization_qa', { page_path: '/parity-check' }))
        expect(list.items.find(row => row.id === viaMcp.id)?.answer).toBe('CMS answer')
        const updates = [{ id: first.id, sort_order: 6 }, { id: viaMcp.id, sort_order: 2 }]
        expect(mcpData<{ updated: number }>(await call('reorder_qa', { page_path: '/parity-check', updates })).updated).toBe(2)
        expect((await (await request.get(`${qaUrl}?page_path=%2Fparity-check`)).json()).qa.map((row: { id: string }) => row.id)).toEqual([viaMcp.id, first.id])
        expect((await request.post(qaUrl, { data: { question: 'Invalid scope', page_path: 42 } })).status()).toBe(400)
        for (const scope of [{ page_path: 42 }, { location_id: 42 }]) {
          expect((await call('create_qa', { question: 'Invalid scope', ...scope })).result.isError).toBe(true)
        }
        const invalid = { question: 'q'.repeat(501), page_path: '/parity-check' }
        expect((await request.post(qaUrl, { data: invalid })).status()).toBe(400)
        expect((await call('create_qa', invalid)).result.isError).toBe(true)
        expect((await call('update_qa', { qa_id: first.id, page_path: '/different-scope', answer: 'Wrong scope' })).result.isError).toBe(true)
        expect((await request.patch(`${qaUrl}/${first.id}`, { data: { page_path: '/different-scope', answer: 'Wrong scope' } })).status()).toBe(404)
        expect((await call('delete_qa', { qa_id: first.id, page_path: '/parity-check' })).result.isError).not.toBe(true)
        qaIds.splice(qaIds.indexOf(first.id), 1)
        expect((await (await request.get(`${qaUrl}?page_path=%2Fparity-check`)).json()).qa.map((row: { id: string }) => row.id)).toEqual([viaMcp.id])
      } finally {
        for (const id of qaIds) {
          const deleted = await request.delete(`${qaUrl}/${id}?page_path=%2Fparity-check`)
          expect(deleted.status(), await deleted.text()).toBe(200)
        }
        expect(mcpData<{ deleted: boolean }>(await call('delete_product_booking_config', { product_id: productId })).deleted).toBe(true)
        expect(mcpData<{ deleted: boolean }>(await call('delete_product', { product_id: productId })).deleted).toBe(true)
        expect((await call('get_product', { product_id: productId })).result.isError).toBe(true)
      }
    })

    test('booked session authority survives CMS clear and MCP re-add', async ({ request, page, baseURL }, testInfo) => {
      await loginAs(request, baseURL!)
      const organizationId = MCP_ORGANIZATION_ID
      const call = async (toolName: string, args: Record<string, unknown>) => {
        const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args: { organization_id: organizationId, ...args } })
        expect(response.status()).toBe(200)
        const body = await response.json()
        expect(body.result.isError, JSON.stringify(body)).not.toBe(true)
        return body
      }
      const { settings } = mcpData<{ settings: { default_currency: string } }>(await call('get_organization_settings', {}))
      const { location } = mcpData<{ location: { id: string; title: string; timezone: string } }>(await call('get_location', { location_id: 'loc-demo' }))
      expect(location.id).toBe('loc-demo')
      expect(location.timezone).toBe('America/New_York')
      const cleanupRequest = await playwrightRequest.newContext({ baseURL })
      const restore = { cleanupRequest, page, baseURL: baseURL!, organizationId, productId: null as string | null, locationId: location.id }
      bookedSessionRestore = restore
      await loginAs(cleanupRequest, baseURL!)
      const created = mcpData<{ product: { id: string; slug: string } }>(await call('create_product', { kind: 'service', active: true, idempotency_key: crypto.randomUUID(),
        name: 'Family Estate Planning Consultation', variants: [{ name: 'Consultation', prices: [{ unit_amount: 1000, currency: settings.default_currency }] }],
      })).product
      restore.productId = created.id
      const url = `${baseURL}/api/editor/organizations/${organizationId}/products/${created.id}`
      const slots = [{ weekday: 0, start_time: '14:00' }]
      await call('set_product_publication', { product_id: created.id, published: true })
      await call('set_product_location', { product_id: created.id, location_id: 'loc-demo', active: true, published: true })
      await call('set_product_booking_config', { product_id: created.id, duration_minutes: 120, default_capacity: 10 })
      await call('replace_product_weekly_schedule', { product_id: created.id, location_id: 'loc-demo', slots })
      await loginAs(page.request, baseURL!)
      // The location's schedule is the one Product editor's Booking, scoped to that location.
      await page.goto(`${baseURL}/dashboard/ember-slice-demo/products/${created.id}/booking?location_id=loc-demo`)
      await waitForNuxtHydration(page)
      await expect(page.getByRole('link', { name: 'Duration 120 minutes', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Client limit Up to 10 clients per consultation', exact: true })).toBeVisible()
      const scheduleConcern = page.locator('#dashboard-panel-product-booking').getByTestId('editor-row-schedule')
      await expect(scheduleConcern).toHaveAccessibleName(`Weekly schedule ${location.title} · Sunday`)
      await expect(scheduleConcern).toHaveAttribute('href', `/dashboard/ember-slice-demo/products/${created.id}/booking/schedule?location_id=loc-demo`)
      await scheduleConcern.click()
      const sunday = page.locator('#dashboard-panel-booking-schedule').getByTestId('editor-row-sunday')
      await expect(sunday).toHaveAccessibleName('Sunday 2:00 PM')
      await sunday.click()
      await expect(page.getByLabel('Start time 1', { exact: true })).toHaveValue('14:00')
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
      const read = async () => {
        const response = await request.get(`${url}/sessions`)
        expect(response.status(), await response.text()).toBe(200)
        return (await response.json()).sessions as Array<{ id: string; location_id: string | null; source_occurrence_key: string; timezone: string; starts_at: string; ends_at: string; capacity: number; status: string; claimed: number; remaining: number }>
      }
      const target = (await read()).find(row => row.location_id === 'loc-demo' && row.starts_at > new Date().toISOString())
      expect(target).toBeTruthy()
      const booked = await request.post(`${baseURL}/api/public/products/${created.slug}/book`, {
        headers: tenantTestExtraHeaders(),
        data: { session_id: target!.id, guest_name: 'Estate Planning Client', guest_email: `session-authority-${Date.now()}@example.test`, party_size: 6, idempotency_key: crypto.randomUUID() },
      })
      expect(booked.status(), await booked.text()).toBe(201)
      const before = (await read()).find(row => row.id === target!.id)!
      expect(before).toMatchObject({ capacity: 10, claimed: 6, remaining: 4 })
      await page.getByRole('button', { name: 'Remove start time 1', exact: true }).click()
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByRole('link', { name: 'Sunday No consultations', exact: true })).toBeVisible()
      const cleared = await request.get(`${url}/availability?location_id=loc-demo`)
      expect(cleared.status()).toBe(200)
      expect((await cleared.json()).rules).toEqual([])
      await call('set_product_booking_config', { product_id: created.id, duration_minutes: 30, default_capacity: 2 })
      await call('replace_product_weekly_schedule', { product_id: created.id, location_id: 'loc-demo', slots })
      const after = (await read()).find(row => row.id === target!.id)!
      for (const field of ['id', 'source_occurrence_key', 'timezone', 'starts_at', 'ends_at', 'capacity', 'status', 'claimed', 'remaining'] as const) expect(after[field]).toEqual(before[field])
      const publicRead = await request.get(`${baseURL}/api/public/products/${created.slug}/sessions`, { headers: tenantTestExtraHeaders() })
      expect(publicRead.status(), await publicRead.text()).toBe(200)
      expect((await publicRead.json()).sessions.find((row: { id: string }) => row.id === target!.id)).toMatchObject({ remaining: 4, is_full: false, starts_at: target!.starts_at, ends_at: target!.ends_at, timezone: target!.timezone })

      const sessionsBeforeDraft = await read()
      const createRequests: string[] = []
      const updateRequests: string[] = []
      page.on('request', entry => {
        if (new URL(entry.url()).pathname === new URL(`${url}/sessions`).pathname && entry.method() === 'POST') createRequests.push(entry.url())
        if (new URL(entry.url()).pathname.startsWith(`${new URL(`${url}/sessions`).pathname}/`) && entry.method() === 'PATCH') updateRequests.push(entry.url())
      })
      const calendarPath = '/dashboard/ember-slice-demo/calendar'
      const gapDate = '2027-03-14'
      expect((await page.goto(`${calendarPath}/sessions/new?product_id=${created.id}&month=${gapDate.slice(0, 7)}&date=${gapDate}`))?.status()).toBe(200)
      await waitForNuxtHydration(page)
      const draft = page.locator('#dashboard-panel-product-session')
      const date = draft.getByLabel('Date', { exact: true })
      const starts = draft.getByLabel('Starts', { exact: true })
      const ends = draft.getByLabel('Ends', { exact: true })
      const add = draft.getByRole('button', { name: 'Add to calendar', exact: true })
      const locationChoice = draft.getByRole('combobox', { name: 'Office*', exact: true })
      await expect(draft.getByRole('spinbutton', { name: 'Client limit', exact: true })).toHaveValue('2')
      await locationChoice.click()
      await expect(page.getByRole('listbox')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(draft.getByText('Choose an office.', { exact: true })).toBeVisible()
      await expect(locationChoice).toHaveAccessibleDescription('Choose an office.')
      await expect(date).toHaveValue(gapDate)
      await expect(starts).toBeDisabled()
      await expect(ends).toBeDisabled()
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])
      await locationChoice.click()
      await page.getByRole('option', { name: location.title, exact: true }).click()
      await expect(draft).toContainText(`Times are in ${location.timezone}.`)
      await expect(date).toHaveValue(gapDate)
      await date.fill('')
      await date.press('Tab')
      await expect(draft.getByText('Choose a date.', { exact: true })).toBeVisible()
      await expect(date).toHaveAccessibleDescription('Choose a date.')
      await expect(locationChoice).toContainText(location.title)
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])
      await date.fill(gapDate)
      await starts.focus()
      await ends.focus()
      await expect(draft.getByText('Choose a start time.', { exact: true })).toBeVisible()
      await expect(starts).toHaveAccessibleDescription('Choose a start time.')
      await expect(date).toHaveValue(gapDate)
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])
      await starts.fill('02:30')
      const startGap = `This time does not exist because the clocks move forward. Choose another start time in ${location.timezone}.`
      await expect(draft.getByText(startGap, { exact: true })).toBeVisible()
      await expect(starts).toHaveAccessibleDescription(startGap)
      await expect(starts).toHaveValue('02:30')
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])
      await page.screenshot({ path: testInfo.outputPath('experience-validation-desktop.jpg') })

      await starts.fill('03:30')
      await expect(ends).toHaveValue(`${gapDate}T04:00`)
      await ends.fill('')
      await ends.press('Tab')
      await expect(draft.getByText('Choose an end date and time.', { exact: true })).toBeVisible()
      await expect(ends).toHaveAccessibleDescription('Choose an end date and time.')
      await expect(date).toHaveValue(gapDate)
      await expect(starts).toHaveValue('03:30')
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])
      await ends.fill(`${gapDate}T04:30`)
      await expect(draft.getByText(startGap, { exact: true })).toHaveCount(0)
      await expect(add).toBeEnabled()
      await ends.fill(`${gapDate}T02:30`)
      const endGap = `This time does not exist because the clocks move forward. Choose another end time in ${location.timezone}.`
      await expect(draft.getByText(endGap, { exact: true })).toBeVisible()
      await expect(ends).toHaveAccessibleDescription(endGap)
      await expect(draft.getByLabel('Date', { exact: true })).toHaveValue(gapDate)
      await expect(starts).toHaveValue('03:30')
      await expect(ends).toHaveValue(`${gapDate}T02:30`)
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])

      await ends.fill(`${gapDate}T03:00`)
      const orderingError = 'End time must be after the start time.'
      await expect(draft.getByText(orderingError, { exact: true })).toBeVisible()
      await expect(ends).toHaveAccessibleDescription(orderingError)
      await expect(starts).toHaveValue('03:30')
      await expect(ends).toHaveValue(`${gapDate}T03:00`)
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])

      await ends.fill(`${gapDate}T04:30`)
      await expect(draft.getByText(orderingError, { exact: true })).toHaveCount(0)
      await expect(add).toBeEnabled()
      await draft.getByLabel('Date', { exact: true }).fill('2026-11-01')
      await starts.fill('01:30')
      const foldError = `This time occurs twice because the clocks move back. Choose another start time in ${location.timezone}.`
      await expect(draft.getByText(foldError, { exact: true })).toBeVisible()
      await expect(starts).toHaveAccessibleDescription(foldError)
      await expect(starts).toHaveValue('01:30')
      await expect(ends).toHaveValue(`${gapDate}T04:30`)
      await expect(add).toBeDisabled()
      expect(createRequests).toEqual([])
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(draft.getByText(foldError, { exact: true })).toBeVisible()
      await expect(starts).toHaveAccessibleDescription(foldError)
      await expect(draft.getByText(foldError, { exact: true })).toBeInViewport({ ratio: 1 })
      await page.screenshot({ path: testInfo.outputPath('experience-validation-phone.jpg') })
      await draft.getByLabel('Date', { exact: true }).fill(gapDate)
      await starts.fill('03:30')
      await expect(draft.getByText(foldError, { exact: true })).toHaveCount(0)
      await expect(ends).toHaveValue(`${gapDate}T04:30`)
      await expect(add).toBeEnabled()
      await draft.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === calendarPath && url.searchParams.get('product_id') === created.id)
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ product_id: created.id, locationId: location.id, month: gapDate.slice(0, 7), date: gapDate })
      expect(createRequests).toEqual([])
      const sessionsAfterDraft = await read()
      expect(sessionsAfterDraft.map(session => session.id)).toEqual(sessionsBeforeDraft.map(session => session.id))
      expect(sessionsAfterDraft.find(session => session.id === target!.id)).toEqual(after)

      const unclaimed = sessionsBeforeDraft.find(session => session.id !== target!.id && session.status === 'scheduled' && session.claimed === 0)
      expect(unclaimed, 'the real weekly schedule has another unclaimed occurrence to edit').toBeDefined()
      const unclaimedStart = localNow(unclaimed!.timezone, new Date(unclaimed!.starts_at))
      const unclaimedEnd = localNow(unclaimed!.timezone, new Date(unclaimed!.ends_at))
      expect((await page.goto(`${calendarPath}/sessions/${unclaimed!.id}?product_id=${created.id}&locationId=${location.id}&month=${unclaimedStart.date.slice(0, 7)}&date=${unclaimedStart.date}`))?.status()).toBe(200)
      await waitForNuxtHydration(page)
      const save = draft.getByRole('button', { name: 'Save', exact: true })
      await expect(save).toBeDisabled()
      await starts.fill('')
      await starts.press('Tab')
      await expect(draft.getByText('Choose a start date and time.', { exact: true })).toBeVisible()
      await expect(starts).toHaveAccessibleDescription('Choose a start date and time.')
      await expect(ends).toHaveValue(`${unclaimedEnd.date}T${unclaimedEnd.time}`)
      await expect(save).toBeDisabled()
      await starts.press('Enter')
      await expect(starts).toHaveValue('')
      await expect(ends).toHaveValue(`${unclaimedEnd.date}T${unclaimedEnd.time}`)
      expect(updateRequests).toEqual([])
      await starts.fill(`${unclaimedStart.date}T${unclaimedStart.time}`)
      await expect(draft.getByText('Choose a start date and time.', { exact: true })).toHaveCount(0)
      await expect(save).toBeEnabled()
      await draft.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(page).toHaveURL(url => url.pathname === calendarPath && url.searchParams.get('product_id') === created.id)
      expect(createRequests).toEqual([])
      expect(updateRequests).toEqual([])
      const sessionsAfterEdit = await read()
      expect(sessionsAfterEdit.map(session => session.id)).toEqual(sessionsBeforeDraft.map(session => session.id))
      expect(sessionsAfterEdit.find(session => session.id === unclaimed!.id)).toEqual(unclaimed)
      expect(sessionsAfterEdit.find(session => session.id === target!.id)).toEqual(after)
    })

    test('MCP finishes the public menu and creates a separately bookable experience', async ({ request, page, baseURL }) => {
      await loginAs(request, baseURL!)
      const organizationId = MCP_ORGANIZATION_ID
      const locationId = 'loc-demo'
      const call = async <T>(toolName: string, args: Record<string, unknown> = {}) => {
        const response = await mcpRequest(request, baseURL!, { method: 'tools/call', toolName, args: { organization_id: organizationId, ...args } })
        expect(response.status(), await response.text()).toBe(200)
        return mcpData<T>(await response.json())
      }
      const original = await call<{ collections: Array<{ id: string }> }>('list_collections', { location_id: locationId })
      const settings = await call<{ settings: { default_currency: string } }>('get_organization_settings')
      const stamp = crypto.randomUUID()
      const item = (name: string, amount: number) => ({ name: `${name} ${stamp}`, variants: [{ name: 'Standard', prices: [{ unit_amount: amount, currency: settings.settings.default_currency }] }] })
      const args = { location_id: locationId, idempotency_key: stamp, sections: [
        { name: `Starters ${stamp}`, items: [item('Edamame', 500), item('Gyoza', 800)] },
        { name: `Desserts ${stamp}`, items: [item('Matcha cake', 900)] },
      ] }
      type Menu = { sections: Array<{ collection: { id: string; name: string }; products: Array<{ id: string; name: string }> }>; replayed: boolean }
      let menu: Menu | null = null
      let experienceId: string | null = null
      let host: Awaited<ReturnType<typeof publishOwnHostProfile>> | null = null
      try {
        menu = await call<Menu>('update_menu', args)
        const written = menu.sections.filter(section => section.collection.name.endsWith(stamp))
        expect(written.map(section => section.collection.name)).toEqual(args.sections.map(section => section.name))
        expect(written.map(section => section.products.map(product => product.name))).toEqual(args.sections.map(section => section.items.map(product => product.name)))
        const replay = await call<Menu>('update_menu', args)
        expect(replay.replayed).toBe(true)
        expect(replay.sections).toEqual(menu.sections)
        await page.setExtraHTTPHeaders(tenantTestExtraHeaders())
        expect((await page.goto(`${baseURL}/menu`))?.status()).toBe(200)
        for (const section of args.sections) {
          await expect(page.getByRole('heading', { name: section.name, exact: true })).toBeVisible()
          for (const product of section.items) await expect(page.getByText(product.name, { exact: true }).first()).toBeVisible()
        }
        // Moving a supplied dish changes its section; omitted dishes remain.
        const starter = written[0]!
        const dessert = written[1]!
        const movedDish = starter.products[0]!
        await call<Menu>('update_menu', { location_id: locationId, idempotency_key: crypto.randomUUID(), sections: [
          { collection_id: dessert.collection.id, name: dessert.collection.name, items: [{ product_id: movedDish.id, name: movedDish.name }] },
        ] })
        for (const [product, collectionId, sortOrder] of [
          [starter.products[1]!, starter.collection.id, 1],
          [dessert.products[0]!, dessert.collection.id, 0],
          [movedDish, dessert.collection.id, 1],
        ] as const) {
          const membership = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${product.id}`)
          expect(membership.status(), await membership.text()).toBe(200)
          expect((await membership.json()).product.collections).toEqual([{ collection_id: collectionId, sort_order: sortOrder }])
        }
        await page.reload()
        await expect(page.getByText(movedDish.name, { exact: true })).toHaveCount(1)
        const { location } = await call<{ location: { timezone: string; opening_hours: OpeningHours; special_hours: SpecialHours } }>('get_location', { location_id: locationId })
        let seating: { date: string; time: string } | undefined
        const today = localDateAt(new Date(), location.timezone)
        for (let offset = 28; offset < 35 && !seating; offset++) {
          const date = addLocalDays(today, offset)
          const time = generateReservationTimes(location.opening_hours, date, { lastSeatingBufferMinutes: 60, specialHours: location.special_hours })[0]
          if (time) seating = { date, time }
        }
        expect(seating, 'the existing location has an open one-hour seating within the chosen week').toBeTruthy()
        const start = localDateTimeToInstant(seating!.date, seating!.time, location.timezone)
        const name = `Omakase ${stamp}`
        // Setting up bookings publishes the experience, and guests see who hosts it.
        host = await publishOwnHostProfile(request, baseURL!, organizationId, 'Omakase host')
        const creation = { kind: 'experience', name, idempotency_key: crypto.randomUUID(), variants: [{ name: 'Per person', prices: [{ unit_amount: 13000, currency: settings.settings.default_currency }] }],
          booking: { location_id: locationId, duration_minutes: 60, default_capacity: 6, confirmation_mode: 'review', online_payment_required: false, assigned_member_id: host.memberId,
            sessions: [{ starts_at: start.toISOString(), ends_at: new Date(start.getTime() + 3600000).toISOString(), capacity: 6 }] } }
        const { product } = await call<{ product: { id: string; slug: string; public_url: string; booking_readiness: { ready: boolean; missing: string[] } } }>('create_product', creation)
        experienceId = product.id
        expect(product.booking_readiness).toEqual({ ready: true, missing: [] })
        expect((await call<{product:{id:string}}>('create_product', creation)).product.id).toBe(product.id)
        const readback = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${product.id}`)
        expect(readback.status()).toBe(200)
        expect((await readback.json()).product).toMatchObject({ kind: 'experience', booking: { duration_minutes: 60, confirmation_mode: 'review', assigned_member_id: host.memberId }, locations: [{ location_id: locationId, active: true, published: true }] })
        await page.reload()
        await expect(page.getByText(name, {exact:true})).toHaveCount(0)
        expect((await page.goto(`${baseURL}/experiences`))?.status()).toBe(200)
        await expect(page.getByText(name,{exact:true}).first()).toBeVisible()
        expect((await page.goto(`${baseURL}${new URL(product.public_url).pathname}`))?.status()).toBe(200)
        await expect(page.getByRole('heading',{name,exact:true}).first()).toBeVisible()
        await expect(page.locator('section[aria-label="Meet your host"]').getByText('Omakase host', { exact: true })).toBeVisible()
        const sessions = await request.get(`${baseURL}/api/public/products/${product.slug}/sessions`, {headers: tenantTestExtraHeaders()})
        expect(sessions.status(),await sessions.text()).toBe(200)
        expect((await sessions.json()).sessions).toEqual([expect.objectContaining({starts_at:start.toISOString(),remaining:6,is_full:false})])
        let additionalSeating: { date: string; time: string } | undefined
        for (let offset = 1; offset <= 7 && !additionalSeating; offset++) {
          const date = addLocalDays(seating!.date, offset)
          const time = generateReservationTimes(location.opening_hours, date, { lastSeatingBufferMinutes: 60, specialHours: location.special_hours })[0]
          if (time) additionalSeating = { date, time }
        }
        expect(additionalSeating, 'the existing location has another open one-hour time on a later date').toBeDefined()
        const additionalStart = localDateTimeToInstant(additionalSeating!.date, additionalSeating!.time, location.timezone)
        const additionalEnd = new Date(additionalStart.getTime() + 60 * 60_000)
        const additionalEndLocal = localNow(location.timezone, additionalEnd)
        await loginAs(page.request, baseURL!)
        await page.setExtraHTTPHeaders({})
        const bookingPath = `/dashboard/ember-slice-demo/products/${product.id}/booking`
        const calendarPath = '/dashboard/ember-slice-demo/calendar'
        const sessionEndpoint = `/api/editor/organizations/${organizationId}/products/${product.id}/sessions`
        expect((await page.goto(`${calendarPath}/sessions/new?product_id=${product.id}&locationId=${locationId}&month=${additionalSeating!.date.slice(0, 7)}&date=${additionalSeating!.date}`))?.status()).toBe(200)
        await waitForNuxtHydration(page)
        const availability = page.locator('#dashboard-panel-product-session')
        await expect(availability.getByLabel('Date', { exact: true })).toHaveValue(additionalSeating!.date)
        await expect(availability.getByLabel('Starts', { exact: true })).toHaveValue('')
        await expect(availability.getByRole('spinbutton', { name: 'Guest limit', exact: true })).toHaveValue('6')
        await availability.getByLabel('Starts', { exact: true }).fill(additionalSeating!.time)
        await expect(availability.getByLabel('Ends', { exact: true })).toHaveValue(`${additionalEndLocal.date}T${additionalEndLocal.time}`)
        await availability.getByRole('spinbutton', { name: 'Guest limit', exact: true }).fill('4')
        await availability.getByRole('spinbutton', { name: 'Guest limit', exact: true }).press('Tab')
        let creations = 0
        const countCreation = (request: import('@playwright/test').Request) => {
          if (new URL(request.url()).pathname === sessionEndpoint && request.method() === 'POST') creations++
        }
        page.on('request', countCreation)
        const calendarFailure = 'The newly saved calendar could not be read for this verification.'
        const interceptCalendar = (url: URL) => url.pathname === sessionEndpoint
        await page.route(interceptCalendar, async route => {
          if (route.request().method() !== 'GET') return route.continue()
          // The failed read completes after the saved editor is visible, so
          // a save handler left on a discarded /new instance cannot pass.
          await expect(availability.getByRole('heading', { name: 'Edit availability', exact: true })).toBeVisible()
          await route.fulfill({ status: 503, json: { error: calendarFailure } })
        })
        const added = page.waitForResponse(response => new URL(response.url()).pathname === sessionEndpoint && response.request().method() === 'POST')
        const refusedCalendar = page.waitForResponse(response => interceptCalendar(new URL(response.url())) && response.request().method() === 'GET')
        await availability.getByRole('button', { name: 'Add to calendar', exact: true }).click()
        const addedResponse = await added
        expect(addedResponse.status(), await addedResponse.text()).toBe(201)
        const addedSessions = (await addedResponse.json() as { sessions: SessionAvailability[] }).sessions
        expect(addedSessions).toHaveLength(1)
        const addedId = addedSessions[0]!.id
        expect((await refusedCalendar).status()).toBe(503)
        await expect(page).toHaveURL(url => url.pathname === `${calendarPath}/sessions/${addedId}`)
        await expect(availability.getByRole('heading', { name: 'Edit availability', exact: true })).toBeVisible()
        await expect(availability.getByText(calendarFailure, { exact: true })).toBeVisible()
        await expect(availability.getByRole('spinbutton', { name: 'Guest limit', exact: true })).toHaveValue('4')
        const beforeRetry = await call<{ sessions: SessionAvailability[] }>('list_product_booking_sessions', {
          product_id: product.id, from: additionalStart.toISOString(), to: additionalEnd.toISOString(),
        })
        expect(beforeRetry.sessions).toEqual([expect.objectContaining({ id: addedId, capacity: 4, remaining: 4 })])
        await page.unroute(interceptCalendar)
        await availability.getByRole('spinbutton', { name: 'Guest limit', exact: true }).fill('5')
        await availability.getByRole('spinbutton', { name: 'Guest limit', exact: true }).press('Tab')
        const retried = page.waitForResponse(response => new URL(response.url()).pathname === `${sessionEndpoint}/${addedId}` && response.request().method() === 'PATCH')
        const savedCalendar = page.waitForResponse(response => interceptCalendar(new URL(response.url())) && response.request().method() === 'GET')
        await availability.getByRole('button', { name: 'Save', exact: true }).click()
        const retriedResponse = await retried
        expect(retriedResponse.status(), await retriedResponse.text()).toBe(200)
        expect((await savedCalendar).status()).toBe(200)
        page.off('request', countCreation)
        expect(creations).toBe(1)
        await expect(page).toHaveURL(url => url.pathname === calendarPath && url.searchParams.get('date') === additionalSeating!.date && url.searchParams.get('locationId') === locationId)
        expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ product_id: product.id, locationId, month: additionalSeating!.date.slice(0, 7), date: additionalSeating!.date })
        await expect(page.locator(`#dashboard-panel-org-calendar [data-session-id="${addedId}"]:visible`)).toBeVisible()
        const persisted = await call<{ sessions: SessionAvailability[] }>('list_product_booking_sessions', {
          product_id: product.id,
          from: localDateTimeToInstant(additionalSeating!.date, '00:00', location.timezone).toISOString(),
          to: localDateTimeToInstant(addLocalDays(additionalSeating!.date, 1), '00:00', location.timezone).toISOString(),
        })
        expect(persisted.sessions).toEqual([expect.objectContaining({
          id: addedId, organization_id: organizationId, product_id: product.id, location_id: locationId, timezone: location.timezone,
          starts_at: additionalStart.toISOString(), ends_at: additionalEnd.toISOString(), capacity: 5, status: 'scheduled', claimed: 0, remaining: 5, is_full: false,
        })])
        const publicReadback = await request.get(`${baseURL}/api/public/products/${product.slug}/sessions`, { headers: tenantTestExtraHeaders(), params: { location_id: locationId } })
        expect(publicReadback.status(), await publicReadback.text()).toBe(200)
        const publicSessions = (await publicReadback.json() as { sessions: Array<Pick<SessionAvailability, 'id' | 'starts_at' | 'ends_at' | 'location_id' | 'timezone' | 'remaining' | 'is_full'>> }).sessions
        expect(publicSessions).toHaveLength(2)
        expect(publicSessions.find(session => session.id === addedId)).toMatchObject({
          id: addedId, location_id: locationId, timezone: location.timezone, starts_at: additionalStart.toISOString(), ends_at: additionalEnd.toISOString(), remaining: 5, is_full: false,
        })
        // Online is a public booking scope, not a physical Product location.
        // Removing it from its own focused editor returns to the same Product
        // and rereads saved state without following an invalid online address.
        await call('set_product_publication', { product_id: product.id, published: false })
        await call('set_product_booking_config', { product_id: product.id, held_online: true, scheduling_mode: 'provider' })
        await page.goto(`${bookingPath}/location?location_id=online`)
        const format = page.locator('#dashboard-panel-booking-location')
        await expect(format.getByRole('switch', { name: 'Held online', exact: true })).toHaveAttribute('aria-checked', 'true')
        await format.getByRole('switch', { name: 'Held online', exact: true }).click()
        await format.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page).toHaveURL(`${bookingPath}/duration`)
        const offline = await call<{ product: Product }>('get_product', { product_id: product.id })
        expect(offline.product.booking).toMatchObject({ held_online: false, scheduling_mode: 'provider', assigned_member_id: host.memberId })
        expect(offline.product.locations).toEqual([{ location_id: locationId, active: true, published: true }])
        await call('set_product_booking_config', { product_id: product.id, held_online: true })
        await page.goto(`${bookingPath}/enabled?location_id=online`)
        const calendar = page.locator('#dashboard-panel-booking-enabled')
        await calendar.getByRole('switch', { name: 'Use a booking calendar', exact: true }).click()
        await calendar.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page).toHaveURL(`${bookingPath}/enabled`)
        expect((await call<{ product: Product }>('get_product', { product_id: product.id })).product.booking).toBeNull()
      } finally {
        if (experienceId) {
          expect((await call<{deleted:boolean}>('delete_product',{product_id:experienceId})).deleted).toBe(true)
          const deleted = await request.get(`${baseURL}/api/editor/organizations/${organizationId}/products/${experienceId}`)
          expect(deleted.status(), await deleted.text()).toBe(404)
        }
        for (const section of menu?.sections.filter(section => section.collection.name.endsWith(stamp)) ?? []) {
          for (const product of section.products) expect((await call<{deleted:boolean}>('delete_product',{product_id:product.id})).deleted).toBe(true)
          expect((await call<{deleted:boolean}>('delete_collection',{collection_id:section.collection.id})).deleted).toBe(true)
        }
        if (original.collections.length) await call('reorder_collections',{location_id:locationId,collection_ids:original.collections.map(collection=>collection.id)})
        await host?.restore()
      }
    })
    test('MCP teams and invitation delivery use the same Better Auth records as the dashboard', async ({request,baseURL}) => {
      await loginAs(request,baseURL!)
      const organizationId = MCP_ORGANIZATION_ID
      const call = async <T>(toolName:string,args:Record<string,unknown>={}) => {
        const response = await mcpRequest(request,baseURL!,{method:'tools/call',toolName,args:{organization_id:organizationId,...args}})
        expect(response.status(),await response.text()).toBe(200)
        return mcpData<T>(await response.json())
      }
      const members = await call<{members:Array<{userId:string}>}>('list_organization_members')
      const person = members.members.find(member=>member.userId==='user-e2e-demo-owner')
      expect(person).toBeTruthy()
      let teamId:string|null=null,invitationId:string|null=null
      try {
        const name = `Hosts ${crypto.randomUUID()}`
        teamId = (await call<{team:{id:string}}>('create_team',{name})).team.id
        const membership = await call<{team:OrganizationMembersData['teams'][number]}>('set_team_member',{team_id:teamId,user_id:person!.userId,included:true})
        expect(membership.team.organizationId).toBe(organizationId)
        expect(membership.team.members.map(member=>member.userId)).toContain(person!.userId)
        const nativeTeams = await request.get(`${baseURL}/api/auth/organization/list-teams`,{params:{organizationId}})
        expect(nativeTeams.status(),await nativeTeams.text()).toBe(200)
        expect(await nativeTeams.json()).toContainEqual(expect.objectContaining({id:teamId,name,organizationId}))
        const removed = await call<{team:OrganizationMembersData['teams'][number]}>('set_team_member',{team_id:teamId,user_id:person!.userId,included:false})
        expect(removed.team.members.map(member=>member.userId)).not.toContain(person!.userId)
        const email = `invite-${crypto.randomUUID()}@playwright.example`
        const invited = await call<{invitation:{id:string;status:string;delivery:{status:string}}}>('invite_organization_member',{email,role:'member'})
        invitationId = invited.invitation.id
        expect(invited.invitation).toMatchObject({status:'pending',delivery:{status:'sent'}})
        const nativeInvitations = await request.get(`${baseURL}/api/auth/organization/list-invitations`,{params:{organizationId}})
        expect(nativeInvitations.status(),await nativeInvitations.text()).toBe(200)
        expect(await nativeInvitations.json()).toContainEqual(expect.objectContaining({id:invitationId,email,status:'pending'}))
        const stored = await call<{invitations:Array<{id:string;delivery:{status:string}}>} >('list_organization_members')
        expect(stored.invitations.find(invitation=>invitation.id===invitationId)).toMatchObject({delivery:{status:'sent'}})
      } finally {
        if(invitationId) expect((await call<{invitation:{status:string}}>('cancel_organization_invitation',{invitation_id:invitationId})).invitation.status).toBe('canceled')
        if(teamId) expect((await call<{deleted:boolean}>('delete_team',{team_id:teamId})).deleted).toBe(true)
      }
    })

  })

})
