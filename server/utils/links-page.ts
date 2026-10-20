import { assertPublicOrganizationLanguageEntitlement, getPersistedSourceLocale } from '~/server/utils/localization'
import type { CloudflareEnv } from '~/server/utils/auth'
import { createContentDocumentWithBlocks, updateContentDocument } from '~/server/utils/content/documents'
import { queryAll, queryFirst, type DbClient } from '~/server/db'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { cleanString } from '~/server/utils/api-response'
import { resolvePublicTemplate, type PublicTemplateSlug } from '~/utils/template-registry'
import { getMediaPlacements } from '~/server/utils/media-placement'
import { loadExactPublicLocalizations, projectExactLocalizedResource } from '~/server/utils/public-localization'
import { listPublicLocaleRepresentations } from '~/server/utils/public-locale-representations'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'

const LINK_ITEM_STATUSES = ['active', 'hidden'] as const

export type LinkItemStatus = typeof LINK_ITEM_STATUSES[number]

export interface OrganizationLinksPage {
  id: string
  organization_id: string
  path: string
  title: string
  created_at: string
  updated_at: string
  updated_by: string | null
}

export interface OrganizationLinkItem {
  id: string
  organization_id: string
  link_page_id: string
  label: string
  destination: string
  sort_order: number
  status: LinkItemStatus
  created_at: string
  updated_at: string
  updated_by: string | null
}

export interface PublicOrganizationLinksPayload {
  organization: {
    id: string
    name: string
    brand_description: string | null
    media: Array<{ asset_id: string; slot: string; public_url: string | null; thumbnail_url: string | null; kind: string | null }>
    theme_id: string | null
    vertical: string | null
    template: PublicTemplateSlug
  }
  page: OrganizationLinksPage
  items: OrganizationLinkItem[]
  localeRepresentations: PublicLocaleRepresentation[]
}

export interface LinksPageUpdateInput {
  title?: unknown
}

export interface LinkItemUpdateInput {
  id?: unknown
  label?: unknown
  destination?: unknown
  sort_order?: unknown
  status?: unknown
}

export class OrganizationLinksValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrganizationLinksValidationError'
  }
}

function idWith(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
}


function requiredString(value: unknown, maxLength: number, field: string) {
  const cleaned = cleanString(value as ApiValue, maxLength)
  if (!cleaned) throw new OrganizationLinksValidationError(`${field} is required.`)
  return cleaned
}

function normalizeItemStatus(value: unknown): LinkItemStatus {
  const status = cleanString(value as ApiValue, 30)
  if (!status) throw new OrganizationLinksValidationError('Link status is required.')
  if (!LINK_ITEM_STATUSES.includes(status as LinkItemStatus)) {
    throw new OrganizationLinksValidationError('Link status must be active or hidden.')
  }
  return status as LinkItemStatus
}

export function validateLinkDestination(value: unknown): string {
  const destination = requiredString(value, 2048, 'Destination')

  if (destination.startsWith('//') || destination.includes('\\')) {
    throw new OrganizationLinksValidationError('Destination must be a rooted path or a valid http(s), mailto, or tel URL.')
  }

  if (destination.startsWith('/')) {
    return destination
  }

  let parsed: URL
  try {
    parsed = new URL(destination)
  } catch {
    throw new OrganizationLinksValidationError('Destination must be a rooted path or a valid http(s), mailto, or tel URL.')
  }

  if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) {
    throw new OrganizationLinksValidationError('Destination scheme is not supported.')
  }

  return parsed.toString()
}

function mapPage(row: ApiRecord): OrganizationLinksPage {
  const required = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new OrganizationLinksValidationError(`Stored links page ${field} is invalid.`)
    return value
  }
  return {
    id: required(row.id, 'id'),
    organization_id: required(row.organization_id, 'organization_id'),
    path: required(row.path, 'path'),
    title: required(row.title, 'title'),
    created_at: required(row.created_at, 'created_at'),
    updated_at: required(row.updated_at, 'updated_at'),
    updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
  }
}

function mapItem(row: ApiRecord): OrganizationLinkItem {
  const required = (value: unknown, field: string) => {
    if (typeof value !== 'string' || !value.trim()) throw new OrganizationLinksValidationError(`Stored link ${field} is invalid.`)
    return value
  }
  const status = required(row.status, 'status')
  if (!LINK_ITEM_STATUSES.includes(status as LinkItemStatus)) throw new OrganizationLinksValidationError('Stored link status is invalid.')
  const sortOrder = Number(row.sort_order)
  if (!Number.isInteger(sortOrder)) throw new OrganizationLinksValidationError('Stored link sort order is invalid.')
  return {
    id: required(row.id, 'id'),
    organization_id: required(row.organization_id, 'organization_id'),
    link_page_id: required(row.link_page_id, 'link_page_id'),
    label: required(row.label, 'label'),
    destination: required(row.destination, 'destination'),
    sort_order: sortOrder,
    status: status as LinkItemStatus,
    created_at: required(row.created_at, 'created_at'),
    updated_at: required(row.updated_at, 'updated_at'),
    updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
  }
}

export function defaultLinksPage(input: { organizationId: string; name?: string | null }): OrganizationLinksPage {
  const now = new Date().toISOString()
  return {
    id: '',
    organization_id: input.organizationId,
    path: '/links',
    title: input.name || 'Links',
    created_at: now,
    updated_at: now,
    updated_by: null,
  }
}

export async function getLinksPage(db: DbClient, organizationId: string, locale?: string): Promise<{ page: OrganizationLinksPage | null; items: OrganizationLinkItem[] }> {
  locale ??= (await getPersistedSourceLocale(db, organizationId)).locale
  const pageRow = await queryFirst<ApiRecord>(db, `
    SELECT d.id, d.organization_id, d.path, d.title,
           d.created_at, d.updated_at, d.updated_by
      FROM content_documents d JOIN content_documents root ON root.id = COALESCE(d.root_id, d.id)
     WHERE d.organization_id = ? AND d.locale = ? AND root.kind = 'page' AND root.row_role = 'root'
       AND (root.metadata_json ->> '$.recipe') = 'links'
     LIMIT 1
  `, [organizationId, locale])
  if (!pageRow) return { page: null, items: [] }
  const items = await queryAll<ApiRecord>(db, `
    SELECT b.id, d.organization_id, d.id AS link_page_id,
           (b.data_json ->> '$.label') AS label, (source.data_json ->> '$.url') AS destination,
           source.position AS sort_order, (source.data_json ->> '$.status') AS status,
           b.created_at, b.updated_at, d.updated_by
      FROM content_blocks b JOIN content_documents d ON d.id = b.document_id
      JOIN content_blocks source ON source.id = COALESCE(b.source_block_id,b.id)
     WHERE b.document_id = ? AND d.organization_id = ? AND b.type = 'cta'
     ORDER BY source.position, b.created_at
  `, [pageRow.id, organizationId])

  return { page: mapPage(pageRow), items: items.map(mapItem) }
}

export async function getPublicLinksPage(env: CloudflareEnv, db: DbClient, organizationId: string, locale?: string): Promise<PublicOrganizationLinksPayload | null> {
  locale ??= (await getPersistedSourceLocale(db, organizationId)).locale
  const organization = await queryFirst<ApiRecord>(db, `
    SELECT o.id, o.name, o.brand_description,
           o.theme_id, o.vertical
      FROM organization o
     WHERE o.id = ? AND o.status = 'active' AND o.onboarding_status = 'active'
     LIMIT 1
  `, [organizationId])
  if (!organization) return null
  const media = await getMediaPlacements(db, { organizationId, ownerType: 'organization', ownerIds: [organizationId] })

  await assertPublicOrganizationLanguageEntitlement(env, db, organizationId, locale)
  const { page: sourcePage } = await getLinksPage(db, organizationId)
  const { page, items } = await getLinksPage(db, organizationId, locale)
  const publicItems = items.filter(item => item.status === 'active')
  if (!sourcePage || !page || publicItems.length === 0) return null
  const sourceLocale = await getPersistedSourceLocale(db, organizationId)
  const isSourceLocale = locale === sourceLocale.locale
  const localizations = isSourceLocale
    ? []
    : await loadExactPublicLocalizations(env, db, organizationId, locale)
  const organizationLocalization = localizations.find(item => item.resourceType === 'organization' && item.resourceId === organizationId)
  const localizedOrganization = organizationLocalization
    ? projectExactLocalizedResource('organization', { ...organization, id: organizationId }, organizationLocalization)
    : isSourceLocale ? organization : { ...organization, name: null, brand_description: null }

  const template = resolvePublicTemplate({
    themeId: typeof organization.theme_id === 'string' ? organization.theme_id : null,
    vertical: typeof organization.vertical === 'string' ? organization.vertical : null,
  })

  return {
    organization: {
      id: organizationId,
      name: typeof localizedOrganization.name === 'string' ? localizedOrganization.name : String(organization.name),
      brand_description: typeof localizedOrganization.brand_description === 'string' ? localizedOrganization.brand_description : null,
      media: (media.get(organizationId) ?? []).map(item => ({ asset_id: item.asset_id, slot: item.slot, public_url: item.public_url, thumbnail_url: item.thumbnail_url, kind: item.kind })),
      theme_id: typeof organization.theme_id === 'string' ? organization.theme_id : null,
      vertical: typeof organization.vertical === 'string' ? organization.vertical : null,
      template: template.slug,
    },
    page,
    items: publicItems,
    localeRepresentations: await listPublicLocaleRepresentations(env, db, {
      organizationId,
      sourcePath: '/links',
      documentId: sourcePage.id,
    }),
  }
}

export async function upsertLinksPage(db: DbClient, input: {
  organizationId: string
  page: LinksPageUpdateInput
  items: LinkItemUpdateInput[]
  updatedBy?: string | null
  expectedUpdatedAt?: string
}) {
  const current = await getLinksPage(db, input.organizationId)
  const pageId = current.page?.id || idWith('linkpage')
  const title = requiredString(input.page.title, 160, 'Title')

  const knownItemIds = new Set(current.items.map(item => item.id))
  const createdItemIds: string[] = []
  const normalizedItems = input.items.map((item, index) => {
    const existingId = cleanString(item.id as ApiValue, 120)
    const id = existingId && knownItemIds.has(existingId) ? existingId : idWith('linkitem')
    if (id !== existingId) createdItemIds.push(id)
    const status = normalizeItemStatus(item.status)
    const sortOrder = Number(item.sort_order ?? index)
    if (!Number.isInteger(sortOrder)) throw new OrganizationLinksValidationError('Link sort order must be an integer.')
    return {
      id,
      label: requiredString(item.label, 120, 'Link label'),
      destination: validateLinkDestination(item.destination),
      sortOrder,
      status,
    }
  })

  const itemIds = normalizedItems.map(item => item.id)
  if (new Set(itemIds).size !== itemIds.length) throw new OrganizationLinksValidationError('Link item IDs must be unique.')

  const foreignIds = itemIds.length
    ? await queryAll<{ id: string }>(db, `
      SELECT b.id FROM content_blocks b JOIN content_documents d ON d.id = b.document_id
       WHERE b.id IN (SELECT value FROM json_each(?))
         AND (d.organization_id <> ? OR b.document_id <> ?)
    `, [d1JsonStringSet(itemIds), input.organizationId, pageId])
    : []
  if (foreignIds.length) throw new OrganizationLinksValidationError('Link item IDs must belong to this organization.')

  const blocks = normalizedItems.sort((a, b) => a.sortOrder - b.sortOrder).map(item => ({
    id: item.id, type: 'cta' as const, data: { label: item.label, url: item.destination,
      status: item.status, updated_by: input.updatedBy ?? null },
  }))
  const copy = { title, updated_by: input.updatedBy ?? null }
  if (current.page) {
    await updateContentDocument(db, current.page.id, { expected_updated_at: input.expectedUpdatedAt ?? current.page.updated_at,
      changes: copy, blocks })
  } else {
    await createContentDocumentWithBlocks(db, { id: pageId, organizationId: input.organizationId,
      kind: 'page', rowRole: 'root', locale: (await getPersistedSourceLocale(db, input.organizationId)).locale, path: '/links', title,
      updatedBy: input.updatedBy,
      metadata: { recipe: 'links', page_type: 'custom' } }, blocks)
  }
  return { ...await getLinksPage(db, input.organizationId), created_item_ids: createdItemIds }
}

export async function createLinkItem(db: DbClient, input: {
  organizationId: string
  linkPageId: string
  item: LinkItemUpdateInput
  updatedBy?: string | null
}) {
  const current = await getLinksPage(db, input.organizationId)
  if (!current.page || current.page.id !== input.linkPageId) throw new OrganizationLinksValidationError('Links page not found.')
  const nextItems = [...current.items, { ...input.item, sort_order: current.items.length }]
  return await upsertLinksPage(db, { organizationId: input.organizationId, page: current.page, items: nextItems, updatedBy: input.updatedBy, expectedUpdatedAt: current.page.updated_at })
}

export async function updateLinkItem(db: DbClient, input: {
  organizationId: string
  itemId: string
  updates: LinkItemUpdateInput
  updatedBy?: string | null
}) {
  const current = await getLinksPage(db, input.organizationId)
  if (!current.page) throw new OrganizationLinksValidationError('Links page not found.')
  const nextItems = current.items.map(item => item.id === input.itemId ? { ...item, ...input.updates, id: item.id } : item)
  if (!nextItems.some(item => item.id === input.itemId)) throw new OrganizationLinksValidationError('Link item not found.')
  return await upsertLinksPage(db, { organizationId: input.organizationId, page: current.page, items: nextItems, updatedBy: input.updatedBy, expectedUpdatedAt: current.page.updated_at })
}

export async function deleteLinkItem(db: DbClient, input: {
  organizationId: string
  itemId: string
  updatedBy?: string | null
}) {
  const current = await getLinksPage(db, input.organizationId)
  if (!current.page) throw new OrganizationLinksValidationError('Links page not found.')
  return await upsertLinksPage(db, {
    organizationId: input.organizationId,
    page: current.page,
    items: current.items.filter(item => item.id !== input.itemId),
    expectedUpdatedAt: current.page.updated_at,
    updatedBy: input.updatedBy,
  })
}
