import { PUBLICATION_CONTENT_BLOCK_TYPES } from '~/shared/content-registries'
import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { getDashboardMemberContext, listDashboardLocations } from '~/server/utils/dashboard-context'
import { assertProductAccess, assertResourceAccess, isOrganizationWideRole, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { createCollection, createProduct, deleteCollection, getProduct, hydrateProductMedia, listCollectionProducts, listCollections, listOrganizationProducts, reorderCollections, setCollectionProducts, setProductLocation, setProductPublication, updateCollection, updateProduct } from '~/server/utils/product-management'
import { createSession, deleteProductBookingConfig, getScheduleSession, listAvailabilityRules, listScheduleSessions, replaceWeeklySchedule, setProductBookingConfig, updateSession } from '~/server/utils/availability'
import { attachMediaPlacement, removeMediaPlacement, reorderMediaPlacements, setSingleMediaPlacement } from '~/server/utils/media-placement'
import { hydrateMediaAssetRefs } from '~/server/utils/media-asset-manager'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { memberSchedulingList } from '~/server/domain/member-scheduling'
import { editableProductKinds, PRODUCT_KIND_LABELS, productDetailFields, STAY_DESCRIPTION_DETAIL_KEYS, STAY_HOUSE_RULE_DETAIL_KEYS, STAY_LOCATION_DETAIL_KEYS, STAY_QUIET_HOUR_TIMES, type ProductDetailsPatch } from '~/shared/product-details'
import { STAY_SAFETY_FIELDS, STAY_SAFETY_SECTIONS, staySafetySectionKeys, type StaySafetySection } from '~/shared/stay-safety'
import { formatMinorAmount, majorAmountToMinor, minorAmountToMajor, scopedPriceAmountPatch, selectPrice } from '~/shared/prices'
import { CURRENCY_OPTIONS, isCurrencyCode } from '~/shared/currencies'
import { mediaPlaybackUrl, mediaStillUrl } from '~/shared/media-placement-contract'
import type { CatalogAnswer, CatalogField, CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { UpdateProductInput } from '~/server/types/products'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { NOTICE_OPTIONS, noticeSummary } from '~/shared/availability-settings'
import { createTenantPage, deleteTenantPage, getTenantPageById, listTenantPages, updateTenantPage } from '~/server/utils/content/pages'
import { slugifyTitle } from '~/utils/post-slugs'
import { alignTenantPageTranslationBlocks, createTenantPageBlock, createTenantPageTranslationBlocks, isTenantPageBlockAllowed, TENANT_PAGE_BLOCK_REGISTRY, tenantPageLocalizedTextFields, tenantPageTranslationSourceBlockId, writeTenantPageLocalizedText, type TenantPageBlock, type TenantPageField } from '~/utils/tenant-page-blocks'
import { reorderTenantPageRecords, tenantPageBlockFieldsForSection, tenantPageBlockLabel, tenantPageBlockSections, tenantPageRecordTitle, TENANT_PAGE_RECORD_NOUNS, type TenantPageBlockCollection } from '~/utils/tenant-page-block-sections'
import { createTenantPageEditorData, validateTenantPageBlock } from '~/utils/tenant-page-editor'
import { addOrganizationLanguage, disableOrganizationLanguage, getOrganizationLanguageSettings, publishOrganizationLanguage } from '~/server/utils/organization-languages'
import { getOrganizationLocalizationProgress } from '~/server/utils/organization-localization-opportunities'
import { isDemoOrganization } from '~/shared/demo'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'
import { FORM_QUESTION_LIMITS, FORM_QUESTION_TYPES, isChoiceQuestionType, type FormQuestion } from '~/shared/form-questions'
import { FORM_QUESTION_TYPE_LABELS, formQuestionRowSummary, formQuestionsSummary } from '~/utils/form-question-editing'
import { queryAll } from '~/server/db'
import { assertOrganizationLanguage, findResourceLocalization, getLocalizationForAuthoring, getProductCatalogLocalization, putLocalizationForAuthoring, putResourceLocalization } from '~/server/utils/localization'
import { z } from 'zod'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { createStayPhotoRoom, moveStayPhotos, readStayHome, removeStayPhotoRoom, stayAccessFor, updateStayHome, updateStayHomeAccessibility, updateStayPhotoRoom } from '~/server/domain/stays'
import { isStayHomeAccessibilityFeature, isStayRoomAccessibilityFeature, STAY_HOME_ACCESSIBILITY_FEATURES, STAY_ROOM_ACCESSIBILITY_FEATURES } from '~/shared/stay-accessibility'
import { STAY_BED_TYPES, STAY_PHOTO_ROOM_TYPES, stayPhotoRoomName, type StayBedType } from '~/shared/stay-photos'
import { STAY_AMENITIES, STAY_LISTING_TYPES, STAY_MAP_SHARING_MODES, STAY_PROPERTY_SIZE_UNITS } from '~/shared/stay-listing'
import { MINUTE_TIME_PATTERN } from '~/utils/timezone'
import { getLocation } from '~/server/utils/location-management'
import { getContentDocumentById, getContentEditorSnapshotForDocument, getContentRepresentation, type ContentBlockInput } from '~/server/utils/content/documents'
import { createArticleCategory, deleteArticleCategory, listArticleCategories, reorderArticleCategories, updateArticleCategory } from '~/server/utils/content/article-categories'
import { ARTICLE_COLLECTIONS, ARTICLE_COLLECTION_SLUGS, isArticleCollection } from '~/utils/article-collections'
import { articleCollectionOf, createBlogPost, deleteBlogPost, getBlogPost, updateBlogLifecycle, updateBlogPost } from '~/server/utils/content/publishing'
import { loadDashboardBlogPosts } from '~/server/utils/dashboard-editor-resources'
import { createPost, deletePost, getPost, listPosts, updatePost } from '~/server/utils/post-management'
import { getSocialConnections, publishPost, type PublishTarget } from '~/server/utils/social-publication'
import { PostValidationError } from '~/shared/posts'
import { createQa, deleteQa, listQa, updateQa } from '~/server/utils/location-qa'
import { mcpPageWindow } from '~/server/utils/mcp-pagination'
import { readLocalizedFormQuestions } from '~/server/domain/form-questions'
import { setPublicConsultationMode } from '~/server/utils/professional-services'
import { isLodgingConfirmationMode } from '~/shared/lodging-booking'
import { loadSettingsPayload, updateOrganizationSettingsFields } from '~/server/utils/organization-settings'
import type { UpdateOrganizationSettingsRequest } from '~/server/types/organization'
import { getLinksPage, OrganizationLinksValidationError, upsertLinksPage } from '~/server/utils/links-page'
import { blankBlogLocalizedText, blogLocalizedTextFields, initialBlogEditorBlocks, type EditorContentBlock, readBlogLocalizedText, writeBlogLocalizedText } from '~/utils/blog-editor'
import { PRICING_CALCULATOR_COLUMNS, pricingCalculatorConfig, pricingCalculatorRows, updatePricingCalculator } from '~/utils/pricing-calculator'
import { SITE_PALETTE_MODES, SITE_PALETTE_ROLES, type SitePalettePatch } from '~/shared/site-palette'
import { ORGANIZATION_FONT_OPTIONS, isOrganizationFontPreset } from '~/shared/organization-fonts'
import { getOrganizationDomainsDashboardPayload } from '~/server/utils/domain-read-model'
import { organizationPublicUrl, setCanonicalDomain } from '~/server/utils/domains'
import { changeDashboardDomain, connectDashboardDomain } from '~/server/utils/domain-dashboard-actions'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import { dashboardOrigin } from '~/server/utils/dashboard-notification-links'
import { listOrganizationReviews, setReviewStatus } from '~/server/utils/organization-reviews'
import { isPlatformSite } from '~/utils/site-routing'
import { isRecord } from '~/server/utils/type-guards'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'

const STAY_ROOM_VIEWS = ['stay-rooms', 'stay-room', 'stay-room-add', 'stay-room-beds', 'stay-room-privacy', 'stay-room-remove', 'stay-photo-room', 'stay-room-amenities', 'stay-room-accessibility']

const invalid = (message: string): never => { throw new HTTPError({ statusCode: 422, message }) }
const missing = (message: string): never => { throw new HTTPError({ statusCode: 404, message }) }
const field = (key: string, label: string, kind: CatalogField['kind'], value: unknown, options: Partial<CatalogField> = {}): CatalogField =>
  ({ key, label, kind, value: value == null ? '' : String(value), ...options })

async function questionEditor(
  view: string, query: { question_id?: unknown }, scope: Record<string, string>, title: string,
  questions: FormQuestion[], revision: string, answer: CatalogAnswer | undefined,
  write: (next: unknown) => Promise<void>,
): Promise<CatalogScreen> {
  const inquiry = view.startsWith('inquiry-')
  const listView = inquiry ? 'inquiry-questions' : 'questions'
  const itemView = inquiry ? 'inquiry-question' : 'question'
  const orderView = inquiry ? 'inquiry-question-order' : 'question-order'
  let screen: CatalogScreen
  let save: ((value: (key: string) => string) => Promise<void>) | undefined
  const form = (title: string, fields: CatalogField[], submit: NonNullable<typeof save>) => {
    screen = { title, fields, rows: [], revision, save_label: 'Save' }
    save = submit
  }
  const bool = (value: string) => value === 'true' ? true : value === 'false' ? false : invalid('Choose On or Off')
  if (view === listView) {
    if (answer) return missing('Choose a question')
    return { title, fields: [], rows: [
      ...questions.map(question => ({ id: question.id, label: question.label, summary: formQuestionRowSummary(question), native: itemView, query: { ...scope, question_id: question.id } })),
      ...(questions.length < FORM_QUESTION_LIMITS.questions ? [{ id: 'add-question', label: 'Add question', native: itemView, query: scope }] : []),
      ...(questions.length > 1 ? [{ id: 'question-order', label: 'Reorder questions', native: orderView, query: scope }] : []),
    ] }
  } else if (view === orderView) {
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
  if (!answer) return screen!
  if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The questions changed. Reopen the editor before saving.' })
  if (screen!.fields.length !== Object.keys(answer.values).length || screen!.fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this editor')
  await save!(key => answer.values[key]!)
  return screen!
}

export async function dashboardOffering(event: H3Event, answer?: CatalogAnswer): Promise<CatalogScreen> {
  const { db, env, organization, userId, session } = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(organization, { env, event })
  const query = getQuery(event)
  const view = typeof query.view === 'string' ? query.view : ''
  if (['website', 'website-preferences', 'website-status', 'website-booking', 'website-booking-mode'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Website not found')
    const settings = await loadSettingsPayload(db, env, organization.id)
    const lodging = settings.vertical === 'lodging'
    const bookingTitle = settings.vertical === 'service' ? 'Consultation settings' : settings.vertical === 'restaurant' ? 'Reservation settings' : 'Booking settings'
    const status = settings.status === 'active' ? 'Published' : settings.status === 'suspended' ? 'Suspended' : 'Draft'
    const row = (native: string, label: string, summary?: string): CatalogRow => ({ id: native, native, label, summary })
    const booking = row('website-booking', bookingTitle, lodging
      ? settings.lodging_booking_choices?.find(choice => choice.value === settings.lodging_booking?.confirmation_mode)?.label
      : settings.consultation_mode === 'native' ? 'Accepting consultation requests online' : undefined)
    const statusRow = settings.status === 'suspended' ? { id: 'status', label: 'Status', summary: status } : row('website-status', 'Status', status)
    if (view === 'website' || view === 'website-preferences' || view === 'website-booking') {
      if (answer) return invalid('Choose a website setting')
      if (view === 'website') return { title: 'Website', fields: [], preview_url: settings.public_url, rows: [
        statusRow, row('pages', 'Pages'), row('website-blog', 'Blog'), row('website-posts', 'Social posts'), booking,
        row('website-brand', 'Brand', settings.name ?? undefined), row('website-reviews', 'Reviews'), row('website-qa', 'Q&A'), row('website-preferences', 'Preferences'),
      ] }
      if (view === 'website-preferences') return { title: 'Preferences', fields: [], rows: [
        statusRow, row('languages', 'Languages'), row('website-domains', 'Domains'), row('website-currency', 'Currency', settings.default_currency),
        booking, row('website-reviews', 'Manage published reviews'), row('website-seo', 'Search engine optimization'),
      ] }
      return { title: bookingTitle, fields: [], rows: [
        ...(lodging || settings.consultation_mode ? [row('website-booking-mode', 'Confirmation', booking.summary)] : []),
        ...(lodging ? [row('payout-method', 'How you get paid', 'Manage your Stripe account and payouts')] : []),
        row('inquiry-questions', 'Intake questions', formQuestionsSummary(settings.inquiry_questions)),
      ] }
    }
    const statusEditor = view === 'website-status'
    if (statusEditor && query.current_address !== undefined && (await organizationPublicUrl(env, db, organization.id) !== query.current_address || settings.status !== 'inactive')) {
      return invalid('Website details changed. Reopen Today to see the current status.')
    }
    if (statusEditor && settings.status !== 'active' && settings.status !== 'inactive') return invalid('This website cannot change its publication status.')
    const lodgingPolicy = settings.lodging_booking
    const lodgingChoices = settings.lodging_booking_choices
    const consultation = settings.consultation_mode
    if (!statusEditor && (lodging ? !lodgingPolicy || !lodgingChoices : !consultation)) return missing('Booking settings not found')
    const revision = JSON.stringify([settings.updated_at, statusEditor ? settings.status : lodging ? lodgingPolicy?.confirmation_mode : consultation])
    let previewUrl: string | undefined
    if (statusEditor && !answer && settings.status === 'inactive' && settings.public_url) {
      const secret = previewSecretOf(env)
      if (!secret) throw new Error('Website preview signing is unavailable')
      const url = new URL(settings.public_url)
      url.searchParams.set(PREVIEW_TOKEN_QUERY, await createPreviewToken(secret, organization.id, Date.now() + PREVIEW_TOKEN_TTL_MS))
      previewUrl = url.toString()
    }
    const screen = { title: statusEditor ? 'Status' : bookingTitle, preview_url: previewUrl, fields: [statusEditor
      ? field('value', 'Status', 'select', settings.status, { choices: [{ value: 'inactive', label: 'Draft' }, { value: 'active', label: 'Published' }] })
      : lodging ? field('value', 'Booking settings', 'select', lodgingPolicy!.confirmation_mode, { choices: lodgingChoices!.map(({ value, label }) => ({ value, label })) })
        : field('value', 'Consultations', 'select', consultation === 'native' ? 'online' : 'offline', { choices: [
          { value: 'online', label: 'Accept consultation requests online' }, { value: 'offline', label: 'Inquiries only (offline scheduling)' },
        ] })], rows: [], revision, save_label: 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) return invalid('Website settings changed. Reopen this setting before saving.')
    const value = answer.values.value
    if (Object.keys(answer.values).length !== 1) return invalid('Choose a setting')
    if (!statusEditor && !lodging) {
      if (value !== 'online' && value !== 'offline') return invalid('Choose a consultation mode')
      if (value === 'online') await setPublicConsultationMode(db, organization.id, 'native')
      else if (consultation === 'native') await setPublicConsultationMode(db, organization.id, 'native_disabled')
      await purgePublicResourceCacheNow(env, organization.id)
    } else {
      const updates: UpdateOrganizationSettingsRequest = statusEditor
        ? { status: value === 'active' || value === 'inactive' ? value : invalid('Choose a website status') }
        : { lodging_booking: { confirmation_mode: isLodgingConfirmationMode(value) ? value : invalid('Choose a booking mode') } }
      const saved = await updateOrganizationSettingsFields(db, env, organization.id, updates, userId)
      if (saved.status >= 400) throw new HTTPError({ statusCode: saved.status, message: String(saved.data.error), data: saved.data })
    }
    return screen
  }
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
          id: language.locale, label: language.label, summary: language.is_source ? 'Default' : language.status === 'published' ? 'Published' : 'Hidden',
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
        { id: 'translate-locations', label: organization.vertical === 'service' ? 'Translate offices' : 'Translate locations', native: 'location-translations', query: { locale: language.locale } },
        ...([['social_post', 'Posts'], ['article', 'Blog'], ['qa', 'Q&A'], ['links', 'Links']] as const).map(([kind, label]) => ({
          id: `translate-${kind}`, label: `Translate ${label}`, native: 'document-translations', query: { locale: language.locale, kind },
        })),
        { id: 'translate-categories', label: 'Translate blog categories', native: 'category-translations', query: { locale: language.locale } },
        ...progress.opportunities.map(item => ({ id: item.id, label: item.label, summary: `${item.completed} of ${item.total} translated` })),
        ...(editable ? [{ id: 'visibility', label: 'Website visibility', summary: language.status === 'published' ? 'Published' : 'Hidden', native: 'language-visibility', query: { locale: language.locale } }] : []),
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
    const currentDetails = isRecord(values.details) ? values.details : {}
    const definitions = item.type === 'product' ? productDetailFields(item.kind).filter(definition => definition.localizable) : []
    const lines = (value: unknown) => Array.isArray(value) ? value.join('\n') : value
    const fields = [
      field('name', 'Name', 'text', values.name, { hint: original.name, optional: true }),
      field('description', 'Description', 'textarea', values.description, { hint: original.description ?? undefined, optional: true }),
      ...(item.type === 'product' ? definitions.map(definition => {
        const source = lines(item.source.details[definition.key])
        return field(`detail:${definition.key}`, definition.name,
          definition.value_type === 'single_line_text' ? 'text' : 'textarea', lines(currentDetails[definition.key]), {
            hint: typeof source === 'string' ? source : undefined, optional: true,
          })
      }) : []),
    ]
    const revision = JSON.stringify([original, values])
    const screen = { title: original.name, rows: [], fields, revision, save_label: 'Save' }
    if (!answer) return screen
    if (isDemoOrganization(organization) && !await hasPlatformEventPermission(event, env, { platform: ['access'] })) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This translation changed. Reopen it before saving.' })
    const next = { ...values }
    const details = { ...currentDetails }
    for (const { key, value: shown } of fields) {
      const submitted = answer.values[key] ?? invalid('Missing translation field')
      if (submitted === shown) continue
      const value = submitted.trim()
      const definition = definitions.find(definition => key === `detail:${definition.key}`)
      const target = definition ? details : next
      const name = definition?.key ?? key
      if (value) target[name] = definition?.value_type === 'list.single_line_text'
        ? value.split('\n').map(line => line.trim()).filter(Boolean)
        : value
      else Reflect.deleteProperty(target, name)
    }
    if (Object.keys(details).length || Object.hasOwn(next, 'details')) next.details = details
    await putResourceLocalization(env, db, { organizationId: organization.id, resourceType: item.type, resourceId: item.id, locale: catalog.locale, values: next, userId })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (view === 'document-translations' || view === 'document-translation') {
    if (!isOrganizationWideRole(organization.role)) return missing('Content not found')
    const language = await assertOrganizationLanguage(db, organization.id, query.locale)
    if (language.source) return missing('Choose an additional language')
    const kind = query.kind
    if (kind !== 'article' && kind !== 'social_post' && kind !== 'qa' && kind !== 'links') return missing('Content kind not found')
    const links = kind === 'links' ? await getLinksPage(db, organization.id) : null
    const records = links ? links.page ? [{ id: links.page.id, title: links.page.title, summary: null, updated_at: links.page.updated_at, metadata_json: '{}' }] : []
      : await queryAll<{ id: string; title: string | null; summary: string | null; updated_at: string; metadata_json: string }>(db, `
        SELECT id, title, summary, updated_at, metadata_json FROM content_documents
        WHERE organization_id = ? AND kind = ? AND row_role = 'root' AND status = 'published'
          AND (kind <> 'qa' OR source = 'manual')
        ORDER BY sort_order, created_at, id
      `, [organization.id, kind])
    const title = kind === 'article' ? 'Blog' : kind === 'social_post' ? 'Posts' : kind === 'qa' ? 'Q&A' : 'Links'
    if (view === 'document-translations') {
      if (answer) return missing('Choose content to translate')
      return { title, fields: [], empty_title: 'No content to translate', rows: records.map(record => ({
        id: record.id, label: record.title || record.summary || title, native: 'document-translation',
        query: { locale: language.locale, kind, document_id: record.id },
      })) }
    }
    const record = records.find(item => item.id === query.document_id) ?? missing('Content not found')
    const representation = await getContentRepresentation(db, { rootId: record.id, locale: language.locale })
    const saved = representation ? await getLocalizationForAuthoring(env, db, organization.id, 'content_document', record.id, language.locale) : null
    if (saved && !('content_blocks' in saved)) throw new Error('The saved translation has no document blocks')
    const fields = [
      field('title', kind === 'qa' ? 'Question' : 'Title', 'text', saved?.title, { hint: record.title ?? undefined, optional: kind !== 'qa' }),
      ...(!links ? [field('summary', kind === 'qa' ? 'Answer' : kind === 'article' ? 'Excerpt' : 'Caption', 'textarea', saved?.summary, { hint: record.summary ?? undefined, optional: true })] : []),
    ]
    let blocks: ContentBlockInput[] | undefined
    const articleEdits: Array<{ key: string; path: Parameters<typeof writeBlogLocalizedText>[1]; data: Record<string, unknown>; required: boolean }> = []
    const metadata = JSON.parse(record.metadata_json) as Record<string, unknown>
    const button = isRecord(metadata.call_to_action) ? metadata.call_to_action : null
    const savedButton = isRecord(saved?.metadata?.call_to_action) ? saved.metadata.call_to_action : null
    if (kind === 'social_post' && button) fields.push(field('button', 'Link button label', 'text', savedButton?.label, { hint: typeof button.label === 'string' ? button.label : undefined, optional: true }))
    if (kind === 'article') {
      const source = await getContentDocumentById(db, record.id) ?? missing('Article not found')
      const snapshot = await getContentEditorSnapshotForDocument(db, source)
      blocks = saved ? structuredClone(saved.content_blocks) : snapshot.blocks.map(blankBlogLocalizedText)
      for (const [index, block] of snapshot.blocks.entries()) {
        const translated = blocks[index]
        if (!translated || translated.type !== block.type) throw new HTTPError({ statusCode: 409, message: 'The source article and translation have different sections.' })
        for (const item of blogLocalizedTextFields(block)) {
          const key = `content:${index}:${item.path.join('.')}`
          fields.push(field(key, `Section ${index + 1} · ${item.label}`, 'textarea', readBlogLocalizedText(translated.data, item.path), { hint: item.value }))
          articleEdits.push({ key, path: item.path, data: translated.data, required: Boolean(item.value.trim()) })
        }
      }
    } else if (links) {
      for (const item of links.items) {
        const translation = saved?.content_blocks.find(block => block.source_block_id === item.id)
        fields.push(field(`link:${item.id}`, 'Link label', 'text', translation?.data.label, { hint: item.label, optional: true }))
      }
    }
    const revision = JSON.stringify([record.updated_at, saved?.updated_at])
    const screen = { title: record.title || title, fields, rows: [], revision, save_label: 'Save' }
    if (!answer) return screen
    if (isDemoOrganization(organization) && !await hasPlatformEventPermission(event, env, { platform: ['access'] })) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The content changed. Reopen the translation before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this translation')
    for (const edit of articleEdits) {
      const value = answer.values[edit.key]!
      if (edit.required && !value.trim()) invalid('Translate every authored article field before saving')
      writeBlogLocalizedText(edit.data, edit.path, value)
    }
    if (links) blocks = links.items.flatMap(item => {
      const label = answer.values[`link:${item.id}`]!.trim()
      if (!label) return []
      const id = saved?.content_blocks.find(block => block.source_block_id === item.id)?.id
      return [{ id, source_block_id: item.id, type: 'cta' as const, data: { label } }]
    })
    const values = {
      title: answer.values.title?.trim() || null,
      summary: answer.values.summary?.trim() || null,
      ...(!links && kind !== 'qa' ? { seo_keywords: saved?.seo_keywords ?? null } : {}),
      ...(kind === 'social_post' && answer.values.button?.trim() ? { metadata: { call_to_action: { label: answer.values.button.trim() } } } : {}),
    }
    await putLocalizationForAuthoring(env, env.DB, { organizationId: organization.id, resourceType: 'content_document', resourceId: record.id, locale: language.locale, values, contentBlocks: blocks, expectedUpdatedAt: saved?.updated_at, userId })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (view === 'category-translations' || view === 'category-translation') {
    if (!isOrganizationWideRole(organization.role)) return missing('Blog categories not found')
    const language = await assertOrganizationLanguage(db, organization.id, query.locale)
    if (language.source) return missing('Choose an additional language')
    const categories = (await Promise.all([
      listArticleCategories(db, organization.id, 'blog'),
      ...(isPlatformSite({ themeId: organization.theme_id }) ? [listArticleCategories(db, organization.id, 'docs')] : []),
    ])).flat()
    if (view === 'category-translations') {
      if (answer) return missing('Choose a category')
      return { title: 'Blog categories', fields: [], empty_title: 'No categories to translate', rows: categories.map(category => ({
        id: category.id, label: category.name, native: 'category-translation', query: { locale: language.locale, category_id: category.id },
      })) }
    }
    const category = categories.find(item => item.id === query.category_id) ?? missing('Category not found')
    const saved = await findResourceLocalization(db, organization.id, 'article_category', category.id, language.locale)
    const values = saved?.values ?? {}
    const fields = [
      field('name', 'Name', 'text', values.name, { hint: category.name, optional: true }),
      field('description', 'Description', 'textarea', values.description, { hint: category.description ?? undefined, optional: true }),
    ]
    const revision = JSON.stringify([category.updated_at, saved?.updated_at])
    const screen = { title: category.name, fields, rows: [], revision, save_label: 'Save' }
    if (!answer) return screen
    if (isDemoOrganization(organization) && !await hasPlatformEventPermission(event, env, { platform: ['access'] })) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The category changed. Reopen the translation before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this translation')
    await putResourceLocalization(env, db, {
      organizationId: organization.id, resourceType: 'article_category', resourceId: category.id, locale: language.locale,
      values: Object.fromEntries(Object.entries(answer.values).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value)),
      userId,
    })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (view === 'location-translations' || view === 'location-translation') {
    if (!isOrganizationWideRole(organization.role)) return missing('Location not found')
    const language = await assertOrganizationLanguage(db, organization.id, query.locale)
    if (language.source) return missing('Choose an additional language')
    const locations = await listDashboardLocations(db, organization.id, undefined, true)
    if (view === 'location-translations') {
      if (answer) return missing('Choose a location')
      return { title: organization.vertical === 'service' ? 'Office translations' : 'Location translations', fields: [], rows: locations.map(location => ({
        id: location.id, label: location.title, native: 'location-translation', query: { locale: language.locale, location_id: location.id },
      })) }
    }
    const target = locations.find(location => location.id === query.location_id) ?? missing('Location not found')
    const location = await getLocation(env.DB, organization.id, target.id) ?? missing('Location not found')
    const saved = await findResourceLocalization(db, organization.id, 'business_location', location.id, language.locale)
    const values = saved?.values ?? {}
    const address = (values.address ?? {}) as Record<string, unknown>
    const fields = [
      field('title', 'Name', 'text', values.title, { hint: location.title, optional: true }),
      field('short_description', 'Short description', 'text', values.short_description, { hint: location.short_description ?? undefined, optional: true }),
      field('description', 'Description', 'textarea', values.description, { hint: location.description ?? undefined, optional: true }),
      field('seo_title', 'SEO title', 'text', values.seo_title, { hint: location.seo_title ?? undefined, optional: true }),
      field('seo_description', 'SEO description', 'textarea', values.seo_description, { hint: location.seo_description ?? undefined, optional: true }),
      ...([
        ['addressLines', 'Address lines'], ['locality', 'City'], ['sublocality', 'District'], ['administrativeArea', 'State or province'],
      ] as const).map(([key, label]) => {
        const original = location.address?.[key]
        const value = address[key]
        return field(`address.${key}`, label, key === 'addressLines' ? 'textarea' : 'text', Array.isArray(value) ? value.join('\n') : value, {
          optional: true, hint: Array.isArray(original) ? original.join('\n') : original ?? undefined,
        })
      }),
    ]
    const revision = JSON.stringify([location.updated_at, saved?.updated_at])
    const screen = { title: location.title, rows: [], fields, revision, save_label: 'Save' }
    if (!answer) return screen
    if (isDemoOrganization(organization) && !await hasPlatformEventPermission(event, env, { platform: ['access'] })) throw new HTTPError({ statusCode: 403, message: 'Demo organization is read-only' })
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This translation changed. Reopen it before saving.' })
    const next = { ...values }
    const nextAddress = { ...address }
    for (const { key } of fields) {
      const value = (answer.values[key] ?? invalid('Missing translation field')).trim()
      if (key.startsWith('address.')) {
        const name = key.slice('address.'.length)
        if (value) nextAddress[name] = name === 'addressLines' ? value.split('\n').map(line => line.trim()).filter(Boolean) : value
        else Reflect.deleteProperty(nextAddress, name)
      } else if (value) next[key] = value
      else Reflect.deleteProperty(next, key)
    }
    if (Object.keys(nextAddress).length) next.address = nextAddress
    else Reflect.deleteProperty(next, 'address')
    await putResourceLocalization(env, db, { organizationId: organization.id, resourceType: 'business_location', resourceId: location.id, locale: language.locale, values: next, userId })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (view === 'brand-translation') {
    if (!isOrganizationWideRole(organization.role)) return missing('Brand not found')
    const language = await assertOrganizationLanguage(db, organization.id, query.locale)
    if (language.source) return missing('Choose an additional language')
    const saved = await findResourceLocalization(db, organization.id, 'organization', organization.id, language.locale)
    const values = saved?.values ?? {}
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
  if (['inquiry-questions', 'inquiry-question', 'inquiry-question-order'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Inquiry form not found')
    const { questions, questions_revision: revision } = await readLocalizedFormQuestions(db, { kind: 'inquiry', organizationId: organization.id }, null)
    return await questionEditor(view, query, {}, 'Intake questions', questions, revision, answer, async next => {
      const result = await updateOrganizationSettingsFields(db, env, organization.id, {
        inquiry_questions: next, expected_inquiry_questions_revision: revision,
      }, userId)
      if (result.status >= 400) throw new HTTPError({ statusCode: result.status, message: String(result.data.error), data: result.data })
    })
  }
  if (view === 'article-categories' || view === 'article-category' || view === 'article-category-order') {
    if (!isOrganizationWideRole(organization.role)) return missing('Categories not found')
    const platform = isPlatformSite({ themeId: organization.theme_id })
    if (view === 'article-categories' && platform && query.collection === undefined) {
      if (answer) return invalid('Choose an article collection')
      return { title: 'Categories', fields: [], rows: ARTICLE_COLLECTION_SLUGS.map(collection => ({
        id: collection, label: ARTICLE_COLLECTIONS[collection].label, native: view, query: { collection },
      })) }
    }
    const collection = query.collection === undefined ? 'blog' : isArticleCollection(query.collection) ? query.collection : invalid('Choose an article collection')
    if (collection === 'docs' && !platform) return missing('Categories not found')
    const categories = await listArticleCategories(db, organization.id, collection)
    const base = { collection }
    if (view === 'article-categories') {
      if (answer) return invalid('Choose a category')
      const rows: CatalogRow[] = []
      const append = (parentId: string | null, depth: number) => {
        for (const category of categories.filter(row => row.parent_id === parentId)) {
          rows.push({ id: category.id, label: category.name, summary: depth ? categories.find(row => row.id === parentId)?.name : undefined,
            native: 'article-category', query: { ...base, category_id: category.id } })
          append(category.id, depth + 1)
        }
      }
      append(null, 0)
      rows.push({ id: 'add', label: 'Add a category', native: 'article-category', query: base })
      for (const parent of [null, ...categories]) {
        if (categories.filter(row => row.parent_id === (parent?.id ?? null)).length < 2) continue
        rows.push({ id: `order-${parent?.id ?? 'root'}`, label: parent ? `Reorder categories in ${parent.name}` : 'Reorder top-level categories',
          native: 'article-category-order', query: { ...base, ...(parent ? { parent_id: parent.id } : {}) } })
      }
      return { title: 'Categories', rows, fields: [] }
    }
    if (view === 'article-category-order') {
      const parent = query.parent_id === undefined ? null : categories.find(row => row.id === query.parent_id) ?? missing('Category not found')
      const rows = categories.filter(row => row.parent_id === (parent?.id ?? null))
      const ids = rows.map(row => row.id)
      const revision = JSON.stringify(rows.map(row => [row.id, row.updated_at]))
      const screen = { title: 'Reorder categories', rows: [], revision, save_label: 'Save', fields: [
        field('order', 'Categories', 'order', ids.join('\n'), { choices: rows.map(row => ({ value: row.id, label: row.name })) }),
      ] }
      if (!answer) return screen
      if (answer.revision !== revision) return invalid('The categories changed. Reopen them before saving.')
      await reorderArticleCategories(db, { organizationId: organization.id, collection, parentId: parent?.id, categoryIds: answer.values.order?.split('\n'), actorId: userId })
      await purgePublicResourceCacheNow(env, organization.id)
      return screen
    }
    const category = query.category_id === undefined ? null : categories.find(row => row.id === query.category_id) ?? missing('Category not found')
    const deleting = query.action === 'delete'
    if ((deleting || query.action === 'edit') && !category) return missing('Category not found')
    if (query.action !== undefined && !deleting && query.action !== 'edit') return missing('Category action not found')
    if (category && query.action === undefined) {
      if (answer) return invalid('Choose a category setting')
      return { title: category.name, fields: [], rows: [
        { id: 'edit', label: 'Category details', summary: category.description ?? undefined, native: view, query: { ...base, category_id: category.id, action: 'edit' } },
        { id: 'delete', label: 'Delete category', native: view, query: { ...base, category_id: category.id, action: 'delete' } },
      ] }
    }
    const excluded = new Set(category ? [category.id] : [])
    const excludeDescendants = (parentId: string) => {
      for (const child of categories.filter(row => row.parent_id === parentId)) {
        excluded.add(child.id)
        excludeDescendants(child.id)
      }
    }
    if (category) excludeDescendants(category.id)
    const choices = [{ value: '', label: 'Top level' }, ...categories.filter(row => !excluded.has(row.id)).map(row => ({ value: row.id, label: row.name }))]
    const revision = category?.updated_at ?? 'new'
    const screen = { title: deleting ? 'Delete category' : category?.name ?? 'New category', revision, rows: [],
      save_label: deleting ? 'Delete' : category ? 'Save' : 'Create',
      fields: deleting ? [field('confirm', `Delete ${category!.name}`, 'toggle', false)] : [
        field('name', 'Name', 'text', category?.name), field('description', 'Description', 'textarea', category?.description, { optional: true }),
        field('parent', 'Parent category', 'select', category?.parent_id, { choices, optional: true }),
      ],
    }
    if (!answer) return screen
    if (answer.revision !== revision) return invalid('The category changed. Reopen it before saving.')
    if (screen.fields.length !== Object.keys(answer.values).length || screen.fields.some(item => typeof answer.values[item.key] !== 'string')) return invalid('The saved fields do not match this editor')
    const input = { organizationId: organization.id, name: answer.values.name, description: answer.values.description || null, parentId: answer.values.parent || null, actorId: userId }
    if (deleting) {
      if (answer.values.confirm !== 'true') return invalid('Confirm deletion')
      await deleteArticleCategory(db, { organizationId: organization.id, categoryId: category!.id })
    } else if (category) await updateArticleCategory(db, { ...input, categoryId: category.id })
    else await createArticleCategory(db, { ...input, collection })
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['website-blog', 'website-posts', 'website-qa', 'website-content', 'post-destinations', 'post-publish', 'post-media', 'post-media-item', 'post-media-order'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Website content not found')
    const scope = { organizationId: organization.id, locationId: null }
    const kind = view === 'website-blog' ? 'article' : ['website-posts', 'post-destinations', 'post-publish', 'post-media', 'post-media-item', 'post-media-order'].includes(view) ? 'post' : view === 'website-qa' ? 'qa' : query.kind
    if (kind !== 'article' && kind !== 'post' && kind !== 'qa') return missing('Content not found')
    const title = kind === 'article' ? 'Blog' : kind === 'post' ? 'Social posts' : 'Q&A'
    const row = (id: string, label: string, summary?: string): CatalogRow => ({
      id, label, summary, native: 'website-content', query: { kind, ...(id === 'new' ? {} : { content_id: id }) },
    })
    if (['website-blog', 'website-posts', 'website-qa'].includes(view)) {
      if (answer) return missing('Choose content to edit')
      const cursor = typeof query.cursor === 'string' ? query.cursor : undefined
      const resource = { resource: `native-posts:${organization.id}` }
      const page = kind === 'article' ? await loadDashboardBlogPosts(event, organization.id, { cursor })
        : kind === 'post' ? await listPosts(db, env, organization.id, {}, mcpPageWindow(cursor ? { cursor } : {}, resource), resource)
        : null
      const rows = page ? page.posts.map(item => row(String(item.id), String(item.title || ('body' in item && item.body) || title), item.status === 'published' ? 'Published' : 'Draft'))
        : (await listQa(db, organization.id, null)).filter(item => item.source === 'manual').map(item => row(item.id, item.question, item.answer ?? undefined))
      return { title, fields: [], rows: [
        ...rows, row('new', kind === 'article' ? 'New article' : kind === 'post' ? 'New post' : 'Add a question'),
        ...(kind === 'article' ? [{ id: 'categories', label: 'Categories', native: 'article-categories' }] : []),
        ...(kind === 'qa' ? [{ id: 'reviews', label: 'Reviews', native: 'website-reviews' }] : []),
        ...(page?.page_info.next_cursor ? [{ id: 'more', label: 'More', native: view, query: { cursor: page.page_info.next_cursor } }] : []),
      ] }
    }
    const id = query.content_id === undefined ? null : typeof query.content_id === 'string' ? query.content_id : missing('Content not found')
    const article = kind === 'article' && id ? await getBlogPost(db, id, organization.id, env) ?? missing('Article not found') : null
    const post = kind === 'post' && id ? await getPost(db, env, organization.id, id) ?? missing('Post not found') : null
    if (post) await assertResourceAccess(db, { ...principal, resourceLocationId: post.location_id })
    if (['post-media', 'post-media-item', 'post-media-order'].includes(view)) {
      if (!post) return missing('Post not found')
      const row = (id: string, label: string, slot: 'cover' | 'gallery', asset?: typeof post.media[number]): CatalogRow => ({
        id, label, native: 'post-media-item', image: mediaStillUrl(asset),
        query: { content_id: post.id, slot, ...(asset ? { asset_id: asset.asset_id } : {}) },
      })
      const gallery = post.media.filter(item => item.slot === 'gallery')
      const cover = post.media.find(item => item.slot === 'cover')
      if (view === 'post-media') {
        if (answer) return missing('Choose a media placement')
        return { title: 'Post media', fields: [], rows: [
          row('cover', 'Cover', 'cover', cover),
          ...gallery.map((asset, index) => row(asset.asset_id, `Gallery item ${index + 1}`, 'gallery', asset)),
          row('add', 'Add to gallery', 'gallery'),
          ...(gallery.length > 1 ? [{ id: 'order', label: 'Reorder gallery', native: 'post-media-order', query: { content_id: post.id, slot: 'gallery' } }] : []),
        ] }
      }
      const slot = query.slot
      if (slot !== 'cover' && slot !== 'gallery') return missing('Media placement not found')
      const order = view === 'post-media-order'
      if (order && slot !== 'gallery') return missing('Gallery not found')
      const asset = slot === 'cover' ? cover : query.asset_id === undefined ? null
        : gallery.find(item => item.asset_id === query.asset_id) ?? missing('Media not found')
      const ids = gallery.map(item => item.asset_id)
      const title = order ? 'Reorder gallery' : slot === 'cover' ? 'Cover' : asset ? 'Gallery item' : 'Add to gallery'
      const revision = post.updated_at
      const screen = { title, revision, rows: [], fields: [
        order ? field('value', title, 'order', ids.join('\n'), {
          choices: gallery.map((item, index) => ({ value: item.asset_id, label: `Gallery item ${index + 1}`, image: mediaStillUrl(item) })),
        }) : field('value', title, 'photo', asset?.asset_id, { media_kind: 'any', playback_url: mediaPlaybackUrl(asset), display_url: mediaStillUrl(asset), optional: true }),
      ], save_label: 'Save' }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The post changed. Reopen it before saving.' })
      const value = answer.values.value ?? invalid('Missing media value')
      const input = { env, principal, organizationId: organization.id, placement: { owner_type: 'content_document' as const, owner_id: post.id, slot } }
      if (order) {
        const next = value.split('\n')
        if (next.length !== ids.length || new Set(next).size !== ids.length || !next.every(id => ids.includes(id))) invalid('Include each gallery item once')
        await reorderMediaPlacements(db, { ...input, expectedAssetIds: ids, moves: next.slice(1).map((asset_id, index) => ({ asset_id, after_asset_id: next[index]! })) })
      } else if (slot === 'cover') {
        await setSingleMediaPlacement(db, { ...input, assetId: value || null })
      } else if (asset && !value) {
        await removeMediaPlacement(db, { ...input, assetId: asset.asset_id })
      } else if (!asset && value) {
        await attachMediaPlacement(db, { ...input, assetId: value })
      } else if (asset && value !== asset.asset_id) return invalid('Add the new media before removing the old item')
      await purgePublicResourceCacheNow(env, organization.id)
      return screen
    }
    if (view === 'post-destinations' || view === 'post-publish') {
      if (!post) return missing('Post not found')
      const connections = await getSocialConnections(env, organization.id, { dashboardBase: dashboardOrigin(env, { orgSlug: organization.slug, locationSlug: null }) })
      const channels = [
        { channel: 'organization' as const, label: 'Website', status: post.status === 'published' ? 'Published' : undefined,
          target: { channel: 'organization' } as PublishTarget, destination: connections.website.label },
        ...connections.channels.map(connection => {
          const publication = post.publications.find(item => item.channel === connection.channel)
          const status = publication?.state === 'published' ? 'Published'
            : publication?.state === 'removed' ? 'Removed'
            : [connection.target_name, publication?.message, ...connection.problems.map(item => item.message)].filter(Boolean).join(' · ')
          const target: PublishTarget | null = !connection.problems.length && connection.target_id && connection.connection_revision
            && (!publication || publication.state === 'failed')
            ? { channel: connection.channel, target_id: connection.target_id, connection_revision: connection.connection_revision } : null
          const label = connection.channel === 'facebook' ? 'Facebook' : connection.channel === 'instagram' ? 'Instagram' : 'Discord'
          return { channel: connection.channel, label, status, target, destination: connection.target_name }
        }),
      ]
      const available = channels.filter(item => item.target && !(item.channel === 'organization' && post.status === 'published'))
      if (view === 'post-destinations') {
        if (answer) return missing('Choose a destination')
        return { title: 'Publishing', fields: [], rows: [
          ...channels.map(({ channel, label, status }) => ({ id: channel, label, summary: status || 'Ready to publish' })),
          ...(available.length ? [{ id: 'publish', label: 'Choose destinations', native: 'post-publish', query: { content_id: post.id } }] : []),
        ] }
      }
      const revision = JSON.stringify([post.updated_at, available.map(item => item.target)])
      const fields = available.map(item => field(item.channel, item.label, 'toggle', false, { hint: item.destination ?? undefined }))
      if (!fields.length) return missing('No publication destinations are available')
      const screen = { title: 'Publish to', fields, rows: [], revision, save_label: 'Publish' }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The post or destinations changed. Reopen them before publishing.' })
      if (fields.length !== Object.keys(answer.values).length || fields.some(item => !['true', 'false'].includes(answer.values[item.key]!))) invalid('Choose available destinations')
      const targets = available.flatMap(item => item.target && answer.values[item.channel] === 'true' ? [item.target] : [])
      if (!targets.length) return invalid('Choose where to publish')
      const result = await publishPost(env, organization.id, post.id, { expectedUpdatedAt: post.updated_at, targets }, userId)
      await purgePublicResourceCacheNow(env, organization.id)
      if (!result.ok) {
        const details = result.outcomes.map(outcome => {
          const label = channels.find(item => item.channel === outcome.channel)?.label ?? outcome.channel
          return `${label}: ${outcome.message ?? (outcome.status === 'published' || outcome.status === 'already_published' ? 'Published' : 'Publication failed')}`
        })
        throw new HTTPError({ statusCode: 422, message: details.join(' · '), data: { code: 'POST_PUBLICATION_INCOMPLETE', outcomes: result.outcomes } })
      }
      return screen
    }
    const qa = kind === 'qa' && id ? (await listQa(db, organization.id, null, false, null, undefined, id))
      .find(item => item.source === 'manual' && item.location_id === null) ?? missing('Question not found') : null
    const stored = article ?? post ?? qa
    const contentTitle = typeof article?.title === 'string' ? article.title : post?.title ?? qa?.question ?? ''
    const revision = typeof stored?.updated_at === 'string' ? stored.updated_at : 'new'
    const action = query.action
    if (action !== undefined && action !== 'edit' && action !== 'delete' && action !== 'publish') return missing('Content action not found')
    const categories = kind === 'article' ? await listArticleCategories(db, organization.id, articleCollectionOf(article?.collection)) : []
    const postLocations = kind === 'post' ? await listDashboardLocations(db, organization.id, undefined, true) : []
    const blocks: EditorContentBlock[] = article?.content_document.blocks ?? initialBlogEditorBlocks()
    const articleEdits = kind === 'article' ? blocks.flatMap((block, index) => blogLocalizedTextFields(block).map(item => ({
      ...item, block, key: `block:${index}:${item.path.join('.')}`,
    }))) : []
    const fields = action === 'publish' ? [field('visibility', 'Visibility', 'select', article?.visibility, { choices: [
      { value: 'listed', label: 'Listed' }, { value: 'unlisted', label: 'Unlisted' },
    ] })] : action === 'delete' ? [field('confirm', 'Confirm deletion', 'toggle', false)] : [
      field('title', kind === 'qa' ? 'Question' : 'Title', 'text', contentTitle, { optional: kind === 'post' }),
      ...(kind === 'article' ? [
        field('excerpt', 'Excerpt', 'textarea', article?.excerpt, { optional: true }),
        field('category', 'Category', 'select', article?.category?.id, { optional: true, choices: [{ value: '', label: 'Choose later' }, ...categories.map(item => ({ value: item.id, label: item.name }))] }),
        ...(!id ? articleEdits.map(item => field(item.key, item.label, 'textarea', item.value)) : []),
      ] : kind === 'post' ? [
        field('location', 'Location', 'select', post?.location_id, { optional: true, choices: [{ value: '', label: 'Whole website' }, ...postLocations.map(location => ({ value: location.id, label: location.title }))] }),
        field('body', 'Caption', 'textarea', post?.body),
        field('button_label', 'Button label', 'text', post?.call_to_action?.label, { optional: true }),
        field('button_url', 'Button URL', 'text', post?.call_to_action?.url, { optional: true }),
      ] : [
        field('answer', 'Answer', 'textarea', qa?.answer, { optional: true }),
        field('visible', 'Show on website', 'toggle', qa?.status !== 'hidden'),
      ]),
    ]
    if (id && action === undefined) {
      if (answer) return missing('Choose a content setting')
      const preview = article ? article.preview_url ?? article.public_url : post?.preview_url ?? post?.canonical_url
      return { title: contentTitle || title, fields: [], preview_url: typeof preview === 'string' ? preview : null, rows: [
        { id: 'edit', label: article ? 'Article details' : 'Edit content', native: view, query: { kind, content_id: id, action: 'edit' } },
        ...(article ? [{ id: 'sections', label: 'Article blocks', native: 'page-sections', query: { article_id: id } }] : []),
        ...(post ? [
          { id: 'media', label: 'Media', native: 'post-media', query: { content_id: id } },
          { id: 'destinations', label: 'Publish to', native: 'post-destinations', query: { content_id: id } },
        ] : []),
        ...(article ? [{ id: 'publish', label: 'Visibility', summary: article.status === 'draft' ? 'Draft' : article.visibility === 'unlisted' ? 'Unlisted' : 'Published', native: view, query: { kind, content_id: id, action: 'publish' } }] : []),
        { id: 'delete', label: 'Delete', native: view, query: { kind, content_id: id, action: 'delete' } },
      ] }
    }
    if ((action === 'delete' || action === 'publish') && (!stored || !id || (action === 'publish' && !article))) return missing('Content not found')
    const screen = { title: action === 'publish' ? 'Visibility' : contentTitle || title, fields, rows: [], revision,
      allow_unchanged: action === 'publish' && article?.status === 'draft',
      save_label: action === 'publish' && article?.status === 'draft' ? 'Publish' : action === 'delete' ? 'Delete' : 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The content changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this editor')
    const values = answer.values
    try {
      if (action === 'delete') {
        if (values.confirm !== 'true') return invalid('Confirm deletion')
        if (article) await deleteBlogPost(db, id!, organization.id)
        else if (post) await deletePost(db, organization.id, id!, userId)
        else if (qa) await deleteQa(db, { ...scope, pagePath: qa.page_path }, id!)
      } else if (action === 'publish') {
        const visibility = values.visibility
        if (visibility !== 'listed' && visibility !== 'unlisted') return invalid('Choose article visibility')
        if (!article || !id) return missing('Article not found')
        if (article.status === 'draft' && !article.category) return invalid('Choose a category before publishing')
        const changed = visibility !== article.visibility
          ? await updateBlogPost(db, id, { visibility, updated_at: revision }, organization.id, userId, env)
          : null
        if (article.status === 'draft') await updateBlogLifecycle(db, id, { updated_at: changed?.post.updated_at ?? revision }, organization.id, userId)
      } else if (kind === 'article') {
        for (const edit of id ? [] : articleEdits) writeBlogLocalizedText(edit.block.data, edit.path, values[edit.key]!)
        const content = {
          title: values.title!, excerpt: values.excerpt || null,
          ...(values.category ? { category_id: values.category } : {}),
          ...(id ? {} : { content_blocks: blocks as ContentBlockInput[] }),
        }
        if (article) await updateBlogPost(db, id!, { ...content, updated_at: revision }, organization.id, userId, env)
        else await createBlogPost(db, userId, { ...content, content_blocks: blocks as ContentBlockInput[], idempotency_key: answer.idempotency_key }, { organization_id: organization.id }, env)
      } else if (kind === 'post') {
        const locationId = values.location || null
        await assertResourceAccess(db, { ...principal, resourceLocationId: locationId })
        const changes = {
          location_id: locationId,
          title: values.title || null, body: values.body || null,
          call_to_action: values.button_label || values.button_url ? { label: values.button_label, url: values.button_url } : null,
        }
        if (post) await updatePost(db, env, organization.id, post.id, { changes, expectedUpdatedAt: revision }, userId)
        else await createPost(db, env, organization.id, { post: changes, idempotencyKey: answer.idempotency_key }, userId)
      } else {
        const data = { question: values.title, answer: values.answer || null, status: values.visible === 'true' ? 'published' : 'hidden' }
        if (qa) await updateQa(db, { ...scope, pagePath: qa.page_path }, qa.id, data, session.user)
        else await createQa(db, scope, data, session.user)
      }
    } catch (error) {
      if (error instanceof PostValidationError) throw new HTTPError({ statusCode: error.statusCode, message: error.message })
      throw error
    }
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['website-domains', 'website-domain', 'website-domain-action'].includes(view)) {
    const actorType = organization.role
    if (actorType !== 'owner' && actorType !== 'admin') return missing('Domains not found')
    const actor = { organizationId: organization.id, organizationSlug: organization.slug, actorId: userId, actorType } as const
    const payload = await getOrganizationDomainsDashboardPayload(db, organization.id)
    const included = payload.domains.find(domain => domain.type === 'subdomain')
    const canConnect = await hasOrganizationEntitlement(env, organization.id, 'custom_domains')
    if (view === 'website-domains') {
      if (answer) return missing('Choose a domain')
      return { title: 'Domains', fields: [], rows: [
        ...(included ? [{ id: included.id, label: included.domain, summary: 'Included address' }] : []),
        ...payload.domain_groups.map(group => ({
          id: group.id, label: group.domain, summary: group.role === 'canonical' && group.status === 'active' ? 'Primary' : group.status,
          native: 'website-domain', query: { domain_id: group.id },
        })),
        ...(canConnect ? [{ id: 'connect', label: 'Connect domain', native: 'website-domain-action', query: { action: 'connect' } }]
          : [{ id: 'plan', label: 'Custom domains require a paid plan' }]),
      ] }
    }
    const action = query.action
    const group = payload.domain_groups.find(item => item.id === query.domain_id)
    if (view === 'website-domain') {
      if (!group || answer) return missing('Domain not found')
      const row = (action: string, label: string): CatalogRow => ({
        id: action, label, native: 'website-domain-action', query: { action, domain_id: group.id },
      })
      return { title: group.domain, fields: [], rows: [
        ...group.records.map((record, index) => ({ id: `dns-${index}`, label: `${record.type} · ${record.name}`, summary: record.value })),
        ...[group.warning, group.error].flatMap((message, index) => message ? [{ id: `notice-${index}`, label: message }] : []),
        ...(group.primary_domain_id && group.status !== 'deleted' ? [row('synced', 'Check connection')] : []),
        ...(group.status === 'active' && group.role !== 'canonical' ? [row('primary', 'Make primary')] : []),
        row('deleted', 'Remove domain'),
      ] }
    }
    if (action !== 'connect' && action !== 'synced' && action !== 'primary' && action !== 'deleted') return missing('Domain action not found')
    const connecting = action === 'connect'
    if (connecting && !canConnect) throw new HTTPError({ statusCode: 403, message: 'Custom domains require a paid plan.' })
    if (!connecting && !group) return missing('Domain not found')
    const title = connecting ? 'Connect domain' : action === 'synced' ? 'Check connection' : action === 'primary' ? 'Make primary' : 'Remove domain'
    const revision = connecting ? 'new' : JSON.stringify(group!.domains.map(domain => [domain.id, domain.role, domain.status, domain.updated_at]))
    const fields = connecting ? [
      field('domain', 'Domain', 'text', ''),
      field('www', 'Include www', 'toggle', true),
      field('cutover', 'Allow moving a domain that already points elsewhere', 'toggle', false),
    ] : [field('confirm', `${title} · ${group!.domain}`, 'toggle', false)]
    const screen = { title, fields, rows: [], revision, save_label: title }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This domain changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this editor')
    if (connecting) {
      const domain = answer.values.domain!.trim() || invalid('Enter a domain')
      await connectDashboardDomain(env, db, actor, domain, answer.values.www === 'true', answer.values.cutover === 'true')
    } else {
      if (answer.values.confirm !== 'true') return invalid('Confirm the domain change')
      const domain = group!.domains.find(item => item.id === group!.primary_domain_id)
      if (action === 'deleted') {
        for (const member of group!.domains.filter(item => item.status !== 'deleted')) {
          await changeDashboardDomain(env, db, actor, member, action)
        }
      } else if (domain && action === 'primary' && domain.status === 'active') {
        await setCanonicalDomain(db, organization.id, domain.id, actorType, userId)
      } else if (domain && action === 'synced' && domain.status !== 'deleted') {
        await changeDashboardDomain(env, db, actor, domain, action)
      } else return invalid('This action is unavailable for the domain')
    }
    return screen
  }
  if (view === 'website-reviews' || view === 'website-review') {
    if (!isOrganizationWideRole(organization.role)) return missing('Reviews not found')
    const reviews = await listOrganizationReviews(db, organization.id)
    if (view === 'website-reviews') {
      if (answer) return missing('Choose a review')
      return { title: 'Reviews', fields: [], rows: reviews.map(review => ({
        id: String(review.id), label: String(review.title || review.author_name || 'Review'), summary: String(review.status),
        native: 'website-review', query: { review_id: String(review.id) },
      })) }
    }
    const review = reviews.find(item => item.id === query.review_id) ?? missing('Review not found')
    const title = String(review.title || review.author_name || 'Review')
    if (review.status === 'private') {
      if (answer) return invalid('This guest shared their review privately')
      return { title, fields: [], rows: [{ id: 'private', label: 'Private feedback', summary: String(review.private_feedback ?? '') }] }
    }
    const revision = String(review.updated_at)
    const screen = { title, fields: [field('status', 'Visibility', 'select', review.status, {
      hint: typeof review.content === 'string' ? review.content : undefined,
      choices: [{ value: 'approved', label: 'Show on website' }, { value: 'rejected', label: 'Hide' }],
    })], rows: [], revision, save_label: 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This review changed. Reopen it before saving.' })
    await setReviewStatus(db, organization.id, String(review.id), answer.values.status)
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['website-brand', 'website-brand-field', 'website-seo', 'website-currency', 'website-announcement', 'website-colors'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Brand not found')
    const settings = await loadSettingsPayload(db, env, organization.id)
    const descriptors = [
      field('name', 'Name', 'text', settings.name),
      field('brand_description', 'Description', 'textarea', settings.brand_description, { optional: true }),
      field('contact_email', 'Contact email', 'text', settings.contact_email, { optional: true }),
      field('font_preset', 'Website font', 'select', settings.font_preset, { choices: [...ORGANIZATION_FONT_OPTIONS] }),
      ...(['logo', 'logo_dark', 'favicon', 'social_share'] as const).map((slot, index) => {
        const asset = settings.media.find(item => item.slot === slot)
        return field(slot, ['Logo', 'Dark logo', 'Favicon', 'Sharing image'][index]!, 'photo', asset?.asset_id, { optional: true, display_url: mediaStillUrl(asset) })
      }),
    ]
    if (view === 'website-brand') {
      if (answer) return missing('Choose a brand setting')
      return { title: 'Brand', fields: [], rows: descriptors.map(item => ({
        id: item.key, label: item.label, summary: item.kind === 'photo' ? undefined : item.value || undefined,
        image: item.display_url, native: 'website-brand-field', query: { field: item.key },
      })).concat([
        { id: 'announcement', label: 'Announcement', summary: settings.announcement?.headline ?? undefined, image: undefined, native: 'website-announcement', query: { field: 'announcement' } },
        ...(settings.palette ? [{ id: 'colors', label: 'Colors', summary: settings.palette_source ?? undefined, image: undefined, native: 'website-colors', query: { field: 'colors' } }] : []),
      ]) }
    }
    const seo = view === 'website-seo'
    const currency = view === 'website-currency'
    const announcement = view === 'website-announcement'
    const colors = view === 'website-colors'
    const palette = colors ? settings.palette ?? missing('This website has fixed colors') : null
    const announcementMedia = announcement ? settings.media.find(item => item.slot === 'announcement') : null
    const fields = announcement ? [
      field('enabled', 'Show announcement', 'toggle', settings.announcement?.enabled === true),
      field('headline', 'Headline', 'text', settings.announcement?.headline, { optional: true }),
      field('description', 'Description', 'textarea', settings.announcement?.description, { optional: true }),
      field('cta_label', 'Button label', 'text', settings.announcement?.cta_label, { optional: true }),
      field('cta_url', 'Button URL', 'text', settings.announcement?.cta_url, { optional: true }),
      field('format', 'Format', 'select', settings.announcement?.format ?? 'modal', { choices: [{ value: 'modal', label: 'Popup' }, { value: 'banner', label: 'Banner' }] }),
      field('dismissible', 'Allow visitors to dismiss', 'toggle', settings.announcement?.dismissible !== false),
      field('image', 'Image', 'photo', announcementMedia?.asset_id, { optional: true, display_url: mediaStillUrl(announcementMedia) }),
    ] : palette ? [
      ...SITE_PALETTE_MODES.flatMap(mode => SITE_PALETTE_ROLES.map(role => field(`${mode}.${role.role}`, `${role.label} (${mode})`, 'text', palette[mode][role.role], { hint: role.rule }))),
      field('reset', 'Restore default colors', 'toggle', false),
    ] : seo ? [
      field('seo_title', 'Search title', 'text', settings.seo_title, { optional: true }),
      field('seo_description', 'Search description', 'textarea', settings.seo_description, { optional: true }),
      field('canonical_url', 'Canonical URL', 'text', settings.canonical_url, { optional: true }),
    ] : currency ? [
      field('default_currency', 'Currency', 'select', settings.default_currency, { choices: CURRENCY_OPTIONS }),
    ] : [descriptors.find(item => item.key === query.field) ?? missing('Brand setting not found')]
    const item = fields[0]!
    const revision = JSON.stringify(fields.map(item => [item.key, item.value]))
    const screen = { title: announcement ? 'Announcement' : colors ? 'Colors' : seo ? 'Search engine optimization' : item.label, fields, rows: [], revision, save_label: 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The brand setting changed. Reopen it before saving.' })
    const value = answer.values[item.key] ?? invalid('Missing brand value')
    if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this editor')
    const values = answer.values
    const format = values.format === 'banner' ? 'banner' : 'modal'
    const patch: UpdateOrganizationSettingsRequest = announcement ? {
      announcement: values.enabled === 'false' && !values.headline?.trim() ? null : {
        enabled: values.enabled === 'true', headline: values.headline!, description: values.description || null,
        cta_label: values.cta_label || null, cta_url: values.cta_url || null, dismissible: values.dismissible === 'true', format,
      },
      ...(values.image !== announcementMedia?.asset_id ? { media: [{ slot: 'announcement', asset_id: values.image || null }] } : {}),
    } : colors ? {
      palette: values.reset === 'true' ? null : Object.fromEntries(SITE_PALETTE_MODES.map(mode => [
        mode, Object.fromEntries(SITE_PALETTE_ROLES.map(({ role }) => [role, values[`${mode}.${role}`]])),
      ])) as SitePalettePatch,
    } : seo
      ? Object.fromEntries(fields.map(item => [item.key, answer.values[item.key]!.trim() || null]))
      : item.kind === 'photo'
        ? { media: [{ slot: item.key as 'logo' | 'logo_dark' | 'favicon' | 'social_share', asset_id: value || null }] }
        : { [item.key]: value }
    if (item.key === 'font_preset' && !isOrganizationFontPreset(value)) return invalid('Choose a website font')
    const result = await updateOrganizationSettingsFields(db, env, organization.id, patch, userId)
    if (result.status >= 400) throw new HTTPError({ statusCode: result.status, message: String(result.data.error), data: result.data })
    return screen
  }
  if (['links-page', 'links-title', 'links-item', 'links-order'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Links page not found')
    const { page, items } = await getLinksPage(db, organization.id)
    const adding = query.link_id === undefined
    if (view === 'links-page') {
      if (answer) return missing('Choose a link or setting')
      return { title: page?.title ?? 'Links', fields: [], rows: [
        { id: 'title', label: page ? 'Title' : 'Create links page', summary: page?.title, native: 'links-title' },
        ...items.map(item => ({ id: item.id, label: item.label, summary: item.status === 'hidden' ? 'Hidden' : item.destination, native: 'links-item', query: { link_id: item.id } })),
        ...(page ? [{ id: 'add', label: 'Add a link', native: 'links-item' }] : []),
        ...(items.length > 1 ? [{ id: 'order', label: 'Reorder links', native: 'links-order' }] : []),
      ] }
    }
    const title = view === 'links-title'
    const order = view === 'links-order'
    if (!title && !page) return missing('Create the links page first')
    const item = title || order || adding ? null : items.find(item => item.id === query.link_id) ?? missing('Link not found')
    const fields = title ? [field('title', 'Title', 'text', page?.title)] : order ? [
      field('order', 'Order', 'order', items.map(item => item.id).join('\n'), { choices: items.map(item => ({ value: item.id, label: item.label })) }),
    ] : [
      field('label', 'Label', 'text', item?.label),
      field('destination', 'Destination', 'text', item?.destination),
      field('visible', 'Show on links page', 'toggle', item?.status !== 'hidden'),
      ...(item ? [field('remove', 'Remove link', 'toggle', false)] : []),
    ]
    const revision = page?.updated_at ?? 'new'
    const screen = { title: title ? 'Links page title' : order ? 'Reorder links' : item?.label ?? 'Add a link', fields, rows: [], revision, save_label: 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The links page changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this editor')
    let next: Parameters<typeof upsertLinksPage>[1]['items'] = items
    if (order) {
      const ids = answer.values.order!.split('\n')
      if (new Set(ids).size !== items.length || ids.length !== items.length) return invalid('Include each link once')
      next = ids.map((id, sort_order) => ({ ...(items.find(item => item.id === id) ?? invalid('Link not found')), sort_order }))
    } else if (!title) {
      const visible = answer.values.visible
      if (visible !== 'true' && visible !== 'false') return invalid('Choose On or Off')
      const update = { label: answer.values.label, destination: answer.values.destination, status: visible === 'true' ? 'active' : 'hidden' }
      next = !item ? [...items, { ...update, sort_order: items.length }]
        : answer.values.remove === 'true' ? items.filter(row => row.id !== item.id)
        : items.map(row => row.id === item.id ? { ...row, ...update } : row)
    }
    try {
      await upsertLinksPage(db, {
        organizationId: organization.id, page: { title: title ? answer.values.title : page!.title },
        items: next, updatedBy: userId, expectedUpdatedAt: page?.updated_at,
      })
    } catch (error) {
      if (error instanceof OrganizationLinksValidationError) return invalid(error.message)
      throw error
    }
    await purgePublicResourceCacheNow(env, organization.id)
    return screen
  }
  if (['pages', 'page', 'page-add', 'page-delete', 'page-content', 'page-sections', 'page-order', 'page-section-add', 'page-section-remove', 'page-media', 'page-media-item', 'page-media-order', 'page-records', 'page-record', 'page-record-order', 'page-settings', 'page-calculator'].includes(view)) {
    if (!isOrganizationWideRole(organization.role)) return missing('Page not found')
    const scope = { organizationId: organization.id }
    const locale = typeof query.locale === 'string' ? query.locale : undefined
    if (view === 'pages') {
      if (answer) return missing('Choose a page to edit')
      const pages = (await listTenantPages(db, organization.id)).filter(page => page.recipe !== 'links')
      return { title: 'Pages', fields: [], rows: [...pages.map(page => ({
        id: page.id, label: page.title, summary: page.path, native: locale ? 'page-content' : 'page',
        query: { page_id: page.id, ...(locale ? { locale } : {}) },
      })), ...(!locale ? [{ id: 'links', label: 'Links', native: 'links-page', query: {} }, { id: 'add', label: 'Add a page', native: 'page-add', query: {} }] : [])] }
    }
    if (view === 'page-add') {
      if (locale) return missing('Create the source page first')
      const screen = { title: 'Add a page', fields: [field('title', 'Title', 'text', '')], rows: [], revision: 'new', save_label: 'Create' }
      if (!answer) return screen
      if (answer.revision !== screen.revision) return invalid('Open the new page editor')
      const title = (answer.values.title ?? '').trim()
      const slug = slugifyTitle(title)
      if (!slug) return invalid('Choose a more specific page title')
      await createTenantPage(db, { organizationId: organization.id, userId, env, data: {
        title, path: `/${slug}`, page_type: 'custom', recipe: null, blocks: [],
      } })
      return screen
    }
    const articleId = typeof query.article_id === 'string' ? query.article_id : null
    if (articleId && (query.page_id !== undefined || locale || ['page', 'page-content', 'page-delete'].includes(view))) return missing('Article blocks not found')
    const article = articleId ? await getBlogPost(db, articleId, organization.id, env) : null
    const page = article ? null : await getTenantPageById(db, typeof query.page_id === 'string' ? query.page_id : missing('Choose a page'), scope)
    const source = article ? {
      id: String(article.id), blocks: article.content_document.blocks as TenantPageBlock[], document: article.content_document.document,
    } : page!
    const documentQuery: Record<string, string> = article ? { article_id: source.id } : { page_id: source.id }
    const platform = isPlatformSite({ themeId: organization.theme_id })
    const editFields = (
      data: Record<string, unknown>, definitions: Readonly<Record<string, TenantPageField>>, prefix = '',
    ): { fields: CatalogField[]; write: (values: Record<string, string>) => void } => {
      const edits = Object.entries(definitions).flatMap(([key, item]) => {
        if (item.kind === 'record' && item.of) {
          const stored = data[key]
          const record = isRecord(stored) ? { ...stored } : {}
          const nested = editFields(record, item.of, `${prefix}${key}.`)
          return [{ fields: nested.fields, write: (values: Record<string, string>) => {
            nested.write(values)
            if (Object.keys(record).length) data[key] = record
            else Reflect.deleteProperty(data, key)
          } }]
        }
        if (item.kind === 'reference' || item.kind === 'media' || item.kind === 'calculator' || (item.kind === 'list' && item.of)) return []
        const value = data[key]
        const choices = item.options?.filter(option => !option.platformOnly || platform || option.value === value)
        if (choices?.length === 0) return []
        const input = field(`${prefix}${key}`, item.label,
          choices ? 'select' : item.kind === 'number' ? 'number' : item.kind === 'markdown' || item.kind === 'list' || item.multiline ? 'textarea' : 'text',
          Array.isArray(value) ? value.join('\n') : value ?? item.default, { optional: !item.required, choices })
        return [{ fields: [input], write: (values: Record<string, string>) => {
          const submitted = values[input.key]!
          if (submitted === input.value) return
          if (choices && (submitted || item.required) && !choices.some(option => option.value === submitted)) return invalid(`Choose an available value for ${item.label}`)
          if (item.kind === 'list') {
            data[key] = submitted.split('\n').map(line => line.trim()).filter(Boolean)
          } else if (!submitted.trim() && !item.required && item.store !== 'level') {
            Reflect.deleteProperty(data, key)
          } else if (item.kind === 'number' || item.store === 'level') {
            const number = Number(submitted)
            if (!submitted.trim() || !Number.isFinite(number) || (item.min !== undefined && number < item.min) || (item.max !== undefined && number > item.max)) {
              return invalid(`Enter a valid number for ${item.label}`)
            }
            data[key] = number
          } else {
            data[key] = submitted
          }
        } }]
      })
      return { fields: edits.flatMap(edit => edit.fields), write: values => {
        for (const edit of edits) edit.write(values)
      } }
    }
    const blockFields = (block: TenantPageBlock, definitions: Record<string, TenantPageField>) => {
      const level = { level: block.level }
      const controls = editFields(block.data, Object.fromEntries(Object.entries(definitions).filter(([, item]) => item.store !== 'level')))
      const heading = editFields(level, Object.fromEntries(Object.entries(definitions).filter(([, item]) => item.store === 'level')))
      return { fields: [...controls.fields, ...heading.fields], write: (values: Record<string, string>) => {
        controls.write(values)
        heading.write(values)
        block.level = level.level
      } }
    }
    const references = async (block: TenantPageBlock, registry = TENANT_PAGE_BLOCK_REGISTRY[block.type].fields) => {
      const definitions = Object.entries(registry).filter(([, item]) => item.reference)
      const types = new Set(definitions.map(([, item]) => item.reference))
      const [pages, products, collections, locations] = await Promise.all([
        types.has('page') ? listTenantPages(db, organization.id) : [],
        types.has('product') ? listOrganizationProducts(db, scope) : [],
        types.has('collection') ? listCollections(db, scope) : [],
        types.has('location') ? listDashboardLocations(db, organization.id, undefined, true) : [],
      ])
      const choices = {
        page: pages.filter(page => page.id !== source.id).map(page => ({ value: page.id, label: page.title })),
        product: products.map(product => ({ value: product.id, label: product.name })),
        collection: collections.map(collection => ({ value: collection.id, label: collection.name })),
        location: locations.map(location => ({ value: location.id, label: location.title })),
      }
      const fields = definitions.flatMap(([key, item]) => {
        const options = choices[item.reference!]
        if (!key.endsWith('_ids')) return [field(`ref:${key}`, item.label, 'select', block.data[key], {
          choices: [{ value: '', label: item.reference === 'location' ? 'All locations' : 'None' }, ...options],
        })]
        const saved = block.data[key]
        return options.map(option => field(`ref:${key}:${option.value}`, option.label, 'toggle', Array.isArray(saved) && saved.includes(option.value), { hint: item.label }))
      })
      return { fields, write(values: Record<string, string>) {
        for (const [key, item] of definitions) {
          const options = choices[item.reference!]
          if (key.endsWith('_ids')) {
            const enabled = options.filter(option => values[`ref:${key}:${option.value}`] === 'true').map(option => option.value)
            const saved = block.data[key]
            const kept = Array.isArray(saved) ? saved.filter(id => enabled.includes(id)) : []
            block.data[key] = [...kept, ...enabled.filter(id => !kept.includes(id))]
          } else {
            const value = values[`ref:${key}`]
            if (value && !options.some(option => option.value === value)) invalid(`Choose an available ${item.label.toLowerCase()}`)
            if (value) block.data[key] = value
            else Reflect.deleteProperty(block.data, key)
          }
        }
      } }
    }
    const saveBlocks = (blocks = source.blocks) => article
      ? updateBlogPost(db, source.id, { updated_at: source.document.updated_at, content_blocks: blocks }, organization.id, userId, env)
      : updateTenantPage(db, source.id, { userId, scope, env, data: {
        path: page!.path, title: page!.title, summary: page!.summary, page_type: page!.page_type,
        recipe: page!.recipe, sort_order: page!.sort_order, updated_at: source.document.updated_at, blocks,
      } })
    const removable = async () => (await listTenantPages(db, organization.id)).find(page => page.id === source.id)?.removable === true
    if (view === 'page-delete') {
      if (locale || !await removable()) return missing('This page cannot be removed')
      const revision = source.document.updated_at
      const screen = { title: 'Delete page', fields: [field('confirm', `Delete ${page!.title}`, 'toggle', false)], rows: [], revision, save_label: 'Delete' }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This page changed. Reopen it before deleting.' })
      if (answer.values.confirm !== 'true') return invalid('Confirm deletion')
      await deleteTenantPage(db, source.id, { scope, expectedUpdatedAt: revision, env })
      return screen
    }
    if (view === 'page-calculator') {
      if (locale) return missing('Edit the calculator in the source language')
      const block = source.blocks.find(block => block.id === query.block_id) ?? missing('Section not found')
      if (!tenantPageBlockFieldsForSection(block, 'calculator').some(({ field }) => field.kind === 'calculator')) return missing('Calculator not found')
      const config = pricingCalculatorConfig(block.data.calculator)
      const rows = pricingCalculatorRows(config)
      const base = { ...documentQuery, block_id: block.id }
      if (!answer && query.row === undefined) {
        return { title: 'Calculator', fields: [], rows: [
          { id: 'note', label: 'Note', summary: String(config.note ?? ''), native: view, query: { ...base, row: 'note' } },
          ...rows.map((row, index) => ({
            id: String(index), label: `Household size ${row[0] ?? index + 1}`, native: view, query: { ...base, row: String(index) },
          })),
          { id: 'add', label: 'Add a row', native: view, query: { ...base, row: 'new' } },
        ] }
      }
      const note = query.row === 'note'
      const adding = query.row === 'new'
      const index = typeof query.row === 'string' && /^\d+$/.test(query.row) ? Number(query.row) : -1
      const row = adding ? [rows.length + 1, '', '', ''] : note ? [] : rows[index] ?? missing('Calculator row not found')
      const fields = note ? [field('note', 'Note', 'text', config.note, { optional: true })] : [
        ...PRICING_CALCULATOR_COLUMNS.map((label, column) => field(String(column), label, column ? 'money' : 'number', row[column])),
        ...(!adding ? [field('remove', 'Remove row', 'toggle', false)] : []),
      ]
      const revision = source.document.updated_at
      const screen = { title: note ? 'Note' : adding ? 'Add a row' : 'Calculator row', fields, rows: [], revision, save_label: 'Save' }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The calculator changed. Reopen it before saving.' })
      if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this calculator')
      if (!note) {
        if (answer.values.remove === 'true') {
          rows.splice(index, 1)
        } else {
          const next = PRICING_CALCULATOR_COLUMNS.map((_, column) => answer.values[String(column)]!.trim())
          if (!/^[1-8]$/.test(next[0]!)) return invalid('Enter a household size from 1 to 8')
          if (adding) rows.push(next)
          else rows[index] = next
        }
      }
      block.data.calculator = updatePricingCalculator(config, rows, note ? answer.values.note! : String(config.note ?? ''))
      await saveBlocks()
      return screen
    }
    if (view === 'page-settings') {
      if (locale) return missing('Edit section settings in the source language')
      const block = source.blocks.find(block => block.id === query.block_id) ?? missing('Section not found')
      const section = tenantPageBlockSections(block).find(item => item.key === query.section && item.kind === 'leaf') ?? missing('Section settings not found')
      const entries = tenantPageBlockFieldsForSection(block, section.key).map(({ key, field }) => [key, field] as const)
      const definitions = Object.fromEntries(entries)
      const reference = await references(block, definitions)
      const controls = blockFields(block, definitions)
      const fields = [...controls.fields, ...reference.fields]
      const revision = source.document.updated_at
      const screen = { title: section.label, rows: [], fields, revision, save_label: 'Save' }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The page changed. Reopen the section before saving.' })
      if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this section')
      controls.write(answer.values)
      reference.write(answer.values)
      const problem = validateTenantPageBlock(block)[0]
      if (problem) return invalid(problem)
      await saveBlocks()
      return screen
    }
    if (view === 'page-records' || view === 'page-record' || view === 'page-record-order') {
      if (locale) return missing('Edit section records in the source language')
      const block = source.blocks.find(block => block.id === query.block_id) ?? missing('Section not found')
      const collection = Object.keys(TENANT_PAGE_RECORD_NOUNS).find(key => key === query.collection) as TenantPageBlockCollection | undefined
      const definition = collection ? TENANT_PAGE_BLOCK_REGISTRY[block.type].fields[collection] : undefined
      if (!collection || !definition?.of || !tenantPageBlockSections(block).some(section => section.collection === collection)) {
        return missing('Section records not found')
      }
      const value = block.data[collection]
      if (value !== undefined && (!Array.isArray(value) || !value.every(isRecord))) throw new Error('Section records are invalid')
      const records = (value ?? []) as Record<string, unknown>[]
      const copy = TENANT_PAGE_RECORD_NOUNS[collection]
      const row = (id: string, label: string, native: string, extra: Record<string, string> = {}): CatalogRow => ({
        id, label, native, query: { ...documentQuery, block_id: block.id, collection, ...extra },
      })
      if (view === 'page-records') {
        if (answer) return missing('Choose a record')
        return { title: definition.label, fields: [], rows: [
          ...records.map((record, index) => row(String(index), tenantPageRecordTitle(record, block.type, collection, index), 'page-record', { index: String(index) })),
          row('add', copy.add, 'page-record'),
          ...(records.length > 1 ? [row('order', 'Reorder', 'page-record-order')] : []),
        ] }
      }
      const order = view === 'page-record-order'
      const adding = !order && query.index === undefined
      const index = adding || order ? -1 : typeof query.index === 'string' && /^\d+$/.test(query.index) ? Number(query.index) : missing('Record not found')
      const record = adding || order ? {} : records[index] ?? missing('Record not found')
      const next = { ...record }
      const controls = editFields(next, definition.of, 'record:')
      const fields = order ? [field('order', 'Order', 'order', records.map((_, index) => String(index)).join('\n'), {
        choices: records.map((item, index) => ({ value: String(index), label: tenantPageRecordTitle(item, block.type, collection, index) })),
      })] : [
        ...controls.fields,
        ...(!adding ? [field('remove', `Remove ${copy.one.toLowerCase()}`, 'toggle', false)] : []),
      ]
      const revision = source.document.updated_at
      const screen = { title: order ? 'Reorder' : adding ? copy.add : tenantPageRecordTitle(record, block.type, collection, index), fields, rows: [], revision, save_label: 'Save' }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'The page changed. Reopen the section before saving.' })
      if (fields.length !== Object.keys(answer.values).length || fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this section')
      if (order) {
        const ids = answer.values.order!.split('\n')
        if (ids.length !== records.length || ids.some(id => !/^\d+$/.test(id))) return invalid('Include each record once')
        reorderTenantPageRecords(block, collection, ids.map(Number))
      } else if (!adding && answer.values.remove === 'true') {
        reorderTenantPageRecords(block, collection, records.map((_, position) => position).filter(position => position !== index))
      } else {
        controls.write(answer.values)
        block.data[collection] = adding ? [...records, next] : records.map((item, position) => position === index ? next : item)
      }
      const problem = validateTenantPageBlock(block)[0]
      if (problem) return invalid(problem)
      await saveBlocks()
      return screen
    }
    if (view === 'page-media' || view === 'page-media-item' || view === 'page-media-order') {
      if (locale) return missing('Edit media in the source language')
      const block = source.blocks.find(block => block.id === query.block_id) ?? missing('Section not found')
      const registry = TENANT_PAGE_BLOCK_REGISTRY[block.type].fields
      const slots = Object.values(registry).flatMap(definition => {
        if (definition.kind === 'media') {
          return [{ slot: definition.slot ?? 'media', label: definition.label, accept: definition.accept ?? 'image' as const }]
        }
        const records = block.data.items
        if (definition !== registry.items || !definition.of || !Array.isArray(records)
          || !tenantPageBlockSections(block).some(section => section.collection === 'items')) return []
        return records.flatMap((record, index) => Object.values(definition.of!).flatMap(item =>
          item.kind === 'media' && item.slot && isRecord(record)
            ? [{ slot: `items.${index}.${item.slot}`, label: `${tenantPageRecordTitle(record, block.type, 'items', index)} · ${item.label}`, accept: item.accept ?? 'image' as const }]
            : []))
      })
      const row = (id: string, label: string, native: string, slot: string, asset?: typeof block.media[number]): CatalogRow => ({
        id, label, native, image: mediaStillUrl(asset),
        query: { ...documentQuery, block_id: block.id, slot, ...(asset ? { asset_id: asset.asset_id } : {}) },
      })
      if (view === 'page-media') {
        if (answer) return missing('Choose a media placement')
        return { title: 'Section media', fields: [], empty_title: 'No editable media', rows: slots.flatMap(({ slot, label }) => {
          const media = block.media.filter(asset => asset.slot === slot)
          if (slot !== 'gallery') return [row(slot, label, 'page-media-item', slot, media[0])]
          return [
            ...media.map((asset, index) => row(asset.asset_id, `Gallery item ${index + 1}`, 'page-media-item', slot, asset)),
            row('gallery-add', 'Add to gallery', 'page-media-item', slot),
            ...(media.length > 1 ? [row('gallery-order', 'Reorder gallery', 'page-media-order', slot)] : []),
          ]
        }) }
      }
      const slot = slots.find(item => item.slot === query.slot) ?? missing('Media placement not found')
      const gallery = slot.slot === 'gallery'
      const media = block.media.filter(asset => asset.slot === slot.slot)
      const asset = gallery
        ? query.asset_id === undefined ? null : media.find(item => item.asset_id === query.asset_id) ?? missing('Media item not found')
        : media[0] ?? null
      const ids = media.map(item => item.asset_id)
      const revision = JSON.stringify([source.document.updated_at, ids])
      const order = view === 'page-media-order'
      if (order && !gallery) return missing('Gallery not found')
      const title = order ? 'Reorder gallery' : slot.label
      const screen = { title, rows: [], revision, save_label: 'Save', fields: [
        order ? field('value', title, 'order', ids.join('\n'), { choices: media.map((item, index) => ({
          value: item.asset_id, label: `Gallery item ${index + 1}`, image: mediaStillUrl(item),
        })) }) : field('value', title, 'photo', asset?.asset_id, { optional: true, display_url: mediaStillUrl(asset), playback_url: mediaPlaybackUrl(asset), media_kind: slot.accept }),
      ] }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This media changed. Reopen it before saving.' })
      const value = answer.values.value ?? invalid('Missing media value')
      const placement = { owner_type: 'content_block' as const, owner_id: block.id, slot: slot.slot }
      const input = { env, organizationId: organization.id, principal, placement }
      if (!order && value && value !== asset?.asset_id) {
        await hydrateMediaAssetRefs(db, {
          organizationId: organization.id, refs: [{ asset_id: value }],
          allowedKinds: slot.accept === 'any' ? ['image', 'video'] : [slot.accept],
        })
      }
      if (order) {
        const next = value.split('\n')
        if (next.length !== ids.length || new Set(next).size !== ids.length || !next.every(id => ids.includes(id))) invalid('Include each gallery item once')
        await reorderMediaPlacements(db, { ...input, expectedAssetIds: ids, moves: next.slice(1).map((asset_id, index) => ({ asset_id, after_asset_id: next[index]! })) })
      } else if (!gallery) {
        const blocks = source.blocks.map(item => item.id === block.id ? {
          ...item, media: [...item.media.filter(asset => asset.slot !== slot.slot), ...(value ? [{ asset_id: value, slot: slot.slot }] : [])],
        } : item)
        await saveBlocks(blocks)
      } else if (asset && !value) {
        await removeMediaPlacement(db, { ...input, assetId: asset.asset_id })
      } else if (!asset && value) {
        await attachMediaPlacement(db, { ...input, assetId: value })
      } else if (asset && value !== asset.asset_id) {
        invalid('Add the new photo before removing the old one')
      }
      await purgePublicResourceCacheNow(env, organization.id)
      return screen
    }
    if (view === 'page') {
      if (answer) return missing('Choose a page setting')
      return { title: page!.title, fields: [], rows: [
        { id: 'copy', label: 'Page text', summary: page!.summary ?? undefined, native: 'page-content', query: documentQuery },
        { id: 'sections', label: 'Sections', summary: String(source.blocks.length), native: 'page-sections', query: documentQuery },
        ...(await removable() ? [{ id: 'delete', label: 'Delete page', native: 'page-delete', query: documentQuery }] : []),
      ] }
    }
    if (['page-sections', 'page-order', 'page-section-add', 'page-section-remove'].includes(view)) {
      if (locale) return missing('Edit the layout in the source language')
      const row = (id: string, label: string, native: string, query: Record<string, string> = {}): CatalogRow => ({
        id, label, native, query: { ...documentQuery, ...query },
      })
      const allowed = Object.values(TENANT_PAGE_BLOCK_REGISTRY)
        .filter(block => article ? PUBLICATION_CONTENT_BLOCK_TYPES.some(type => type === block.type) : isTenantPageBlockAllowed(block, page!.recipe, page!.page_type, organization.vertical))
      if (view === 'page-sections') {
        if (answer) return missing('Choose a page section')
        return { title: 'Sections', fields: [], rows: [
          ...source.blocks.flatMap(block => [
            ...tenantPageBlockSections(block).flatMap(section => section.kind === 'leaf'
              && tenantPageBlockFieldsForSection(block, section.key).some(({ field }) => field.kind !== 'media' && field.kind !== 'calculator')
              ? [row(`${block.id}:${section.key}`, `${tenantPageBlockLabel(block.type)} · ${section.label}`, 'page-settings', { block_id: block.id, section: section.key })]
              : []),
            ...(tenantPageBlockFieldsForSection(block, 'calculator').length
              ? [row(`${block.id}:calculator`, 'Calculator', 'page-calculator', { block_id: block.id })] : []),
            ...Object.entries(TENANT_PAGE_BLOCK_REGISTRY[block.type].fields).flatMap(([collection, item]) =>
              Object.hasOwn(TENANT_PAGE_RECORD_NOUNS, collection) && item.kind === 'list' && item.of
                && (!item.availableWhen || item.availableWhen.equals.includes(String(block.data[item.availableWhen.field] ?? '')))
                ? [row(`${block.id}:${collection}`, `${tenantPageBlockLabel(block.type)} · ${item.label}`, 'page-records', { block_id: block.id, collection })] : []),
            ...(Object.values(TENANT_PAGE_BLOCK_REGISTRY[block.type].fields).some(item =>
              item.kind === 'media' || (item === TENANT_PAGE_BLOCK_REGISTRY[block.type].fields.items
                && Array.isArray(block.data.items) && block.data.items.length
                && Object.values(item.of ?? {}).some(child => child.kind === 'media')))
              ? [row(`${block.id}:media`, `${tenantPageBlockLabel(block.type)} media`, 'page-media', { block_id: block.id })] : []),
          ]),
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
      const reference = draft ? await references(draft) : null
      const controls = draft ? blockFields(draft, TENANT_PAGE_BLOCK_REGISTRY[draft.type].fields) : null
      const initialMedia = draft && article && draft.type === 'image'
        ? [field('initial-media', 'Image', 'photo', '', { media_kind: 'image' })] : []
      const requiredRecords = draft ? Object.entries(TENANT_PAGE_BLOCK_REGISTRY[draft.type].fields).flatMap(([key, item]) => {
        if (item.kind !== 'list' || !item.required || !item.of) return []
        const fields = item.of
        return Array.from({ length: item.min ?? 1 }, (_, index) => {
          const record = {}
          return { key, record, controls: editFields(record, fields, `initial:${key}:${index}:`) }
        })
      }) : []
      const choices = add
        ? allowed.map(block => ({ value: block.type, label: block.label }))
        : source.blocks.map((block, index) => ({ value: block.id, label: `${tenantPageBlockLabel(block.type)} ${index + 1}` }))
      const title = order ? 'Reorder sections' : add ? 'Add a section' : 'Remove a section'
      const revision = source.document.updated_at
      const screen = { title, rows: [], fields: draft
        ? [...controls!.fields, ...reference!.fields, ...initialMedia, ...requiredRecords.flatMap(item => item.controls.fields)]
        : [field('value', title, order ? 'order' : 'select', order ? choices.map(item => item.value).join('\n') : '', { choices })],
      revision, save_label: 'Save', allow_unchanged: Boolean(draft && !initialMedia.length && !validateTenantPageBlock(draft).length) }
      if (!answer) return screen
      if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This page changed. Reopen it before saving.' })
      let blocks = source.blocks
      if (draft) {
        if (screen.fields.length !== Object.keys(answer.values).length || screen.fields.some(item => typeof answer.values[item.key] !== 'string')) invalid('The saved fields do not match this section')
        reference!.write(answer.values)
        controls!.write(answer.values)
        for (const { key, controls, record } of requiredRecords) {
          controls.write(answer.values)
          const records = draft.data[key] as Record<string, unknown>[]
          records.push(record)
        }
        if (initialMedia.length) {
          const asset_id = answer.values['initial-media'] || invalid('Choose an image')
          await hydrateMediaAssetRefs(db, { organizationId: organization.id, refs: [{ asset_id }], allowedKinds: ['image'] })
          draft.media = [{ asset_id, slot: 'media' }]
        }
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
      await saveBlocks(blocks.map((block, position) => ({ ...block, position })))
      return screen
    }
    if (!page) return missing('Page not found')
    const translated = locale && locale !== page.locale
    const translationId = translated
      ? (await listTenantPages(db, organization.id, { locale })).find(item => item.page_id === page.page_id)?.id
      : undefined
    const saved = translated ? translationId ? await getTenantPageById(db, translationId, scope) : null : page
    const blocks = translated
      ? saved ? alignTenantPageTranslationBlocks(page.blocks, saved.blocks) : createTenantPageTranslationBlocks(page.blocks)
      : page.blocks
    const selected = query.block_id === undefined ? null : page.blocks.find(block => block.id === query.block_id) ?? missing('Section not found')
    const fields = selected ? [] : [
      field('title', 'Title', 'text', saved?.title, { hint: translated ? page.title : undefined }),
      field('summary', 'Summary', 'textarea', saved?.summary, { optional: true, hint: translated ? page.summary ?? undefined : undefined }),
    ]
    const edits = (translated ? page.blocks : []).flatMap((block, index) => {
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
    const revision = JSON.stringify([page.document.updated_at, saved?.document.updated_at])
    const screen = { title: selected ? tenantPageBlockLabel(selected.type) : saved?.title ?? page.title, rows: [], fields, revision, save_label: 'Save' }
    if (!answer) return screen
    if (answer.revision !== revision) throw new HTTPError({ statusCode: 409, message: 'This page changed. Reopen it before saving.' })
    if (fields.length !== Object.keys(answer.values).length || fields.some(row => typeof answer.values[row.key] !== 'string')) invalid('The saved fields do not match this page')
    for (const edit of edits) writeTenantPageLocalizedText(edit.target, edit.path, answer.values[edit.key]!)
    const data = {
      page_id: page.page_id, locale: locale ?? page.locale, path: saved?.path ?? page.path,
      title: selected ? saved?.title ?? page.title : answer.values.title!,
      summary: selected ? saved?.summary ?? null : answer.values.summary!, page_type: page.page_type,
      recipe: page.recipe, blocks,
    }
    if (saved) await updateTenantPage(db, saved.id, { userId, scope, data: { ...data, sort_order: page.sort_order, updated_at: saved.document.updated_at }, env })
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
  const webParams = new URLSearchParams()
  if (locationId) webParams.set('location_id', locationId)
  if (query.kind === 'dish') webParams.set('kind', 'dish')
  const webQuery = webParams.size ? `?${webParams}` : ''
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
  if (product.kind === 'stay' && !['questions', 'question', 'question-order', 'stay-details', 'stay-field', 'stay-safety', 'stay-rules', 'stay-property', 'stay-arrival-time', 'stay-map-sharing', 'stay-accessibility', 'stay-accessibility-feature', ...STAY_ROOM_VIEWS].includes(view)) return missing('Offering not found')
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

  if (view === 'stay-arrival-time' || view === 'stay-map-sharing') {
    if (product.kind !== 'stay' || !wide) return missing('Listing settings not found')
    const access = await stayAccessFor(principal)
    if (!access.manage) return missing('Listing settings not found')
    const home = await readStayHome(db, access, productId)
    if (view === 'stay-arrival-time') {
      const endChoices = [...new Set([...STAY_QUIET_HOUR_TIMES, ...(home.check_in_end_time ? [home.check_in_end_time] : [])])].sort()
      form('Check-in & checkout', [
        field('check_in_time', 'Check-in start (HH:MM)', 'text', home.check_in_time, { optional: true, hint: home.timezone }),
        field('check_in_end_time', 'Check-in end', 'select', home.check_in_end_time, {
          choices: [{ value: '', label: 'Flexible' }, ...endChoices.map(value => ({ value, label: value }))],
        }),
        field('check_out_time', 'Checkout (HH:MM)', 'text', home.check_out_time, { optional: true }),
      ], async values => {
        const times = Object.fromEntries(screen.fields.map(item => [item.key, values(item.key).trim() || null]))
        if (Object.values(times).some(time => time !== null && !MINUTE_TIME_PATTERN.test(time))) return invalid('Enter a 24-hour time in HH:MM format')
        await updateStayHome(env, db, access, productId, times)
      })
    } else {
      const location = await getLocation(db, organization.id, home.location_id) ?? missing('Location not found')
      revision = JSON.stringify([home.location_id, location.updated_at])
      form('Location sharing', [
        field('stay_map_sharing', 'Public map', 'select', home.stay_map_sharing, {
          choices: STAY_MAP_SHARING_MODES.map(value => ({ value, label: value === 'specific' ? 'Show specific location' : 'Show general location' })),
          hint: 'This applies to all homes at this location.',
        }),
      ], async values => {
        await updateStayHome(env, db, access, productId, { stay_map_sharing: values('stay_map_sharing') })
      })
    }
  } else if (view === 'stay-property') {
    if (product.kind !== 'stay' || !wide) return missing('Listing details not found')
    const access = await stayAccessFor(principal)
    if (!access.manage) return missing('Listing details not found')
    const home = await readStayHome(db, access, productId)
    const options = (values: Record<string, { label: string }>) => [
      { value: '', label: 'Unspecified' },
      ...Object.entries(values).map(([value, item]) => ({ value, label: item.label })),
    ]
    form('Property details', [
      field('listing_type', 'Accommodation type', 'select', home.listing_type, { choices: options(STAY_LISTING_TYPES) }),
      field('total_floors', 'Total floors', 'number', home.total_floors, { optional: true }),
      field('listing_floor', 'Listing floor', 'text', home.listing_floor, { optional: true }),
      field('year_built', 'Year built', 'number', home.year_built, { optional: true }),
      field('property_size', 'Property size', 'text', home.property_size, { optional: true }),
      field('property_size_unit', 'Unit', 'select', home.property_size_unit, { choices: options(STAY_PROPERTY_SIZE_UNITS) }),
    ], async values => {
      const patch: Record<string, unknown> = {}
      for (const item of screen.fields) {
        const value = values(item.key).trim()
        if (value === item.value) continue
        if (item.kind === 'select') patch[item.key] = value || null
        else if (!value) patch[item.key] = null
        else {
          const number = Number(value)
          if (!Number.isFinite(number)) return invalid(`Enter a valid number for ${item.label}`)
          patch[item.key] = number
        }
      }
      if (Object.keys(patch).length) await updateStayHome(env, db, access, productId, patch)
    })
  } else if (STAY_ROOM_VIEWS.includes(view)) {
    if (product.kind !== 'stay' || !wide) return missing('Photo tour not found')
    const access = await stayAccessFor(principal)
    if (!access.manage) return missing('Photo tour not found')
    const home = await readStayHome(db, access, productId)
    const rooms = home.photo_rooms
    const roomLabel = (room: typeof rooms[number]) => stayPhotoRoomName(room, rooms)
    if (view === 'stay-rooms') {
      screen = { title: 'Photo tour rooms', fields: [], rows: [
        ...rooms.map(room => leaf(room.id, roomLabel(room), `${room.photo_ids.length} photos`, { view: 'stay-room', query: { room_id: room.id } })),
        leaf('stay-room-add', 'Add a room or space'),
        ...home.photos.map((photo, index) => ({
          ...leaf(photo.id, photo.alt_text ?? `Photo ${index + 1}`, undefined, { view: 'stay-photo-room', query: { asset_id: photo.id } }),
          image: photo.url,
        })),
      ] }
    } else if (view === 'stay-room-add') {
      revision = JSON.stringify(rooms.map(room => room.id))
      form('Add a room or space', [field('type', 'Room type', 'select', '', {
        choices: Object.entries(STAY_PHOTO_ROOM_TYPES).map(([value, definition]) => ({ value, label: definition.label })),
      })], async values => {
        await createStayPhotoRoom(db, env, access, productId, { type: values('type') })
      })
    } else if (view === 'stay-photo-room') {
      const photo = home.photos.find(photo => photo.id === query.asset_id) ?? missing('Photo not found')
      const current = rooms.find(room => room.photo_ids.includes(photo.id))?.id ?? null
      revision = JSON.stringify([current, rooms.map(room => room.id)])
      form('Move photo', [field('room', 'Room or space', 'select', current, {
        choices: [{ value: '', label: 'Additional photos' }, ...rooms.map(room => ({ value: room.id, label: roomLabel(room) }))],
      })], async values => {
        await moveStayPhotos(db, env, access, productId, { room_id: values('room') || null, photos: [{ photo_id: photo.id, expected_room_id: current }] })
      })
    } else {
      const room = rooms.find(room => room.id === query.room_id) ?? missing('Room not found')
      const roomQuery = { room_id: room.id }
      revision = String(room.details_version)
      if (view === 'stay-room') {
        screen = { title: roomLabel(room), fields: [], rows: [
          ...(room.type === 'bedroom' ? [
            leaf('stay-room-beds', 'Sleeping arrangements', undefined, { query: roomQuery }),
            leaf('stay-room-privacy', 'Private attached bathroom', undefined, { query: roomQuery }),
            ...Object.entries(STAY_ROOM_ACCESSIBILITY_FEATURES).map(([feature, definition]) => leaf(feature, definition.label, undefined, { view: 'stay-room-accessibility', query: { ...roomQuery, feature } })),
          ] : []),
          leaf('stay-room-amenities', 'Amenities', undefined, { query: roomQuery }),
          leaf('stay-room-remove', 'Remove room', undefined, { query: roomQuery }),
        ] }
      } else if (view === 'stay-room-beds' && room.type === 'bedroom') {
        const beds = Object.keys(STAY_BED_TYPES) as StayBedType[]
        form('Sleeping arrangements', beds.map(type => field(type, STAY_BED_TYPES[type].label, 'number',
          room.sleeping_arrangements?.find(bed => bed.type === type)?.count, { optional: true })), async values => {
          const sleeping_arrangements = beds.flatMap(type => {
            const quantity = count(values(type))
            return quantity ? [{ type, count: quantity }] : []
          })
          await updateStayPhotoRoom(db, env, access, productId, room.id, { expected_details_version: room.details_version, sleeping_arrangements })
        })
      } else if (view === 'stay-room-privacy' && room.type === 'bedroom') {
        form('Private attached bathroom', [field('value', 'Private attached bathroom', 'select', room.private_attached_bathroom, {
          choices: [{ value: '', label: 'Unspecified' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
        })], async values => {
          await updateStayPhotoRoom(db, env, access, productId, room.id, { expected_details_version: room.details_version, private_attached_bathroom: values('value') ? bool(values('value')) : null })
        })
      } else if (view === 'stay-room-amenities') {
        const amenities = [...new Set([...home.amenities, ...room.amenities])]
        revision = JSON.stringify([room.details_version, amenities])
        form('Room amenities', amenities.map(code => field(code, STAY_AMENITIES[code].label, 'toggle', room.amenities.includes(code))), async values => {
          await updateStayPhotoRoom(db, env, access, productId, room.id, { expected_details_version: room.details_version, amenities: amenities.filter(code => bool(values(code))) })
        })
      } else if (view === 'stay-room-accessibility' && room.type === 'bedroom') {
        const feature = query.feature
        if (!isStayRoomAccessibilityFeature(feature)) return missing('Accessibility feature not found')
        const definition = STAY_ROOM_ACCESSIBILITY_FEATURES[feature]
        const saved = room.accessibility.find(item => item.feature === feature)
        const photos = home.photos.filter(photo => photo.kind === 'image' && room.photo_ids.includes(photo.id))
        revision = JSON.stringify([room.details_version, photos.map(photo => photo.id)])
        form(definition.label, [
          field('available', definition.label, 'select', saved?.available, {
            choices: [{ value: '', label: 'Unspecified' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
            hint: [definition.description, ...definition.guidelines].join('\n'),
          }),
          ...photos.map((photo, index) => field(`evidence:${photo.id}`, photo.alt_text ?? `Use photo ${index + 1}`, 'toggle', saved?.photo_ids.includes(photo.id) ?? false, { display_url: photo.url })),
        ], async values => {
          const available = values('available') === '' ? null : bool(values('available'))
          const photo_ids = available ? photos.filter(photo => bool(values(`evidence:${photo.id}`))).map(photo => photo.id) : []
          await updateStayPhotoRoom(db, env, access, productId, room.id, { expected_details_version: room.details_version, accessibility: { feature, available, photo_ids } })
        })
      } else if (view === 'stay-room-remove') {
        form('Remove room', [field('remove', `Remove ${roomLabel(room)}`, 'toggle', false, { hint: 'Its photos move to Additional photos.' })], async values => {
          if (!bool(values('remove'))) return invalid('Confirm room removal')
          await removeStayPhotoRoom(db, env, access, productId, room.id)
        })
      } else return missing('Room setting not found')
    }
  } else if (view === 'stay-accessibility' || view === 'stay-accessibility-feature') {
    if (product.kind !== 'stay' || !wide) return missing('Listing accessibility not found')
    const access = await stayAccessFor(principal)
    if (!access.manage) return missing('Listing accessibility not found')
    const home = await readStayHome(db, access, productId)
    if (view === 'stay-accessibility') {
      screen = { title: 'Accessibility', fields: [], rows: Object.entries(STAY_HOME_ACCESSIBILITY_FEATURES).map(([feature, definition]) => {
        const answer = home.accessibility.find(item => item.feature === feature)?.available
        return leaf(feature, definition.label, answer == null ? 'Unspecified' : answer ? 'Yes' : 'No', { view: 'stay-accessibility-feature', query: { feature } })
      }) }
    } else {
      const feature = query.feature
      if (!isStayHomeAccessibilityFeature(feature)) return missing('Accessibility feature not found')
      const definition = STAY_HOME_ACCESSIBILITY_FEATURES[feature]
      const saved = home.accessibility.find(item => item.feature === feature)
      revision = home.updated_at
      form(definition.label, [
        field('available', definition.label, 'select', saved?.available, {
          choices: [{ value: '', label: 'Unspecified' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
          hint: [definition.description, ...definition.guidelines].join('\n'),
        }),
        ...home.photos.filter(photo => photo.kind === 'image').map((photo, index) => field(`evidence:${photo.id}`, photo.alt_text ?? `Use photo ${index + 1}`, 'toggle', saved?.photo_ids.includes(photo.id) ?? false, { display_url: photo.url })),
      ], async values => {
        const available = values('available') === '' ? null : bool(values('available'))
        const photo_ids = available ? home.photos.filter(photo => photo.kind === 'image' && bool(values(`evidence:${photo.id}`))).map(photo => photo.id) : []
        await updateStayHomeAccessibility(db, env, access, productId, { updated_at: revision, accessibility: { feature, available, photo_ids } })
      })
    }
  } else if (view === 'stay-details' || view === 'stay-field' || view === 'stay-safety' || view === 'stay-rules') {
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
        leaf('stay-accessibility', 'Accessibility'),
        leaf('stay-rooms', 'Photo tour rooms'),
        leaf('stay-property', 'Property details'),
      ] }
    } else {
      const section = Object.keys(STAY_SAFETY_SECTIONS).find(key => key === query.section) as StaySafetySection | undefined
      const selected = view === 'stay-rules'
        ? definitions.filter(definition => STAY_HOUSE_RULE_DETAIL_KEYS.some(key => key === definition.key))
        : view === 'stay-safety'
        ? definitions.filter(definition => staySafetySectionKeys(section ?? missing('Safety section not found')).includes(definition.key as never))
        : definitions.filter(definition => definition.key === query.field && keys.includes(definition.key))
      if (!selected.length) return missing('Listing details not found')
      form(view === 'stay-rules' ? 'Guest rules' : section ? STAY_SAFETY_SECTIONS[section].label : selected[0]!.name, selected.map(definition => {
        const choices = definition.value_type === 'boolean'
          ? [{ value: '', label: 'Unspecified' }, { value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
          : definition.validations.choices?.map(value => ({ value, label: value }))
        return field(definition.key, definition.name, choices ? 'select' : 'textarea', detail(definition.key), { choices, optional: true })
      }), async values => {
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
        if (view === 'stay-rules' && details.quiet_hours !== true) {
          details.quiet_hours_start = null
          details.quiet_hours_end = null
        }
        await patch({ details_mode: 'merge', details })
      })
    }
  } else if (!view) {
    const prices = product.variants.map(variant => {
      const price = chosenPrice(variant)
      const amount = price ? formatMinorAmount(price.unit_amount, currency) : text(detail('pricing_note')) || 'No price set'
      return product.variants.length === 1 ? amount : `${variant.name}: ${amount}`
    }).join('\n') || 'No price set'
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
      { ...leaf('price', priceLabel, prices), optional_detail: service && !booking && prices === 'No price set' },
      ...(!dish && (!service || booking) ? [
        ...(booking ? [leaf('assignment', copy.assigneeLabel, assigned ?? 'Unassigned', { web: 'booking/assignment', readonly: !manages })] : []),
        leaf('booking', bookingLabel, booking ? `${booking.duration_minutes} minutes` : 'No booking calendar'),
      ] : []),
      ...(service && !booking && manages ? [{ ...leaf('booking', 'Set up consultations', 'No booking calendar'), optional_detail: true }] : []),
      ...(service && !booking && !product.locations.length && wide ? [{ ...leaf('locations', placeLabel), optional_detail: true }] : []),
      ...definitions.map(definition => leaf(definition.key, definition.name, text(detail(definition.key)) || undefined, { view: 'attribute', web: `attributes/${definition.id}`, query: { field: definition.key } })),
      ...(wide && service ? [photo] : []),
      ...(wide ? [{ ...leaf('collections', dish ? 'Menu sections' : 'Collections', collections.filter(section => product.collections.some(row => row.collection_id === section.id)).map(section => section.name).join(', ')),
        optional_detail: !dish && !product.collections.length }] : []),
      ...(!service || booking || product.locations.length ? [leaf('locations', placeLabel, [...locationsUsed.map(entry => entry.title), ...(booking?.held_online ? ['Online'] : [])].join(', '))] : []),
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
    screen = await questionEditor(view, query, params, 'Questions', questions, revision, answer, write)
    return screen
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
