import type { McpToolDefinition } from './shared'
import { calendarDateSchema, addLocalDays, assertCalendarDate, localNow, timezoneSchema } from '~/utils/timezone'
import { locationListItemObject, locationMutationSummaryObject, locationObject, openingHoursInputSchema, pageInfoObject, paginationInputSchema, postalAddressSchema, seoOverrideFieldsSchema, organizationTool, specialHoursInputSchema } from './shared'
import { HTTPError } from 'nitro'
import type { McpExecutorContext } from './execution'
import { createLocation, getLocation, updateLocation, type CreateLocationInput, type LocationRecord } from '~/server/utils/location-management'
import { AGENDA_KINDS, listAgenda, type AgendaKind } from '~/server/utils/dashboard-agenda'
import { closeDates, closureOnDate, datedHours, getDateIntervals, openDates } from '~/shared/reservation-hours'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { NOT_HANDLED, assertDomainSuccess, mutationContextPayload, omit, optionalString, requiredString, workspaceLocationsPayload } from './execution'

const text = { type: 'string' }
const nullableText = { type: ['string', 'null'] }
const agendaItem = { type: 'object', properties: {
  id: text, kind: { type: 'string', enum: [...AGENDA_KINDS] }, requestId: nullableText,
  operationalBookingId: nullableText, operationalReservationId: nullableText,
  stayId: { ...nullableText, description: 'For a stay row, the stay to read with get_stay; one stay is its arrival and its departure.' },
  stayMoment: { type: ['string', 'null'], enum: ['arrival', 'departure', null] },
  assignedMemberId: nullableText, assignedMemberName: nullableText,
  startsAt: text, endsAt: nullableText, dayKey: text, timeZone: text, showTimeZone: { type: 'boolean' },
  title: text, subtitle: nullableText, status: text, organizationId: text,
  locationId: nullableText, locationTitle: nullableText, guestImageUrl: nullableText,
  resourceImageUrl: nullableText, resourceTitle: nullableText, partySize: { type: ['integer', 'null'] }, to: text,
}, required: ['id', 'kind', 'requestId', 'operationalBookingId', 'operationalReservationId', 'stayId', 'stayMoment', 'startsAt', 'endsAt', 'dayKey', 'timeZone', 'title', 'status', 'organizationId', 'locationId', 'partySize'] }
const calendarMutation = { ...locationMutationSummaryObject, properties: { ...locationMutationSummaryObject.properties, affected_commitments: { type: 'array', items: agendaItem } }, required: [...locationMutationSummaryObject.required, 'affected_commitments'] }

export const LOCATIONS_TOOLS: McpToolDefinition[] = [
  organizationTool({
      name: 'create_location',
      description: 'Add a location to the selected business website. Every plan includes 2 locations; on Growth and Business each additional location is $49 per month, added to the plan by its owner in Billing first, and a location beyond those the plan covers is refused. Repeat the same idempotency key with the same details on retry.',
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: {
        title: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        idempotency_key: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
        address: postalAddressSchema,
        phone: { type: 'string' },
        email: { type: 'string', format: 'email' },
        website_url: { type: 'string', format: 'uri' },
        description: { type: 'string' },
        timezone: timezoneSchema,
        opening_hours: openingHoursInputSchema,
        special_hours: specialHoursInputSchema,
      },
      required: ['title', 'idempotency_key', 'timezone'],
      outputSchema: {
        type: 'object',
        properties: { location: locationObject, context: { type: 'object' } },
        required: ['location', 'context'],
      },
    }),
  organizationTool({
      name: 'list_locations',
      description: 'List the selected site’s locations with their IDs, slugs, titles and active state. Location-scoped tools take these IDs.',
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: { ...paginationInputSchema },
      outputSchema: {
        type: 'object',
        properties: {
          locations: { type: 'array', items: locationListItemObject },
          page_info: pageInfoObject,
        },
        required: ['locations', 'page_info'],
      },
    }),
  organizationTool({
      name: 'get_location',
      description: "Read one selected site location, including its contact details, opening hours, timezone and media. Use its returned ID for location-specific changes.",
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: { location_id: { type: 'string', description: 'Internal location ID returned by list_locations or get_workspace_context.' } },
      required: ['location_id'],
      outputSchema: {
        type: 'object',
        properties: { location: locationObject, current_local_date: { type: 'string', format: 'date', description: 'Current date in the location timezone.' } },
        required: ['location', 'current_local_date'],
      },
    }),
  organizationTool({
      name: 'update_location',
      description: 'Update a location\'s own details: regular opening hours, temporary closures/special hours, and contact info. To change its hero media, call set_media with { owner_type: "business_location", owner_id: <location.id>, slot: "hero" }. Only provided fields are changed. Returns the updated location; website details can change immediately. This does not change reservation capacity or a product’s session schedule.',
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: {
        location_id: { type: 'string', description: 'Internal location ID returned by list_locations or get_workspace_context.' },
        address: postalAddressSchema,
        phone: { type: 'string', description: 'Public phone number shown to guests on the website and in booking/reservation confirmation emails.' },
        email: { type: ['string', 'null'], description: 'Public email shown to guests on the website and in booking/reservation confirmation emails. Pass null to clear it.' },
        timezone: { type: 'string', description: 'IANA time zone identifier for this location, e.g. Asia/Bangkok. Used to interpret opening hours and booking slots.' },
        max_capacity: { type: ['number', 'null'], description: 'Stored location capacity metadata; does not limit reservation availability. Reservation seats per start time are controlled by update_reservation_policy.slot_capacity. Pass null to clear the metadata.' },
        opening_hours: openingHoursInputSchema,
        special_hours: specialHoursInputSchema,
        ...seoOverrideFieldsSchema(),
      },
      required: ['location_id'],
      outputSchema: locationMutationSummaryObject,
    }),
  organizationTool({
      name: 'get_calendar',
      description: "Read the business’s reservations, bookings, consultations, guest arrivals and departures, published posts and unavailable dates when the user wants to review its calendar. Dates are inclusive local calendar days, with at most 62 days per call. Use kinds to filter the agenda.",
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: {
        location_id: { type: ['string', 'null'], description: 'Limit to this location, or null for the whole business including online bookings.' },
        assigned_member_id: { type: 'string' },
        from: { ...calendarDateSchema, description: 'First day, YYYY-MM-DD.' },
        to: { ...calendarDateSchema, description: 'Last day, YYYY-MM-DD, inclusive.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['reservation', 'booking', 'post', 'stay'] }, description: 'Limit to these kinds. Defaults to every kind the location offers. A stay appears on its arrival and its departure day.' },
      },
      required: ['from', 'to'],
      outputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: agendaItem },
          available_kinds: { type: 'array', items: { type: 'string' } },
          unavailable_dates: { type: 'array', items: { type: 'object', properties: { date: text, location_id: text, reason: { type: 'string', enum: ['inactive', 'closure', 'dated_hours', 'regular_hours'] }, note: nullableText }, required: ['date', 'location_id', 'reason'] } },
          context: { type: 'object' },
        },
        required: ['items', 'available_kinds', 'unavailable_dates'],
      },
    }),
  organizationTool({
      name: 'block_dates',
      description: "Close a location for a whole-day date range when the user wants to prevent bookings on those dates. Both endpoints are inclusive. Adds a closure to special hours while retaining existing closures and dated hours. Returns the saved hours; existing bookings and reservations are not cancelled or messaged.",
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: {
        location_id: { type: 'string', description: 'Internal location ID returned by list_locations or get_workspace_context.' },
        from: { ...calendarDateSchema, description: 'First closed day, YYYY-MM-DD.' },
        to: { ...calendarDateSchema, description: 'Last closed day, YYYY-MM-DD, inclusive. Same as from for one day.' },
        note: { type: ['string', 'null'], description: 'Why, for the team; guests never see it.' },
      },
      required: ['location_id', 'from', 'to'],
      outputSchema: calendarMutation,
    }),
  organizationTool({
      name: 'open_dates',
      description: "Remove temporary closures for an inclusive date range when the user wants to reopen a location. Closure dates outside the range and their notes are preserved. Regularly closed weekdays stay closed; change opening_hours with update_location to open those weekdays. Returns the saved hours without creating or changing existing bookings.",
      domain: 'locations',
      minimumRole: 'admin',
      inputSchema: {
        location_id: { type: 'string', description: 'Internal location ID returned by list_locations or get_workspace_context.' },
        from: { ...calendarDateSchema, description: 'First reopened day, YYYY-MM-DD.' },
        to: { ...calendarDateSchema, description: 'Last reopened day, YYYY-MM-DD, inclusive. Same as from for one day.' },
      },
      required: ['location_id', 'from', 'to'],
      outputSchema: calendarMutation,
    }),
]

type LoadedLocation = NonNullable<Awaited<ReturnType<typeof getLocation>>>

async function requireLocation(organization: McpExecutorContext['organization'], locationIdOrSlug: string): Promise<LoadedLocation> {
  const location = await getLocation(organization.db, organization.organizationId, locationIdOrSlug);
  if (!location) throw new HTTPError({ statusCode: 404, statusMessage: `Location "${locationIdOrSlug}" was not found.` });
  return location;
}

export async function handleLocationsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case "create_location": {
      const result = await createLocation(
        organization.env,
        organization.db,
        organization.organizationId,
        omit(args, ['idempotency_key']) as unknown as CreateLocationInput,
        organization.userId,
        { idempotencyKey: requiredString(args, 'idempotency_key') },
      );
      assertDomainSuccess(result);
      const location = (result.data as { location: LocationRecord }).location;
      return {
        location: await requireLocation(organization, location.id),
        context: await mutationContextPayload(organization, { locationId: location.id }),
      };
    }
    case "list_locations": {
      const workspace = await resolveMcpWorkspace(
        organization.db,
        organization.env,
        organization.userId,
        { organizationId: organization.organizationId },
      );
      const page = paginateMcpCollection(workspaceLocationsPayload(workspace), args, { resource: `locations:${organization.organizationId}` });
      return {
        context: workspaceContextPayload(workspace.organization, workspace.location),
        locations: page.items,
        page_info: page.page_info,
      };
    }
    case "get_location":
      {
        const locationId = requiredString(args, "location_id");
        const location = await requireLocation(organization, locationId);
        return {
          location,
          current_local_date: localNow(location.timezone).date,
          context: await mutationContextPayload(organization, { locationId }),
        };
      }
    case "update_location": {
      const locationId = requiredString(args, "location_id");
      const updateFields = omit(args, ["location_id"]) as Record<string, unknown>;
      const result = await updateLocation(
        organization.db,
        organization.organizationId,
        locationId,
        updateFields as never,
        organization.userId,
        organization.env,
      );
      assertDomainSuccess(result);
      const updatedLocation = (result.data as { location: LocationRecord }).location;
      const updateContext = await mutationContextPayload(organization, { locationId });
      return renderStructuredResponse(
        {
          ok: true,
          entity: "location",
          id: updatedLocation.id,
          slug: updatedLocation.slug,
          changed_fields: Object.keys(omit(args, ["location_id"])),
          updated_at: updatedLocation.updated_at,
          context: updateContext,
        },
        `Updated "${updatedLocation.title}".`,
        { ...result.data, context: updateContext },
      );
    }
    // The calendar's read, as the dashboard draws it: the agenda for the days,
    // and which days the location cannot take, from the same hours helpers.
    case "get_calendar": {
      const locationId = optionalString(args, "location_id");
      const location = locationId ? await requireLocation(organization, locationId) : null;
      const from = requiredString(args, "from");
      const to = requiredString(args, "to");
      assertCalendarDate(from);
      assertCalendarDate(to);
      if (to < from) throw new Error("to must not be before from");
      const days: string[] = [];
      for (let day = from; day <= to; day = addLocalDays(day, 1)) {
        days.push(day);
        if (days.length > 62) throw new Error("get_calendar covers at most 62 days per call");
      }
      const requested = Array.isArray(args.kinds)
        ? args.kinds.filter((kind): kind is AgendaKind => AGENDA_KINDS.includes(kind as AgendaKind))
        : undefined;
      const agenda = await listAgenda(organization.db, { organizationId: organization.organizationId }, {
        from, to, locationId: location?.id, assignedMemberId: optionalString(args, "assigned_member_id") ?? undefined, kinds: requested, organizationSlug: organization.organizationSlug,
        principal: { env: organization.env, membership: organization.membership },
      });
      const locations = location ? [location] : await Promise.all(agenda.locations.map(row => requireLocation(organization, row.id)))
      const unavailable = locations.flatMap(location => days.flatMap((date) => {
        const identity = { date, location_id: location.id }
        if (location.status !== 'active') return [{ ...identity, reason: 'inactive' }]
        const closure = closureOnDate(location.special_hours, date)
        if (closure) return [{ ...identity, reason: 'closure', note: closure.note ?? null }]
        const dated = datedHours(location.special_hours, date)
        if (dated?.kind === 'hours' && !dated.periods.length) return [{ ...identity, reason: 'dated_hours', note: dated.note ?? null }]
        const intervals = getDateIntervals(location.opening_hours, location.special_hours, date)
        return intervals !== null && !intervals.length ? [{ ...identity, reason: 'regular_hours' }] : []
      }))
      return {
        items: agenda.items,
        available_kinds: agenda.availableKinds,
        unavailable_dates: unavailable,
        context: await mutationContextPayload(organization, location ? { locationId: location.id } : undefined),
      };
    }
    // Block and Open are the calendar's two writes, through the one helpers
    // the calendar uses, onto the one field the hours leaf edits.
    case "block_dates":
    case "open_dates": {
      const locationIdOrSlug = requiredString(args, "location_id");
      const from = requiredString(args, "from");
      const to = requiredString(args, "to");
      const note = toolName === "block_dates" ? optionalString(args, "note") ?? null : null;
      // The write names the row it read. If the location moved in between,
      // the row is read again and the range applied to what is there now —
      // once; a second refusal is reported.
      let result: Awaited<ReturnType<typeof updateLocation>> | null = null;
      let location = await requireLocation(organization, locationIdOrSlug);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const special = toolName === "block_dates"
          ? closeDates(location.special_hours, from, to)
          : openDates(location.special_hours, from, to);
        const withNote = note && special ? special.map((entry, index) => index === special.length - 1 && entry.kind === "closure" ? { ...entry, note } : entry) : special;
        result = await updateLocation(
          organization.db,
          organization.organizationId,
          location.id,
          { special_hours: withNote, expected_updated_at: location.updated_at } as never,
          organization.userId,
          organization.env,
        );
        if (result.status !== 409) break;
        location = await requireLocation(organization, location.id);
      }
      assertDomainSuccess(result!);
      const updated = (result!.data as { location: LocationRecord }).location;
      const context = await mutationContextPayload(organization, { locationId: location.id });
      const span = from === to ? from : `${from} to ${to}`;
      return renderStructuredResponse(
        {
          ok: true,
          entity: "location",
          id: updated.id,
          slug: updated.slug,
          changed_fields: ["special_hours"],
          updated_at: updated.updated_at,
          affected_commitments: toolName === 'block_dates' ? (await listAgenda(organization.db, { organizationId: organization.organizationId }, { from, to, locationId: location.id, kinds: ['booking', 'reservation'], organizationSlug: organization.organizationSlug, principal: { env: organization.env, membership: organization.membership } })).items.filter(item => item.status === 'pending' || item.status === 'confirmed') : [],
          context,
        },
        toolName === "block_dates" ? `Blocked ${span} at "${updated.title}".` : `Opened ${span} at "${updated.title}".`,
        { ...result!.data, context },
      );
    }
    default:
      return NOT_HANDLED
  }
}
