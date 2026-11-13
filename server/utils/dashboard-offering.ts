import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { getDashboardMemberContext, listDashboardLocations } from '~/server/utils/dashboard-context'
import { assertProductAccess, isOrganizationWideRole, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { createCollection, createProduct, deleteCollection, getProduct, hydrateProductMedia, listCollectionProducts, listCollections, listOrganizationProducts, reorderCollections, setCollectionProducts, setProductLocation, setProductPublication, updateCollection, updateProduct } from '~/server/utils/product-management'
import { createSession, deleteProductBookingConfig, getScheduleSession, listAvailabilityRules, listScheduleSessions, replaceWeeklySchedule, setProductBookingConfig, updateSession } from '~/server/utils/availability'
import { attachMediaPlacement, removeMediaPlacement, reorderMediaPlacements, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import { editableProductKinds, PRODUCT_KIND_LABELS, productDetailFields, STAY_DESCRIPTION_DETAIL_KEYS, STAY_LOCATION_DETAIL_KEYS, type ProductDetailsPatch } from '~/shared/product-details'
import { STAY_SAFETY_FIELDS, STAY_SAFETY_SECTIONS, staySafetySectionKeys, type StaySafetySection } from '~/shared/stay-safety'
import { formatMinorAmount, majorAmountToMinor, minorAmountToMajor, scopedPriceAmountPatch, selectPrice } from '~/shared/prices'
import { isCurrencyCode } from '~/shared/currencies'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import type { CatalogAnswer, CatalogField, CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { UpdateProductInput } from '~/server/types/products'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { NOTICE_OPTIONS, noticeSummary } from '~/shared/availability-settings'
import { createTenantPage, getTenantPageById, listTenantPages, updateTenantPage } from '~/server/utils/content/pages'
import { alignTenantPageTranslationBlocks, createTenantPageBlock, createTenantPageTranslationBlocks, isTenantPageBlockAllowed, TENANT_PAGE_BLOCK_REGISTRY, tenantPageLocalizedTextFields, tenantPageTranslationSourceBlockId, writeTenantPageLocalizedText } from '~/utils/tenant-page-blocks'
import { tenantPageBlockLabel } from '~/utils/tenant-page-block-sections'
import { createTenantPageEditorData, validateTenantPageBlock } from '~/utils/tenant-page-editor'
import { addOrganizationLanguage, disableOrganizationLanguage, getOrganizationLanguageSettings, publishOrganizationLanguage } from '~/server/utils/organization-languages'
import { getOrganizationLocalizationProgress } from '~/server/utils/organization-localization-opportunities'
import { isDemoOrganization } from '~/shared/demo'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'
import { FORM_QUESTION_LIMITS, FORM_QUESTION_TYPES, isChoiceQuestionType } from '~/shared/form-questions'
import { FORM_QUESTION_TYPE_LABELS, formQuestionRowSummary, formQuestionsSummary } from '~/utils/form-question-editing'
import { queryFirst } from '~/server/db'
import { assertOrganizationLanguage, getProductCatalogLocalization, putResourceLocalization } from '~/server/utils/localization'
import { RESOURCE_LOCALIZATIONS_SQL } from '~/shared/content-registries'
import { z } from 'zod'
import { groupProductsByCollection } from '~/utils/product-presentation'

const invalid = (message: string): never => { throw new HTTPError({ statusCode: 422, message }) }
const missing = (message: string): never => { throw new HTTPError({ statusCode: 404, message }) }
const field = (key: string, label: string, kind: CatalogField['kind'], value: unknown, options: Partial<CatalogField> = {}): CatalogField =>
  ({ key, label, kind, value: value == null ? '' : String(value), ...options })

export async function dashboardOffering(event: H3Event, answer?: CatalogAnswer): Promise<CatalogScreen> {
  const { db, env, organization, userId } = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(organization, { env, event })
  const query = getQuery(event)
  const view = typeof query.view === 'string' ? query.view : ''
  if (view === 'create-offering' || view === 'section-move') {
    if (!isOrganizationWideRole(organization.role)) return missing('Catalog not found')
    const scope = { organizationId: organization.id }
    const actor = { actorId: userId }
    const creating = view === 'create-offering'
    if (creating && !await roleAllows({ ...principal, permissions: { products: ['create'] } })) return missing('Catalog not found')
    const sections = query.section_id === undefined ? [] : await listCollections(db, scope)
    const section = query.section_id === undefined ? null : sections.find(item => item.id === query.section_id) ?? missing('Section not found')
    const members = section ? await listCollectionProducts(db, { ...scope, collectionId: section.id }) : []
    const ids = members.map(product => product.id)
    const destinations = sections.filter(item => item.id !== section?.id)
    const currency = organization.default_currency
    if (!isCurrencyCode(currency)) throw new Error('Unsupported organization currency')
    const kinds = editableProductKinds('dish').filter(kind => !section || kind === 'dish')
    const fields = creating ? [
      field('kind', 'Type', 'select', section ? 'dish' : '', { choices: kinds.map(value => ({ value, label: PRODUCT_KIND_LABELS[value] })) }),
      field('name', 'Name', 'text', ''),
      field('description', 'Description', 'textarea', '', { optional: true }),
      field('price', `Price (${currency})`, 'money', '', { optional: true }),
    ] : [
      field('product', 'Dish', 'select', '', { choices: members.filter(product => product.kind === 'dish').map(product => ({ value: product.id, label: product.name })) }),
      field('destination', 'Destination section', 'select', '', { choices: destinations.map(item => ({ value: item.id, label: item.name })) }),
    ]
    if (!creating && !section) return missing('Choose a source section')
    const grouped = !creating ? groupProductsByCollection(await listOrganizationProducts(db, scope), destinations) : []
    const membersBySection = new Map(grouped.map(group => [group.id, group.products.map(product => product.id)]))
    const destinationMembers = !creating ? destinations.map(section => [section.id, membersBySection.get(section.id) ?? []] as const) : []
    const revision = JSON.stringify([section?.id ?? null, ids, destinationMembers])
    const screen = { title: creating ? 'Add offering' : 'Move a dish', rows: [], fields, revision, save_label: creating ? 'Create' : 'Move' }
    if (!answer) return screen
    if (!creating && answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The section changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(row => typeof answer.values[row.key] !== 'string')) invalid('The saved fields do not match this editor')
    if (creating) {
      let submitted: unknown
      try { submitted = JSON.parse(answer.revision) } catch { return invalid('Invalid section revision') }
      const snapshot = z.tuple([z.string().nullable(), z.array(z.string()), z.tuple([])]).safeParse(submitted)
      if (!snapshot.success || snapshot.data[0] !== (section?.id ?? null)) return invalid('Invalid section revision')
      const kind = kinds.find(value => value === answer.values.kind) ?? invalid('Choose an offering type')
      const name = answer.values.name!.trim()
      const amount = answer.values.price!.trim()
      await createProduct(db, {
        ...scope, actor, env, publication: { published: false }, idempotencyKey: answer.idempotency_key,
        product: {
          kind, name, description: answer.values.description!, ...(kind === 'service' ? { active: false } : {}),
          ...(amount ? { variants: [{ name, prices: [{ unit_amount: majorAmountToMinor(amount, currency), currency, location_id: section?.location_id ?? null }] }] } : {}),
        },
        ...(section ? { firstMenuSection: { id: section.id, locationId: section.location_id, expectedProductIds: snapshot.data[1] } } : {}),
      })
    } else {
      const source = section ?? missing('Choose a source section')
      const product = members.find(product => product.kind === 'dish' && product.id === answer.values.product) ?? invalid('Choose a dish')
      const destination = destinationMembers.find(([id]) => id === answer.values.destination) ?? invalid('Choose a destination section')
      await setCollectionProducts(db, {
        ...scope, actor, collectionId: source.id, productIds: ids.filter(id => id !== product.id), expectedProductIds: ids,
        moveTo: { collection_id: destination[0], expected_product_ids: destination[1] },
      })
    }
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['languages', 'add-language', 'language', 'language-visibility'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Languages not found')
    const scope = { organizationId: organization.id }
    const settings = await getOrganizationLanguageSettings(db, env, scope)
    const editable = !isDemoOrganization(organization) || await hasPlatformEventPermission(event, env, { platform: ['access'] })
    const available = settings.available_catalogs.filter(item => !settings.languages.some(language => language.locale === item.locale))
    if (view === 'languages') {
      if (answer) return missing('Choose a language')
      return { title: 'Languages', fields: [], rows: [
        ...settings.languages.map(language => ({
          id: language.locale, label: language.label, summary: language.is_source ? 'Default' : language.status === 'published' ? 'Published' : 'Draft',
          ...(language.is_source ? {} : { native: 'language', query: { locale: language.locale } }),
        })),
        ...(editable && available.length ? [{ id: 'add', label: 'Add a language', native: 'add-language', query: {} }] : []),
      ] }
    }
    const language = settings.languages.find(language => language.locale === query.locale && !language.is_source)
    if (view === 'language') {
      if (!language || answer) return missing('Language not found')
      const progress = await getOrganizationLocalizationProgress(db, { ...scope, organizationSlug: organization.slug, locale: language.locale })
      return { title: language.label, fields: [], rows: [
        { id: 'translate-brand', label: 'Translate brand', native: 'brand-translation', query: { locale: language.locale } },
        { id: 'translate-pages', label: 'Translate pages', native: 'pages', query: { locale: language.locale } },
        { id: 'translate-catalog', label: 'Translate Catalog', native: 'catalog-translation', query: { locale: language.locale } },
        ...progress.opportunities.map(item => ({ id: item.id, label: item.label, summary: `${item.completed} of ${item.total} translated` })),
        ...(editable ? [{ id: 'visibility', label: 'Website visibility', summary: language.status === 'published' ? 'Published' : 'Draft', native: 'language-visibility', query: { locale: language.locale } }] : []),
      ] }
    }
    if (!editable) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    const adding = view === 'add-language'
    if (!adding && !language) return missing('Language not found')
    const revision = adding ? JSON.stringify(available.map(item => item.locale)) : language!.status
    const screen = { title: adding ? 'Add a language' : 'Website visibility', rows: [], revision, save_label: 'Save', fields: [
      adding ? field('value', 'Language', 'select', null, { choices: available.map(item => ({ value: item.locale, label: item.label })) })
        : field('value', 'Show on website', 'toggle', language!.status === 'published'),
    ] }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'Languages changed. Reopen this setting before saving.' })
    if (adding) {
      const locale = available.find(item => item.locale === answer.values.value)?.locale ?? invalid('Choose a language')
      await addOrganizationLanguage(db, env, { ...scope, locale })
    } else if (answer.values.value === 'true') {
      await publishOrganizationLanguage(db, env, { ...scope, locale: language!.locale })
    } else if (answer.values.value === 'false') {
      await disableOrganizationLanguage(db, { ...scope, locale: language!.locale })
    } else invalid('Choose On or Off')
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (view === 'catalog-translation' || view === 'catalog-translation-item') {
    if (!isOrganizationWideRole(organization.role)) return missing('Catalog not found')
    const catalog = await getProductCatalogLocalization(env, db, organization.id, query.locale)
    const rows = [...catalog.products.map(item => ({ ...item, type: 'product' as const })), ...catalog.collections.map(item => ({ ...item, type: 'collection' as const }))]
    if (view === 'catalog-translation') {
      if (answer) return missing('Choose a Catalog item')
      return { title: 'Catalog translations', fields: [], rows: rows.map(item => ({
        id: `${item.type}:${item.id}`, label: item.source.name, summary: item.type === 'collection' ? 'Collection' : undefined,
        native: 'catalog-translation-item', query: { locale: catalog.locale, resource_id: item.id, resource_type: item.type },
      })) }
    }
    const item = rows.find(item => item.id === query.resource_id && item.type === query.resource_type) ?? missing('Catalog item not found')
    const values = (item.localization?.values ?? {}) as Record<string, unknown>
    const original = item.source
    const fields = [
      field('name', 'Name', 'text', values.name, { hint: original.name, optional: true }),
      field('description', 'Description', 'textarea', values.description, { hint: original.description ?? undefined, optional: true }),
    ]
    const revision = JSON.stringify([original, values])
    const screen = { title: original.name, rows: [], fields, revision, save_label: 'Save' }
    if (!answer) return screen
    if (isDemoOrganization(organization) && !await hasPlatformEventPermission(event, env, { platform: ['access'] })) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This translation changed. Reopen it before saving.' })
    const next = { ...values }
    for (const { key } of fields) {
      const value = (answer.values[key] ?? invalid('Missing translation field')).trim()
      if (value) next[key] = value
      else Reflect.deleteProperty(next, key)
    }
    await putResourceLocalization(env, db, { organizationId: organization.id, resourceType: item.type, resourceId: item.id, locale: catalog.locale, values: next, userId })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (view === 'brand-translation') {
    if (!isOrganizationWideRole(organization.role)) return missing('Brand not found')
    const language = await assertOrganizationLanguage(db, organization.id, query.locale)
    if (language.source) return missing('Choose an additional language')
    const saved = await queryFirst<{ values_json: string; updated_at: string }>(db, `
      SELECT values_json, updated_at FROM ${RESOURCE_LOCALIZATIONS_SQL}
      WHERE organization_id = ? AND resource_type = 'organization' AND resource_id = ? AND locale = ?
    `, [organization.id, organization.id, language.locale])
    const values = saved ? JSON.parse(saved.values_json) as Record<string, unknown> : {}
    const fields = [
      field('name', 'Name', 'text', values.name, { hint: organization.name, optional: true }),
      field('brand_description', 'Description', 'textarea', values.brand_description, { optional: true }),
    ]
    if (organization.vertical === 'service') {
      const consultation = values.consultation as { cta_label?: string } | undefined
      fields.push(field('cta', 'Consultation button', 'text', consultation?.cta_label, { optional: true }))
    }
    const revision = saved?.updated_at ?? ''
    const screen = { title: 'Brand translation', rows: [], fields, revision, save_label: 'Save' }
    if (!answer) return screen
    if (isDemoOrganization(organization) && !await hasPlatformEventPermission(event, env, { platform: ['access'] })) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This translation changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(row => typeof answer.values[row.key] !== 'string')) invalid('The saved fields do not match this translation')
    const next = { ...values }
    for (const key of ['name', 'brand_description']) {
      const value = answer.values[key]!.trim()
      if (value) next[key] = value
      else Reflect.deleteProperty(next, key)
    }
    if (organization.vertical === 'service') {
      const ctaLabel = answer.values.cta!.trim()
      if (ctaLabel) next.consultation = { cta_label: ctaLabel }
      else Reflect.deleteProperty(next, 'consultation')
    }
    await putResourceLocalization(env, db, { organizationId: organization.id, resourceType: 'organization', resourceId: organization.id, locale: language.locale, values: next, userId })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['pages', 'page', 'page-content', 'page-sections', 'page-order', 'page-section-add', 'page-section-remove'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Page not found')
    const scope = { organizationId: organization.id }
    const locale = typeof query.locale === 'string' ? query.locale : undefined
    if (view === 'pages') {
      if (answer) return missing('Choose a page to edit')
      const pages = await listTenantPages(db, organization.id)
      return { title: 'Pages', fields: [], rows: pages.map(page => ({
        id: page.id, label: page.title, summary: page.path, native: locale ? 'page-content' : 'page',
        query: { page_id: page.id, ...(locale ? { locale } : {}) },
      })) }
    }
    const sourceId = typeof query.page_id === 'string' ? query.page_id : missing('Choose a page')
    const source = await getTenantPageById(db, sourceId, scope)
    if (view === 'page') {
      if (answer) return missing('Choose a page setting')
      return { title: source.title, fields: [], rows: [
        { id: 'copy', label: 'Page text', summary: source.summary ?? undefined, native: 'page-content', query: { page_id: source.id } },
        { id: 'sections', label: 'Sections', summary: String(source.blocks.length), native: 'page-sections', query: { page_id: source.id } },
      ] }
    }
    if (['page-sections', 'page-order', 'page-section-add', 'page-section-remove'].includes(view)) {
      if (locale) return missing('Edit the layout in the source language')
      const row = (id: string, label: string, native: string, query: Record<string, string> = {}): CatalogRow => ({
        id, label, native, query: { page_id: source.id, ...query },
      })
      const allowed = Object.values(TENANT_PAGE_BLOCK_REGISTRY)
        .filter(block => isTenantPageBlockAllowed(block, source.recipe, source.page_type, organization.vertical))
      if (view === 'page-sections') {
        if (answer) return missing('Choose a page section')
        return { title: 'Sections', fields: [], rows: [
          ...source.blocks.map(block => row(block.id, tenantPageBlockLabel(block.type), 'page-content', { block_id: block.id })),
          ...(allowed.length ? [row('add', 'Add a section', 'page-section-add')] : []),
          ...(source.blocks.length > 1 ? [row('order', 'Reorder sections', 'page-order')] : []),
          ...(source.blocks.length ? [row('remove', 'Remove a section', 'page-section-remove')] : []),
        ] }
      }
      const order = view === 'page-order'
      const add = view === 'page-section-add'
      if (add && query.block_type === undefined) {
        if (answer) return missing('Choose a section type')
        return { title: 'Add a section', fields: [], rows: allowed.map(block => row(block.type, block.label, view, { block_type: block.type })) }
      }
      const type = add ? allowed.find(block => block.type === query.block_type)?.type ?? missing('Section type not found') : null
      const draft = type ? createTenantPageBlock(type, createTenantPageEditorData(type), source.blocks.length) : null
      const textFields = draft ? tenantPageLocalizedTextFields(draft) : []
      const choices = add
        ? allowed.map(block => ({ value: block.type, label: block.label }))
        : source.blocks.map((block, index) => ({ value: block.id, label: `${tenantPageBlockLabel(block.type)} ${index + 1}` }))
      const title = order ? 'Reorder sections' : add ? 'Add a section' : 'Remove a section'
      const revision = source.document.updated_at
      const screen = { title, rows: [], fields: draft
        ? textFields.map(({ label, path, value }) => field(path.join('.'), label, 'textarea', value, { optional: true }))
        : [field('value', title, order ? 'order' : 'select', order ? choices.map(item => item.value).join('\n') : '', { choices })],
      revision, save_label: 'Save', allow_unchanged: Boolean(draft && !validateTenantPageBlock(draft).length) }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This page changed. Reopen it before saving.' })
      let blocks = source.blocks
      if (draft) {
        for (const { path } of textFields) writeTenantPageLocalizedText(draft, path, answer.values[path.join('.')] ?? invalid('Missing section field'))
        const problem = validateTenantPageBlock(draft)[0]
        if (problem) return invalid(problem)
        blocks = [...blocks, draft]
      } else if (order) {
        const value = answer.values.value ?? invalid('Choose a section')
        const ids = value ? value.split('\n') : []
        if (ids.length !== blocks.length || new Set(ids).size !== ids.length) invalid('Include each section once')
        blocks = ids.map(id => source.blocks.find(block => block.id === id) ?? invalid('Section not found'))
      } else {
        const value = answer.values.value ?? invalid('Choose a section')
        if (!blocks.some(block => block.id === value)) return invalid('Choose a saved section')
        blocks = blocks.filter(block => block.id !== value)
      }
      await updateTenantPage(db, source.id, { userId, scope, env, data: {
        path: source.path, title: source.title, summary: source.summary, page_type: source.page_type, recipe: source.recipe,
        sort_order: source.sort_order, updated_at: revision, blocks: blocks.map((block, position) => ({ ...block, position })),
      } })
      return screen
    }
    const translated = locale && locale !== source.locale
    const translationId = translated
      ? (await listTenantPages(db, organization.id, { locale })).find(page => page.page_id === source.page_id)?.id
      : undefined
    const saved = translated ? translationId ? await getTenantPageById(db, translationId, scope) : null : source
    const blocks = translated
      ? saved ? alignTenantPageTranslationBlocks(source.blocks, saved.blocks) : createTenantPageTranslationBlocks(source.blocks)
      : source.blocks
    const selected = query.block_id === undefined ? null : source.blocks.find(block => block.id === query.block_id) ?? missing('Section not found')
    const fields = selected ? [] : [
      field('title', 'Title', 'text', saved?.title, { hint: translated ? source.title : undefined }),
      field('summary', 'Summary', 'textarea', saved?.summary, { optional: true, hint: translated ? source.summary ?? undefined : undefined }),
    ]
    const edits = source.blocks.flatMap((block, index) => {
      if (selected && selected.id !== block.id) return []
      const target = translated ? blocks.find(item => tenantPageTranslationSourceBlockId(item) === block.id) : block
      if (!target) throw new Error('Page section is missing from the translation')
      return tenantPageLocalizedTextFields(target).map(({ path, label, value }) => {
        const key = `content:${block.id}:${path.join('.')}`
        const original = translated ? tenantPageLocalizedTextFields(block).find(item => item.path.join('.') === path.join('.'))?.value : undefined
        fields.push(field(key, `${tenantPageBlockLabel(block.type)} ${index + 1} · ${label}`, 'textarea', value, { optional: true, hint: original }))
        return { key, path, target }
      })
    })
    const revision = JSON.stringify([source.document.updated_at, saved?.document.updated_at])
    const screen = { title: selected ? tenantPageBlockLabel(selected.type) : saved?.title ?? source.title, rows: [], fields, revision, save_label: 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This page changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(row => typeof answer.values[row.key] !== 'string')) invalid('The saved fields do not match this page')
    for (const edit of edits) writeTenantPageLocalizedText(edit.target, edit.path, answer.values[edit.key]!)
    const data = {
      page_id: source.page_id, locale: locale ?? source.locale, path: saved?.path ?? source.path,
      title: selected ? saved?.title ?? source.title : answer.values.title!,
      summary: selected ? saved?.summary ?? null : answer.values.summary!, page_type: source.page_type,
      recipe: source.recipe, blocks,
    }
    if (saved) await updateTenantPage(db, saved.id, { userId, scope, data: { ...data, sort_order: source.sort_order, updated_at: saved.document.updated_at }, env })
    else await createTenantPage(db, { organizationId: organization.id, userId, data, env })
    return screen
  }
  if (view === 'add-section' || view === 'menu-order') {
    if (!isOrganizationWideRole(organization.role)) return missing('Menu not found')
    const scope = { organizationId: organization.id }
    const locationId = query.location_id === undefined ? null : typeof query.location_id === 'string' && query.location_id ? query.location_id : invalid('Choose a location')
    if (locationId && !(await listDashboardLocations(db, organization.id, undefined, true)).some(place => place.id === locationId)) return missing('Location not found')
    const adding = view === 'add-section'
    if (adding && !await roleAllows({ ...principal, permissions: { products: ['create'] } })) return missing('Menu not found')
    const sections = await listCollections(db, { ...scope, locationId })
    const ids = sections.map(section => section.id)
    const revision = JSON.stringify(ids)
    const screen = { title: adding ? 'Add section' : 'Reorder sections', rows: [], revision, save_label: 'Save', fields: [
      adding ? field('value', 'Name', 'text', null) : field('value', 'Section order', 'order', ids.join('\n'), {
        choices: sections.map(section => ({ value: section.id, label: section.name, image: mediaStillUrl(section.image) })),
      }),
    ] }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This menu changed. Reopen it before saving.' })
    const value = answer.values.value ?? invalid('Missing menu value')
    const actor = { actorId: userId }
    if (adding) await createCollection(db, { ...scope, actor, collection: { name: value, location_id: locationId, sort_order: (sections.at(-1)?.sort_order ?? -1) + 1 } })
    else await reorderCollections(db, { ...scope, actor, locationId, collectionIds: value ? value.split('\n') : [], expectedCollectionIds: ids })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['section-name', 'section-description', 'section-photo', 'section-items', 'section-membership', 'delete-section'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Section not found')
    const section = (await listCollections(db, { organizationId: organization.id })).find(section => section.id === query.section_id) ?? missing('Section not found')
    const membership = view === 'section-membership'
    const products = view === 'section-items' || membership ? await listCollectionProducts(db, { organizationId: organization.id, collectionId: section.id }) : []
    const ids = products.map(product => product.id)
    const media = view === 'section-photo'
    const order = view === 'section-items'
    const name = view === 'section-name'
    const deleting = view === 'delete-section'
    const title = deleting ? 'Delete section' : media ? 'Photo' : order ? 'Order items' : name ? 'Name' : 'Description'
    const input = media
      ? field('value', title, 'photo', section.image?.asset_id, { optional: true, display_url: mediaStillUrl(section.image) })
      : order
        ? field('value', title, 'order', ids.join('\n'), { choices: products.map(product => ({ value: product.id, label: product.name })) })
        : deleting ? field('value', `Delete ${section.name}`, 'toggle', false, { hint: 'Its items stay in the catalog.' })
          : field('value', title, name ? 'text' : 'textarea', name ? section.name : section.description, { optional: !name })
    const dishes = membership ? (await listOrganizationProducts(db, { organizationId: organization.id, kind: 'dish' }))
      .filter(product => ids.includes(product.id) || section.location_id === null || product.locations.some(place => place.location_id === section.location_id)) : []
    const revision = membership ? JSON.stringify([ids, dishes.map(dish => dish.id)]) : order ? JSON.stringify(ids) : media ? JSON.stringify(section.image?.asset_id ?? null) : section.updated_at
    const fields = membership ? dishes.map(dish => field(dish.id, dish.name, 'toggle', ids.includes(dish.id))) : [input]
    const screen = { title: membership ? 'Choose dishes' : title, fields, rows: [], save_label: 'Save', revision }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This section changed. Reopen this setting before saving.' })
    if (membership) {
      if (fields.length !== Object.keys(answer.values).length || fields.some(row => !['true', 'false'].includes(answer.values[row.key] ?? ''))) invalid('The saved dishes do not match this section')
      const productIds = [
        ...ids.filter(id => answer.values[id] !== 'false'),
        ...dishes.filter(dish => !ids.includes(dish.id) && answer.values[dish.id] === 'true').map(dish => dish.id),
      ]
      await setCollectionProducts(db, { organizationId: organization.id, collectionId: section.id, productIds, expectedProductIds: ids, actor: { actorId: userId } })
      await purgePublicResourceCacheNow(env, organization.id)
      return screen
    }
    const value = answer.values.value ?? invalid('Missing section value')
    if (deleting) {
      if (value !== 'true') invalid('Confirm deletion')
      await deleteCollection(db, { organizationId: organization.id, collectionId: section.id })
    } else if (order) {
      const productIds = value ? value.split('\n') : []
      if (productIds.length !== ids.length || new Set(productIds).size !== ids.length || !productIds.every(id => ids.includes(id))) invalid('The order must contain every item once')
      await setCollectionProducts(db, { organizationId: organization.id, collectionId: section.id, productIds, expectedProductIds: ids, actor: { actorId: userId } })
    } else if (media) {
      await setSingleMediaPlacement(db, { env, organizationId: organization.id, principal, placement: { owner_type: 'collection', owner_id: section.id, slot: 'image' }, assetId: value || null })
    } else {
      await updateCollection(db, { organizationId: organization.id, collectionId: section.id, expectedUpdatedAt: revision, patch: name ? { name: value } : { description: value }, actor: { actorId: userId } })
    }
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  const productId = typeof query.product_id === 'string' && query.product_id ? query.product_id : missing('Choose an offering')
  await assertProductAccess(db, { ...principal, productId })
  const [product] = await hydrateProductMedia(db, organization.id, [await getProduct(db, organization.id, productId)])
  if (!product) return missing('Offering not found')
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
  if (product.kind === 'stay' && !['questions', 'question', 'question-order', 'stay-details', 'stay-field', 'stay-safety'].includes(view)) return missing('Offering not found')
  const setBooking = async (changes: Parameters<typeof setProductBookingConfig>[1]['patch']) => {
    await assertProductAccess(db, { ...principal, productId, patch: changes as Record<string, unknown> })
    await setProductBookingConfig(db, { ...target, patch: changes, actorId: userId, env })
    await purgePublicResourceCacheNow(env, organization.id)
  }
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
  const noticeChoices = NOTICE_OPTIONS.map(choice => ({ value: String(choice.value), label: choice.label }))
  const memberList = () => memberSchedulingList({ env, userId, organizationId: organization.id })
  const locationsUsed = locations.filter(entry => product.locations.some(binding => binding.location_id === entry.id))

  if (view === 'stay-details' || view === 'stay-field' || view === 'stay-safety') {
    if (product.kind !== 'stay' || !wide) return missing('Listing settings not found')
    const definitions = productDetailFields('stay')
    const keys = [...STAY_DESCRIPTION_DETAIL_KEYS, ...STAY_LOCATION_DETAIL_KEYS, 'featured']
    if (view === 'stay-details') {
      screen = { title: 'Listing details', fields: [], rows: [
        ...definitions.filter(definition => keys.includes(definition.key)).map(definition => leaf(
          definition.key, definition.name, text(detail(definition.key)) || undefined,
          { view: 'stay-field', query: { field: definition.key } },
        )),
        ...Object.entries(STAY_SAFETY_SECTIONS).map(([key, section]) => leaf(key, section.label, undefined, { view: 'stay-safety', query: { section: key } })),
      ] }
    } else {
      const section = Object.keys(STAY_SAFETY_SECTIONS).find(key => key === query.section) as StaySafetySection | undefined
      const selected = view === 'stay-safety'
        ? definitions.filter(definition => staySafetySectionKeys(section ?? missing('Safety section not found')).includes(definition.key as never))
        : definitions.filter(definition => definition.key === query.field && keys.includes(definition.key))
      if (!selected.length) return missing('Listing details not found')
      form(section ? STAY_SAFETY_SECTIONS[section].label : selected[0]!.name, selected.map(definition => field(
        definition.key, definition.name, definition.value_type === 'boolean' ? 'select' : 'textarea', detail(definition.key),
        definition.value_type === 'boolean'
          ? { choices: [{ value: '', label: 'Unspecified' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }], optional: true }
          : { optional: true },
      )), async values => {
        const details: ProductDetailsPatch = {}
        for (const definition of selected) {
          const value = values(definition.key).trim()
          Object.assign(details, { [definition.key]: !value ? null : definition.value_type === 'boolean' ? bool(value) : value })
        }
        if (section) {
          for (const [key, item] of Object.entries(STAY_SAFETY_FIELDS)) {
            if (Object.hasOwn(details, key) && details[key as keyof ProductDetailsPatch] !== true) details[item.detailsKey] = null
          }
        }
        await patch({ details_mode: 'merge', details })
      })
    }
  } else if (!view) {
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
      ...(service ? [{ id: 'page', label: 'Page content', summary: product.page?.title ?? 'No page', ...(wide ? {
        to: product.page ? `/dashboard/${organization.slug}/website/pages/${product.page.id}` : `${web}/page`,
        ...(product.page ? { native: 'page', query: { page_id: product.page.id } } : { native: 'create-page', query: params }),
      } : {}) }] : []),
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
      ...(manages ? [leaf('kind', 'Type', PRODUCT_KIND_LABELS[product.kind])] : []),
    ]
  } else if (view === 'create-page' && service && wide && !product.page) {
    form('Create page', [field('title', 'Title', 'text', product.name)], async values => {
      await createTenantPage(db, { organizationId: organization.id, userId, env, data: {
        product_id: product.id, path: `/services/${product.slug}`, title: values('title'), page_type: 'recipe', recipe: 'service-detail', blocks: [],
      } })
    })
    screen.save_label = 'Create page'
    screen.allow_unchanged = true
  } else if (view === 'kind' && manages) {
    const kinds = editableProductKinds(product.kind)
    form('Type', [field('kind', 'Type', 'select', product.kind, {
      choices: kinds.map(value => ({ value, label: PRODUCT_KIND_LABELS[value] })),
    })], async values => {
      const kind = kinds.find(kind => kind === values('kind')) ?? invalid('Choose an offering type')
      await patch({ kind })
    })
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
  } else if (view === 'photo' || view === 'cover' || view === 'gallery' || view === 'gallery-order') {
    if (!wide) return missing('Media not found')
    if (view === 'photo') screen = { title: 'Media', fields: [], rows: [
      { ...leaf('cover', 'Cover photo'), image: mediaStillUrl(product.image) },
      ...(product.gallery.length > 1 ? [leaf('gallery-order', 'Reorder gallery')] : []),
      ...product.gallery.map(asset => ({ ...leaf(asset.asset_id, 'Gallery item', undefined, { view: 'gallery', query: { asset_id: asset.asset_id } }), image: mediaStillUrl(asset) })),
      leaf('gallery', 'Add to gallery'),
    ] }
    else if (view === 'gallery-order') {
      const ids = product.gallery.map(asset => asset.asset_id)
      revision = ids.join('\n')
      form('Reorder gallery', [field('order', 'Gallery order', 'order', revision, {
        choices: product.gallery.map((asset, index) => ({
          value: asset.asset_id,
          label: `Gallery item ${index + 1}`,
          image: mediaStillUrl(asset),
        })),
      })], async values => {
        const order = values('order').split('\n')
        if (order.length !== ids.length || new Set(order).size !== ids.length || !order.every(id => ids.includes(id))) {
          invalid('Gallery order must contain each gallery item once')
        }
        const moves = order.slice(1).map((asset_id, index) => ({ asset_id, after_asset_id: order[index]! }))
        await reorderMediaPlacements(db, {
          env, organizationId: organization.id, principal,
          placement: { owner_type: 'product', owner_id: productId, slot: 'gallery' },
          moves,
          expectedAssetIds: ids,
        })
      })
    }
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
        ? [leaf('seatings', 'Seatings', `${booking.duration_minutes} minutes each · every ${booking.seating_interval_minutes} minutes`, { web: 'booking/seatings' })]
        : [leaf('duration', 'Duration', `${booking.duration_minutes} minutes`, { web: 'booking/duration' })]),
      leaf('capacity', service ? 'Client limit' : 'Guest limit', booking.default_capacity == null ? 'Unlimited' : String(booking.default_capacity), { web: 'booking/capacity' }),
      leaf('party', 'Party size', undefined, { web: 'booking/party' }),
      leaf('guest-terms', service ? 'Client requirements' : 'Guest requirements', undefined, { web: 'booking/guest-terms' }),
      leaf('confirmation', 'Confirmation', bookingChoices.find(choice => choice.value === booking.confirmation_mode)?.label, { web: 'booking/confirmation' }),
      leaf('notice', 'Advance notice', noticeSummary(booking.advance_notice_minutes), { web: 'booking/notice' }),
      leaf('questions', 'Questions', formQuestionsSummary(booking.questions), { web: 'booking/questions' }),
      leaf('payment', 'Payment', booking.online_payment_required ? 'Online payment required' : 'No payment collected at booking', { web: 'booking/payment' }),
      ...(manages ? [leaf('assignment', copy.assigneeLabel, undefined, { web: 'booking/assignment' }), leaf('meeting', 'Meeting format', booking.held_online ? 'Online' : 'In person', { web: 'booking/location' }), leaf('enabled', 'Booking calendar', 'Set up', { web: 'booking/enabled' })] : []),
      ...(product.kind === 'table' ? [] : locationsUsed.map(entry => leaf(entry.id, service ? `Availability at ${entry.title}` : `Repeating times at ${entry.title}`, undefined, { view: 'schedule', web: 'booking/schedule', query: { place_id: entry.id } }))),
      ...(experience || service ? [{ ...leaf('sessions', service ? 'Consultation times' : 'Sessions'), to: `/dashboard/${organization.slug}/calendar?product_id=${productId}` }] : []),
      ...(booking.held_online ? [{ id: 'online', label: 'Online availability', summary: `Uses the ${copy.assigneeNoun}’s working hours` }] : []),
    ] : manages ? [leaf('enabled', service ? 'Set up consultations' : 'Set up bookings', undefined, { web: 'booking/enabled' })] : [] }
  } else if (view === 'questions' || view === 'question' || view === 'question-order') {
    const owner = product.kind === 'stay' ? product.stay : booking
    if (!owner) return missing('Booking calendar not found')
    const questions = owner.questions
    revision = owner.questions_revision
    const write = (next: unknown) => {
      const changes = { questions: next, expected_questions_revision: owner.questions_revision }
      return product.kind === 'stay' ? patch({ stay: changes }) : setBooking(changes)
    }
    if (view === 'questions') {
      screen = { title: 'Questions', fields: [], rows: [
        ...questions.map(question => leaf(question.id, question.label, formQuestionRowSummary(question), { view: 'question', query: { question_id: question.id } })),
        ...(questions.length < FORM_QUESTION_LIMITS.questions ? [leaf('add-question', 'Add question', undefined, { view: 'question' })] : []),
        ...(questions.length > 1 ? [leaf('question-order', 'Reorder questions')] : []),
      ] }
    } else if (view === 'question-order') {
      form('Reorder questions', [field('order', 'Question order', 'order', questions.map(question => question.id).join('\n'), {
        choices: questions.map(question => ({ value: question.id, label: question.label })),
      })], async values => {
        const ids = values('order').split('\n')
        if (ids.length !== questions.length || new Set(ids).size !== questions.length) invalid('Include each question once')
        await write(ids.map(id => questions.find(question => question.id === id) ?? invalid('Question not found')))
      })
    } else {
      const question = query.question_id === undefined ? undefined : questions.find(question => question.id === query.question_id) ?? missing('Question not found')
      form(question ? 'Edit question' : 'Add question', [
        field('label', 'Question', 'text', question?.label),
        field('type', 'Answer type', 'select', question?.type ?? 'short_text', {
          choices: FORM_QUESTION_TYPES.map(value => ({ value, label: FORM_QUESTION_TYPE_LABELS[value].label })),
        }),
        field('help', 'Help text', 'textarea', question?.help_text, { optional: true }),
        field('required', 'Required', 'toggle', question?.required ?? false),
        ...(question?.choices.map(choice => field(`choice:${choice.id}`, 'Saved option (clear to remove)', 'text', choice.label, { optional: true })) ?? []),
        field('choices', 'New options (one per line)', 'textarea', null, { optional: true }),
        ...(question ? [field('remove', 'Remove this question', 'toggle', false)] : []),
      ], async values => {
        if (question && bool(values('remove'))) {
          await write(questions.filter(item => item.id !== question.id))
          return
        }
        const type = FORM_QUESTION_TYPES.find(type => type === values('type')) ?? invalid('Choose an answer type')
        const choices = isChoiceQuestionType(type) ? [
          ...(question?.choices ?? []).flatMap(choice => {
            const label = values(`choice:${choice.id}`).trim()
            return label ? [{ id: choice.id, label }] : []
          }),
          ...values('choices').split('\n').map(label => label.trim()).filter(Boolean).map(label => ({ label })),
        ] : []
        const next = { ...(question ? { id: question.id } : {}), type, choices, label: values('label'), help_text: values('help').trim() || null, required: bool(values('required')) }
        await write(question ? questions.map(item => item.id === question.id ? next : item) : [...questions, next])
      })
    }
  } else if (['duration', 'seatings', 'capacity', 'confirmation', 'meeting', 'party', 'guest-terms', 'notice', 'payment'].includes(view)) {
    if (!booking) return missing('Booking calendar not found')
    if ((view === 'duration' && product.kind === 'table') || (view === 'seatings' && product.kind !== 'table')) return missing('Booking duration not found')
    if (view === 'duration') form('Duration', [field('minutes', 'Duration in minutes', 'number', booking.duration_minutes)], async values => setBooking({ duration_minutes: count(values('minutes')) ?? invalid('Enter a duration') }))
    if (view === 'seatings') form('Seatings', [
      field('duration', 'Table held for (minutes)', 'number', booking.duration_minutes),
      field('interval', 'A seating every (minutes)', 'number', booking.seating_interval_minutes),
    ], async values => setBooking({
      duration_minutes: count(values('duration')) ?? invalid('Enter a duration'),
      seating_interval_minutes: count(values('interval')) ?? invalid('Enter a seating interval'),
    }))
    if (view === 'capacity') form('Capacity', [field('capacity', service ? 'Maximum clients' : 'Maximum guests', 'number', booking.default_capacity, { optional: true })], async values => setBooking({ default_capacity: count(values('capacity')) }))
    if (view === 'confirmation') form('Confirmation', [field('mode', 'Confirmation', 'select', booking.confirmation_mode, { choices: bookingChoices })], async values => setBooking({ confirmation_mode: values('mode') as 'instant' | 'review' }))
    if (view === 'party') form('Party size', [
      field('min', `Fewest ${copy.guestsLabelPlural}`, 'number', booking.party_size_min, { optional: true }),
      field('max', `Most ${copy.guestsLabelPlural}`, 'number', booking.party_size_max, { optional: true }),
    ], async values => setBooking({ party_size_min: count(values('min')), party_size_max: count(values('max')) }))
    if (view === 'guest-terms') form(service ? 'Client requirements' : 'Guest requirements', [
      field('age', 'Minimum age', 'number', booking.minimum_guest_age, { optional: true }),
      field('contact', `Ask ${copy.guestsLabelPlural} who need access support to contact you first`, 'toggle', booking.accessibility_contact_required),
    ], async values => setBooking({ minimum_guest_age: count(values('age')), accessibility_contact_required: bool(values('contact')) }))
    if (view === 'notice') {
      const current = booking.advance_notice_minutes ?? 0
      const choices = noticeChoices.some(choice => choice.value === String(current))
        ? noticeChoices
        : [...noticeChoices, { value: String(current), label: noticeSummary(current) }]
      form('Advance notice', [field('notice', 'Advance notice', 'select', current, { choices })],
        async values => setBooking({ advance_notice_minutes: Number(choices.find(choice => choice.value === values('notice'))?.value ?? invalid('Choose an advance notice')) }))
    }
    if (view === 'payment') form('Payment', [
      field('required', 'Require online payment', 'toggle', booking.online_payment_required),
      field('basis', 'The price is paid', 'select', booking.payment_basis, {
        choices: [{ value: 'per_guest', label: `Per ${copy.guestLabel}` }, { value: 'per_booking', label: 'Once per booking' }],
      }),
      field('min', 'Only for parties of at least', 'number', booking.payment_min_party_size, { optional: true }),
    ], async values => setBooking({
      online_payment_required: bool(values('required')),
      payment_basis: values('basis'),
      payment_min_party_size: count(values('min')),
    }))
    if (view === 'meeting') {
      if (!manages) return missing('Meeting format not found')
      form('Meeting format', [field('online', service ? 'Offer online consultations' : 'Offer online booking', 'toggle', booking.held_online)], async values => setBooking({ held_online: bool(values('online')) }))
    }
  } else if (view === 'assignment' || view === 'enabled') {
    if (!manages || (view === 'assignment' && !booking)) return missing('Assignment not found')
    const { members } = await memberList()
    const fields = [field('member', copy.assigneeLabel, 'select', booking?.assigned_member_id, { choices: members.map(member => ({ value: member.id, label: member.name })) })]
    if (!service) fields.push(field('hours', 'Use the host’s working hours', 'toggle', booking?.scheduling_mode === 'provider'))
    if (view === 'enabled' && booking && wide) fields.unshift(field('enabled', 'Use booking calendar', 'toggle', true))
    if (view === 'enabled' && product.kind === 'table') fields.push(
      field('duration', 'Table held for (minutes)', 'number', booking?.duration_minutes),
      field('interval', 'A seating every (minutes)', 'number', booking?.seating_interval_minutes),
    )
    form(view === 'enabled' ? bookingLabel : copy.assigneeLabel, fields, async values => {
      if (view === 'enabled' && booking && wide && !bool(values('enabled'))) {
        await deleteProductBookingConfig(db, target)
        await purgePublicResourceCacheNow(env, organization.id)
        return
      }
      await setBooking({
        assigned_member_id: values('member'),
        scheduling_mode: service || bool(values('hours')) ? 'provider' : 'business',
        ...(view === 'enabled' && product.kind === 'table' ? {
          duration_minutes: count(values('duration')) ?? invalid('Enter a duration'),
          seating_interval_minutes: count(values('interval')) ?? invalid('Enter a seating interval'),
        } : {}),
      })
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
    if ((!experience && !service) || !booking) return missing('Sessions not found')
    const sessionId = typeof query.session_id === 'string' ? query.session_id : null
    if (view === 'sessions') {
      const from = new Date()
      const sessions = await listScheduleSessions(db, { ...target, env, fromInstant: from.toISOString(), toInstant: new Date(from.getTime() + 90 * 86400000).toISOString() })
      screen = { title: service ? 'Consultation times' : 'Sessions', fields: [], rows: [
        ...(locationsUsed.length ? [leaf('add', service ? 'Add a consultation time' : 'Add a session', undefined, { view: 'session' })] : []),
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
        else {
          const venue = locationsUsed.find(place => place.id === values('venue')) ?? invalid('Choose an assigned location')
          await createSession(db, { ...target, env, actorId: userId, ...dates, locationId: venue.id, idempotencyKey: answer!.idempotency_key })
        }
        await purgePublicResourceCacheNow(env, organization.id)
      })
    }
  } else return missing('Editor section not found')

  if (!save) {
    if (answer) return missing('This screen has no save action')
    return screen
  }
  if (['duration', 'seatings', 'capacity', 'confirmation', 'meeting', 'party', 'guest-terms', 'notice', 'payment', 'assignment', 'enabled'].includes(view)) {
    revision = JSON.stringify([product.updated_at, ...screen.fields.map(row => row.value)])
  }
  if (!answer) return { ...screen, revision }
  if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This offering changed. Reopen this setting before saving.' })
  if (screen.fields.length !== Object.keys(answer.values).length || screen.fields.some(row => typeof answer.values[row.key] !== 'string')) invalid('The saved fields do not match this editor')
  await save(key => answer.values[key] ?? invalid(`Missing editor field: ${key}`))
  return screen
}
