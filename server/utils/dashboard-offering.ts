import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { getDashboardMemberContext, listDashboardLocations } from '~/server/utils/dashboard-context'
import { assertProductAccess, isOrganizationWideRole, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { getProduct, hydrateProductMedia, listCollectionProducts, listCollections, setCollectionProducts, setProductLocation, setProductPublication, updateProduct } from '~/server/utils/product-management'
import { createSession, deleteProductBookingConfig, getScheduleSession, listAvailabilityRules, listScheduleSessions, replaceWeeklySchedule, setProductBookingConfig, updateSession } from '~/server/utils/availability'
import { attachMediaPlacement, removeMediaPlacement, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import { PRODUCT_KIND_LABELS, productDetailFields, type ProductDetailsPatch } from '~/shared/product-details'
import { formatMinorAmount, minorAmountToMajor, scopedPriceAmountPatch, selectPrice } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import type { CatalogAnswer, CatalogField, CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { UpdateProductInput } from '~/server/types/products'
import { getVerticalCopy } from '~/utils/vertical-copy'

const invalid = (message: string): never => { throw new HTTPError({ statusCode: 422, message }) }
const missing = (message: string): never => { throw new HTTPError({ statusCode: 404, message }) }
const field = (key: string, label: string, kind: CatalogField['kind'], value: unknown, options: Partial<CatalogField> = {}): CatalogField =>
  ({ key, label, kind, value: value == null ? '' : String(value), ...options })

export async function dashboardOffering(event: H3Event, answer?: CatalogAnswer): Promise<CatalogScreen> {
  const { db, env, organization, userId } = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(organization, { env, event })
  const query = getQuery(event)
  const productId = typeof query.product_id === 'string' && query.product_id ? query.product_id : missing('Choose an offering')
  await assertProductAccess(db, { ...principal, productId })
  const [product] = await hydrateProductMedia(db, organization.id, [await getProduct(db, organization.id, productId)])
  if (!product || product.kind === 'stay') return missing('Offering not found')
  const manages = await roleAllows({ ...principal, permissions: { products: ['update'] } })
  const wide = isOrganizationWideRole(organization.role)
  const currency = organization.default_currency
  if (!isCurrencyCode(currency)) throw new Error('Unsupported organization currency')
  const target = { organizationId: organization.id, productId }
  const actor = { actorId: userId }
  const locationId = typeof query.location_id === 'string' ? query.location_id : undefined
  const placeId = typeof query.place_id === 'string' ? query.place_id : undefined
  const [locations, collections] = await Promise.all([
    listDashboardLocations(db, organization.id, manages ? undefined : userId, true),
    listCollections(db, { organizationId: organization.id, assignedUserId: manages ? undefined : userId }),
  ])
  const location = locationId ? locations.find(place => place.id === locationId && product.locations.some(binding => binding.location_id === place.id)) ?? missing('Offering not found at this location') : null
  const place = placeId ? locations.find(entry => entry.id === placeId) ?? missing('Location not found') : null
  const service = product.kind === 'service'
  const dish = product.kind === 'dish'
  const experience = product.kind === 'experience'
  const booking = product.booking
  const copy = getVerticalCopy(service ? 'service' : experience ? 'experience' : organization.vertical)
  const published = product.publications.some(row => row.organization_id === organization.id && row.published)
  const description = dish ? 'Description' : service ? 'Short description' : 'What you’ll do'
  const placeLabel = service ? 'Offices' : experience ? 'Venues' : 'Locations'
  const bookingLabel = service ? 'Consultations' : experience ? 'Bookings' : 'Scheduling'
  const priceLabel = location ? `Price at ${location.title}` : service ? 'Consultation pricing' : 'Price'
  const title = dish ? 'Dish editor' : service ? 'Legal Services editor' : experience ? 'Experience editor' : 'Table editor'
  const web = `/dashboard/${encodeURIComponent(organization.slug)}/products/${encodeURIComponent(productId)}`
  const webQuery = location ? `?location_id=${encodeURIComponent(location.id)}&kind=dish` : ''
  const params = { product_id: productId, ...(locationId ? { location_id: locationId } : {}) }
  const leaf = (id: string, label: string, summary?: string, options: { view?: string; web?: string; query?: Record<string, string>; readonly?: boolean } = {}): CatalogRow => ({
    id, label, summary, ...(options.readonly ? {} : {
      native: options.view ?? id, query: { ...params, ...options.query },
      to: `${web}/${options.web ?? id}${webQuery}`,
    }),
  })
  const patch = async (changes: UpdateProductInput) => {
    await assertProductAccess(db, { ...principal, productId, patch: changes as Record<string, unknown> })
    await updateProduct(db, { ...target, patch: { updated_at: product.updated_at, ...changes }, actor, env })
  }
  const setBooking = async (changes: Parameters<typeof setProductBookingConfig>[1]['patch']) => {
    await assertProductAccess(db, { ...principal, productId, patch: changes as Record<string, unknown> })
    await setProductBookingConfig(db, { ...target, patch: changes, actorId: userId, env })
    await purgePublicResourceCacheNow(env, organization.id)
  }
  const view = typeof query.view === 'string' ? query.view : ''
  let screen: CatalogScreen = { title, rows: [], fields: [] }
  let save: ((value: (key: string) => string) => Promise<void>) | undefined
  let revision = product.updated_at
  const form = (label: string, fields: CatalogField[], submit: NonNullable<typeof save>) => {
    screen = { title: label, fields, rows: [], save_label: 'Save' }
    save = submit
  }
  const detail = (key: string) => product.details[key as keyof typeof product.details]
  const text = (value: unknown) => Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : ''
  const bool = (value: string) => value === 'true' ? true : value === 'false' ? false : invalid('Choose On or Off')
  const count = (value: string) => value === '' ? null : /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : invalid('Enter a whole number')
  const selection = { currency, location_id: location?.id ?? null }
  const chosenPrice = (variant: typeof product.variants[number]) => selectPrice(variant.prices, selection)
  const bookingChoices = [{ value: 'instant', label: 'Confirm automatically' }, { value: 'review', label: 'Review each request' }]
  const memberList = () => memberSchedulingList({ env, userId, organizationId: organization.id })
  const locationsUsed = locations.filter(entry => product.locations.some(binding => binding.location_id === entry.id))

  if (!view) {
    const prices = product.variants.map(variant => {
      const price = chosenPrice(variant)
      const amount = price ? formatMinorAmount(price.unit_amount, currency) : text(detail('pricing_note')) || 'No price set'
      return product.variants.length === 1 ? amount : `${variant.name}: ${amount}`
    }).join('\n')
    const photo = leaf('photo', 'Media', product.gallery.length || product.image ? 'View media' : 'Add media', { readonly: !wide })
    photo.image = mediaStillUrl(product.image)
    const definitions = productDetailFields(product.kind).filter(definition => !['pricing_note', 'tagline'].includes(definition.key))
    const assigned = booking?.assigned_member_id ? (await memberList()).members.find(member => member.id === booking.assigned_member_id)?.name : null
    screen.rows = [
      ...(wide && !service ? [photo] : []),
      leaf('name', 'Name', product.name),
      leaf('description', description, product.description || 'Nothing written yet'),
      ...(service ? [{ id: 'page', label: 'Page content', summary: product.page?.title ?? 'No page', ...(wide ? { to: product.page ? `/dashboard/${organization.slug}/website/pages/${product.page.id}` : `${web}/page` } : {}) }] : []),
      leaf('price', priceLabel, prices),
      ...(!dish && (booking || manages) ? [
        ...(booking ? [leaf('assignment', copy.assigneeLabel, assigned ?? 'Unassigned', { web: 'booking/assignment', readonly: !manages })] : []),
        leaf('booking', bookingLabel, booking ? `${booking.duration_minutes} minutes` : 'No booking calendar'),
      ] : []),
      ...definitions.map(definition => leaf(definition.key, definition.name, text(detail(definition.key)) || undefined, { view: 'attribute', web: `attributes/${definition.id}`, query: { field: definition.key } })),
      ...(wide && service ? [photo] : []),
      ...(wide ? [leaf('collections', dish ? 'Menu sections' : 'Collections', collections.filter(section => product.collections.some(row => row.collection_id === section.id)).map(section => section.name).join(', '))] : []),
      leaf('locations', placeLabel, [...locationsUsed.map(entry => entry.title), ...(booking?.held_online ? ['Online'] : [])].join(', ')),
      { ...leaf('publication', 'Website visibility', published ? 'Published' : 'Hidden'), status: published ? 'success' : 'neutral' },
      leaf('order-url', dish ? 'Ordering link' : service ? 'External consultation link' : 'External booking link', product.order_url ?? undefined),
      ...(manages ? [{ id: 'kind', label: 'Type', summary: PRODUCT_KIND_LABELS[product.kind], to: `${web}/kind${webQuery}` }] : []),
    ]
  } else if (view === 'name' || view === 'description' || view === 'order-url') {
    if (view === 'name') form('Name', [field('name', 'Name', 'text', product.name)], async values => patch({ name: values('name') }))
    if (view === 'description') form(description, [
      field('description', description, 'textarea', product.description), field('tagline', 'Short introduction', 'text', detail('tagline'), { optional: true }),
    ], async values => patch({ description: values('description'), details_mode: 'merge', details: { tagline: values('tagline') || null } }))
    if (view === 'order-url') form('External link', [field('url', 'URL', 'text', product.order_url, { optional: true })], async values => patch({ order_url: values('url') || null }))
  } else if (view === 'attribute') {
    const definition = productDetailFields(product.kind).find(row => row.key === query.field) ?? missing('Detail not found')
    const current = detail(definition.key)
    const toggle = definition.value_type === 'boolean'
    form(definition.name, [field('value', definition.name, toggle ? 'toggle' : 'textarea', toggle ? current === true : text(current), { optional: true })], async values => {
      const value = toggle ? bool(values('value')) : !values('value').trim() ? null : definition.value_type === 'list.single_line_text' ? values('value').split('\n').map(line => line.trim()).filter(Boolean) : values('value')
      await patch({ details_mode: 'merge', details: { [definition.key]: value } as ProductDetailsPatch })
    })
  } else if (view === 'price' || view === 'amount') {
    const priceText = (variant: typeof product.variants[number]) => {
      const price = chosenPrice(variant)
      return price ? formatMinorAmount(price.unit_amount, currency) : 'No price set'
    }
    if (view === 'price') {
      screen = { title: priceLabel, fields: [], rows: product.variants.map(variant => leaf(variant.id, product.variants.length === 1 ? 'Amount' : variant.name, priceText(variant), { view: 'amount', query: { variant_id: variant.id } })) }
    } else {
      const variant = product.variants.find(row => row.id === query.variant_id) ?? missing('Price not found')
      const displayed = chosenPrice(variant)
      const amount = displayed ? minorAmountToMajor(displayed.unit_amount, currency) : ''
      const fields = [field('amount', `Amount (${currency})`, 'money', amount, { optional: true })]
      if (product.variants.length === 1) fields.push(field('pricing_note', 'Price wording', 'text', detail('pricing_note'), { optional: true }))
      form(priceLabel, fields, async values => {
        const prices = scopedPriceAmountPatch(variant.prices, selection, values('amount').trim(), amount)
        const changes = prices.length ? { variants: [{ id: variant.id, prices }] } : {}
        await patch(product.variants.length === 1 ? { ...changes, details_mode: 'merge', details: { pricing_note: values('pricing_note') || null } } : changes)
      })
    }
  } else if (view === 'publication') {
    screen = { title: 'Website visibility', fields: [], rows: [
      ...(wide ? [leaf('visibility', 'Show on website', published ? 'Published' : 'Hidden', { web: 'publication/visibility' })] : []),
      ...(!service || booking ? [leaf('availability', 'Availability', product.active ? 'Available' : 'Paused', { web: 'publication/availability' })] : []),
    ] }
  } else if (view === 'visibility' && wide) {
    form('Website visibility', [field('published', 'Show on website', 'toggle', published)], async values => {
      await setProductPublication(db, { ...target, published: bool(values('published')), actor, env })
    })
  } else if (view === 'availability' && (!service || booking)) {
    form('Availability', [
      field('active', dish ? 'Accept orders' : service ? 'Accept consultation requests' : 'Accept bookings', 'toggle', product.active),
    ], async values => patch({ active: bool(values('active')) }))
  } else if (view === 'locations' || view === 'location') {
    if (view === 'locations') screen = { title: placeLabel, fields: [], rows: locations.map(entry => leaf(entry.id, entry.title, product.locations.some(row => row.location_id === entry.id) ? 'Offered here' : 'Not offered here', { view: 'location', query: { place_id: entry.id } })) }
    else {
      if (!place) return missing('Choose a location')
      const binding = product.locations.find(row => row.location_id === place.id)
      form(place.title, [field('active', 'Available here', 'toggle', binding?.active ?? false), field('published', 'Show here', 'toggle', binding?.published ?? false)], async values => {
        const { assertLocationAccess } = await import('~/server/utils/member-access')
        await assertLocationAccess(db, { ...principal, locationId: place.id })
        await setProductLocation(db, { ...target, actor, env, locationId: place.id, active: bool(values('active')), published: bool(values('published')) })
      })
    }
  } else if (view === 'photo' || view === 'cover' || view === 'gallery') {
    if (!wide) return missing('Media not found')
    if (view === 'photo') screen = { title: 'Media', fields: [], rows: [
      { ...leaf('cover', 'Cover photo'), image: mediaStillUrl(product.image) },
      ...product.gallery.map(asset => ({ ...leaf(asset.asset_id, 'Gallery item', undefined, { view: 'gallery', query: { asset_id: asset.asset_id } }), image: mediaStillUrl(asset) })),
      leaf('gallery', 'Add to gallery'),
    ] }
    else {
      const asset = query.asset_id ? product.gallery.find(row => row.asset_id === query.asset_id) ?? missing('Media not found') : null
      const current = view === 'cover' ? product.image : asset
      const placement = { owner_type: 'product' as const, owner_id: productId, slot: view === 'cover' ? 'image' as const : 'gallery' as const }
      form(view === 'cover' ? 'Cover photo' : 'Gallery', [field('asset', 'Photo', 'photo', current?.asset_id, { optional: true, display_url: mediaStillUrl(current) })], async values => {
        if (view === 'cover') await setSingleMediaPlacement(db, { env, organizationId: organization.id, principal, placement, assetId: values('asset') || null })
        else if (!values('asset') && asset) await removeMediaPlacement(db, { env, organizationId: organization.id, principal, placement, assetId: asset.asset_id })
        else if (!asset && values('asset')) await attachMediaPlacement(db, { env, organizationId: organization.id, principal, placement, assetId: values('asset') })
        else if (asset && values('asset') !== asset.asset_id) invalid('Add a new gallery item before removing the old one')
      })
    }
  } else if (view === 'collections' || view === 'collection') {
    if (!wide) return missing('Section not found')
    if (view === 'collections') screen = { title: dish ? 'Menu sections' : 'Collections', fields: [], rows: collections.filter(section => !dish || !location || section.location_id === null || section.location_id === location.id).map(section => leaf(section.id, section.name, product.collections.some(row => row.collection_id === section.id) ? 'Included' : undefined, { view: 'collection', query: { section_id: section.id } })) }
    else {
      const section = collections.find(entry => entry.id === query.section_id) ?? missing('Section not found')
      const expected = (await listCollectionProducts(db, { organizationId: organization.id, collectionId: section.id })).map(row => row.id)
      revision = JSON.stringify(expected)
      form(section.name, [field('included', 'Include in this section', 'toggle', expected.includes(productId))], async values => {
        const included = bool(values('included'))
        if (included === expected.includes(productId)) return
        await setCollectionProducts(db, { organizationId: organization.id, collectionId: section.id, expectedProductIds: expected, productIds: included ? [...expected, productId] : expected.filter(id => id !== productId), actor })
      })
    }
  } else if (view === 'booking') {
    screen = { title: bookingLabel, fields: [], rows: booking ? [
      ...(product.kind === 'table'
        ? [{ id: 'seatings', label: 'Seatings', summary: `${booking.duration_minutes} minutes`, to: `${web}/booking/seatings${webQuery}` }]
        : [leaf('duration', 'Duration', `${booking.duration_minutes} minutes`, { web: 'booking/duration' })]),
      leaf('capacity', service ? 'Client limit' : 'Guest limit', booking.default_capacity == null ? 'Unlimited' : String(booking.default_capacity), { web: 'booking/capacity' }),
      leaf('confirmation', 'Confirmation', bookingChoices.find(choice => choice.value === booking.confirmation_mode)?.label, { web: 'booking/confirmation' }),
      ...(manages ? [leaf('assignment', copy.assigneeLabel, undefined, { web: 'booking/assignment' }), leaf('meeting', 'Meeting format', booking.held_online ? 'Online' : 'In person', { web: 'booking/location' }), leaf('enabled', 'Booking calendar', 'Set up', { web: 'booking/enabled' })] : []),
      ...(product.kind === 'table' ? [] : locationsUsed.map(entry => leaf(entry.id, service ? `Availability at ${entry.title}` : `Repeating times at ${entry.title}`, undefined, { view: 'schedule', web: 'booking/schedule', query: { place_id: entry.id } }))),
      ...(experience ? [{ ...leaf('sessions', 'Sessions'), to: `/dashboard/${organization.slug}/calendar?product_id=${productId}` }] : []),
      ...(booking.held_online ? [{ id: 'online', label: 'Online availability', summary: `Uses the ${copy.assigneeNoun}’s working hours` }] : []),
    ] : manages ? [leaf('enabled', service ? 'Set up consultations' : 'Set up bookings', undefined, { web: 'booking/enabled' })] : [] }
  } else if (view === 'duration' || view === 'capacity' || view === 'confirmation' || view === 'meeting') {
    if (!booking) return missing('Booking calendar not found')
    if (view === 'duration') form('Duration', [field('minutes', 'Duration in minutes', 'number', booking.duration_minutes)], async values => setBooking({ duration_minutes: count(values('minutes')) ?? invalid('Enter a duration') }))
    if (view === 'capacity') form('Capacity', [field('capacity', service ? 'Maximum clients' : 'Maximum guests', 'number', booking.default_capacity, { optional: true })], async values => setBooking({ default_capacity: count(values('capacity')) }))
    if (view === 'confirmation') form('Confirmation', [field('mode', 'Confirmation', 'select', booking.confirmation_mode, { choices: bookingChoices })], async values => setBooking({ confirmation_mode: values('mode') as 'instant' | 'review' }))
    if (view === 'meeting') {
      if (!manages) return missing('Meeting format not found')
      form('Meeting format', [field('online', service ? 'Offer online consultations' : 'Offer online booking', 'toggle', booking.held_online)], async values => setBooking({ held_online: bool(values('online')) }))
    }
  } else if (view === 'assignment' || view === 'enabled') {
    if (!manages || (view === 'assignment' && !booking)) return missing('Assignment not found')
    const { members } = await memberList()
    const fields = [field('member', copy.assigneeLabel, 'select', booking?.assigned_member_id, { choices: members.map(member => ({ value: member.id, label: member.name })) })]
    if (!service) fields.push(field('hours', 'Use the host’s working hours', 'toggle', booking?.scheduling_mode === 'provider'))
    if (view === 'enabled' && booking) fields.unshift(field('enabled', 'Use booking calendar', 'toggle', true))
    form(view === 'enabled' ? bookingLabel : copy.assigneeLabel, fields, async values => {
      if (view === 'enabled' && booking && values('enabled') === 'false' && wide) await deleteProductBookingConfig(db, target)
      else await setBooking({ assigned_member_id: values('member'), scheduling_mode: service || values('hours') === 'true' ? 'provider' : 'business' })
    })
  } else if (view === 'schedule') {
    if (!booking || !place || !locationsUsed.some(entry => entry.id === place.id)) return missing('Availability not found')
    const rules = (await listAvailabilityRules(db, organization.id, productId)).filter(row => row.location_id === place.id)
    revision = JSON.stringify(rules)
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    form(`Availability at ${place.title}`, days.map((day, index) => field(String(index), `${day} (HH:MM, one per line)`, 'textarea', rules.filter(row => row.weekday === index).map(row => row.start_time.slice(0, 5)).join('\n'), { optional: true })), async values => {
      await replaceWeeklySchedule(db, { ...target, locationId: place.id, actorId: userId, slots: days.flatMap((_, weekday) => values(String(weekday)).split('\n').map(time => time.trim()).filter(Boolean).map(start_time => ({ weekday, start_time }))) })
    })
  } else if (view === 'sessions' || view === 'session') {
    if (!experience || !booking) return missing('Sessions not found')
    const sessionId = typeof query.session_id === 'string' ? query.session_id : null
    if (view === 'sessions') {
      const from = new Date()
      const sessions = await listScheduleSessions(db, { ...target, env, fromInstant: from.toISOString(), toInstant: new Date(from.getTime() + 90 * 86400000).toISOString() })
      screen = { title: 'Sessions', fields: [], rows: [
        ...(locationsUsed.length ? [leaf('add', 'Add a session', undefined, { view: 'session' })] : []),
        ...sessions.map(session => leaf(session.id, new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: session.timezone }).format(new Date(session.starts_at)), session.status === 'cancelled' ? 'Cancelled' : session.timezone, { view: 'session', query: { session_id: session.id } })),
      ] }
    } else {
      const session = sessionId ? await getScheduleSession(db, env, { ...target, sessionId }) : null
      revision = session?.updated_at ?? (session ? session.id : product.updated_at)
      const fields = [
        ...(!session ? [field('venue', 'Venue', 'select', null, { choices: locationsUsed.map(entry => ({ value: entry.id, label: entry.title })) })] : []),
        field('starts', 'Starts', 'datetime', session?.starts_at ?? new Date(Math.ceil(Date.now() / 3600000) * 3600000).toISOString()),
        field('ends', 'Ends', 'datetime', session?.ends_at ?? new Date(Math.ceil(Date.now() / 3600000) * 3600000 + (booking.duration_minutes ?? invalid('Set a duration first')) * 60000).toISOString()),
        field('capacity', 'Capacity', 'number', session?.capacity, { optional: true }),
        ...(session ? [field('status', 'Scheduled', 'toggle', session.status === 'scheduled')] : []),
      ]
      form(session ? 'Edit session' : 'Add a session', fields, async values => {
        const dates = { startsAt: values('starts'), endsAt: values('ends'), capacity: count(values('capacity')) }
        if (session) await updateSession(db, { ...target, env, actorId: userId, ...dates, sessionId: session.id, expectedUpdatedAt: session.updated_at, status: bool(values('status')) ? 'scheduled' : 'cancelled' })
        else await createSession(db, { ...target, env, actorId: userId, ...dates, locationId: values('venue'), idempotencyKey: answer!.idempotency_key })
      })
    }
  } else return missing('Editor section not found')

  if (!save) {
    if (answer) return missing('This screen has no save action')
    return screen
  }
  if (!answer) return { ...screen, revision }
  if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This offering changed. Reopen this setting before saving.' })
  if (screen.fields.length !== Object.keys(answer.values).length || screen.fields.some(row => typeof answer.values[row.key] !== 'string')) invalid('The saved fields do not match this editor')
  await save(key => answer.values[key] ?? invalid(`Missing editor field: ${key}`))
  return screen
}
