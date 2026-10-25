import { CONTENT_DOCUMENT_KINDS, LOCALIZED_RESOURCE_TYPES } from '~/shared/content-registries'
import type { McpToolDefinition } from './shared'
import { contentBlockObject, organizationTool, workspaceContextObject } from './shared'
import { TENANT_PAGE_BLOCKS_SCHEMA } from './content'
import { localizedResourceValuesSchema } from '~/server/utils/localization-registry'
import { PRODUCT_KINDS, productDetailsSchema } from '~/shared/product-details'
import type { McpExecutorContext } from './execution'
import type { CloudflareEnv } from '~/server/utils/auth'
import {
  deleteLocalization,
  getProductCatalogLocalization,
  getLocalizationForAuthoring,
  putLocalizationForAuthoring,
  replaceResourceLocalizations,
} from '~/server/utils/localization'
import { listOrganizationLocales } from '~/server/utils/organization-locales'
import { addOrganizationLanguage, publishOrganizationLanguage, disableOrganizationLanguage, deleteDisabledOrganizationLanguageContent } from '~/server/utils/organization-languages'
import { PLATFORM_LOCALES } from '~/shared/platform-locales'
import { NOT_HANDLED, mutationContextPayload, requiredString } from './execution'

const localizedDocumentValues = { type: 'object', properties: {
  title: { type: ['string', 'null'] }, summary: { type: ['string', 'null'] }, seo_keywords: { type: ['string', 'null'] },
  metadata: { type: 'object', properties: { call_to_action: { type: 'object', properties: { label: { type: 'string', pattern: '\\S' } }, required: ['label'], additionalProperties: false } }, additionalProperties: false },
}, additionalProperties: false } as const
const resourceValueBranches = LOCALIZED_RESOURCE_TYPES.map(resourceType => ({
  properties: { resource_type: { const: resourceType }, values: localizedResourceValuesSchema(resourceType) },
}))
const resourceValuesInput = {
  type: 'object',
  properties: Object.assign({}, ...LOCALIZED_RESOURCE_TYPES.map(resourceType => localizedResourceValuesSchema(resourceType).properties)),
  additionalProperties: false,
} as const
const organizationLocaleObject = { type: 'object', properties: {
  id: { type: 'string' }, organization_id: { type: 'string' }, locale: { type: 'string' }, label: { type: ['string', 'null'] },
  is_source: { type: 'boolean' }, status: { type: 'string', enum: ['published', 'disabled'] }, created_at: { type: 'string' }, updated_at: { type: 'string' },
}, required: ['id', 'organization_id', 'locale', 'label', 'is_source', 'status', 'created_at', 'updated_at'], additionalProperties: false } as const

const localizationIdentity = { id: { type: 'string' }, organization_id: { type: 'string' }, 
  locale: { type: 'string' }, created_at: { type: 'string' }, updated_at: { type: 'string' } } as const
const localizationObject = { oneOf: [
  { type: 'object', properties: { ...localizationIdentity, resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES] },
      resource_id: { type: 'string' }, values: { type: 'object' }, route_path: { type: ['string','null'] },
      created_by_user_id: { type: 'string' }, updated_by_user_id: { type: 'string' } },
    required: [...Object.keys(localizationIdentity), 'resource_type','resource_id','values','route_path','created_by_user_id','updated_by_user_id'], additionalProperties: false, anyOf: resourceValueBranches },
  { type: 'object', properties: { ...localizationIdentity, kind: { type: 'string', enum: CONTENT_DOCUMENT_KINDS },
      row_role: { const: 'representation' }, root_id: { type: 'string' }, title: { type: ['string','null'] }, summary: { type: ['string','null'] },
      slug: { type: ['string','null'] }, path: { type: ['string','null'] },
      seo_keywords: { type: ['string','null'] }, metadata: { type: 'object', additionalProperties: true },
      content_blocks: { type: 'array', items: contentBlockObject } },
    required: [...Object.keys(localizationIdentity), 'kind','row_role','root_id','title','summary','slug','path','seo_keywords','metadata','content_blocks'], additionalProperties: false },
] } as const

export const LOCALES_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'add_organization_language',
    description: 'Add a website language for private authoring. Requires the website’s language entitlement. A new language starts disabled; an existing language keeps its publication status and translations while its stored label is refreshed from the platform catalog.',
    domain: 'locales', minimumRole: 'admin', inputSchema: { locale: { type: 'string', enum: PLATFORM_LOCALES.map(item => item.locale) } },
    required: ['locale'],
    outputSchema: { type: 'object', properties: { locales: { type: 'array', items: organizationLocaleObject } }, required: ['locales'], additionalProperties: false },
  }),
  organizationTool({
    name: 'publish_organization_language',
    description: 'Publish an added website language’s authored translations on public routes. Requires the website’s language entitlement and a translated homepage. Missing translations remain unavailable; the source language is unchanged.',
    domain: 'locales', minimumRole: 'admin', inputSchema: { locale: { type: 'string', enum: PLATFORM_LOCALES.map(item => item.locale) } },
    required: ['locale'],
    outputSchema: { type: 'object', properties: { locales: { type: 'array', items: organizationLocaleObject } }, required: ['locales'], additionalProperties: false },
  }),
  organizationTool({
    name: 'disable_organization_language',
    description: 'Disable an existing website language’s public routes while preserving its translations for private authoring. The source language cannot be disabled.',
    domain: 'locales', minimumRole: 'admin', inputSchema: { locale: { type: 'string', enum: PLATFORM_LOCALES.map(item => item.locale) } },
    required: ['locale'],
    outputSchema: { type: 'object', properties: { locales: { type: 'array', items: organizationLocaleObject } }, required: ['locales'], additionalProperties: false },
  }),
  organizationTool({
    name: 'delete_organization_language',
    description: 'Permanently delete a disabled website language and all of its translations. Disable it before deletion. Source content is preserved.',
    domain: 'locales', minimumRole: 'admin', inputSchema: { locale: { type: 'string' } }, required: ['locale'],
    outputSchema: { type: 'object', properties: { deleted: { const: true }, locale: { type: 'string' } }, required: ['deleted', 'locale'], additionalProperties: false },
  }),
  organizationTool({
    name: 'list_organization_locales',
    description: "Read the website’s source language and authored translations.",
    domain: 'locales',
    minimumRole: 'admin',
    inputSchema: {},
    outputSchema: {
      type: 'object',
      properties: {
        locales: { type: 'array', items: organizationLocaleObject },
      },
      required: ['locales'],
      additionalProperties: false,
    },
  }),
  organizationTool({
    name: 'get_resource_localization',
    description: "Read the requested resource or document in exactly the named language. A missing translation returns not found rather than source-language content.",
    domain: 'locales',
    minimumRole: 'admin',
    inputSchema: {
      resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES, 'content_document'] },
      resource_id: { type: 'string' },
      locale: { type: 'string' },
    },
    required: ['resource_type', 'resource_id', 'locale'],
    outputSchema: { type: 'object', properties: { localization: localizationObject }, required: ['localization'], additionalProperties: false },
  }),
  organizationTool({
    name: 'put_resource_localization',
    description: "Replace an exact translation with fields allowed for its resource_type. For content_document, an existing translation requires its current expected_updated_at from get_resource_localization; a new article or page translation requires content_blocks. Omit blocks to retain an existing body. Document addresses come from the source and remain stable. Authored Q&A translations use title and summary without blocks; imported Q&A remains read-only.",
    domain: 'locales',
    minimumRole: 'admin',
    inputSchema: {
      resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES, 'content_document'] },
      resource_id: { type: 'string' },
      locale: { type: 'string' },
      values: { ...resourceValuesInput, properties: { ...resourceValuesInput.properties, ...localizedDocumentValues.properties } },
      content_blocks: TENANT_PAGE_BLOCKS_SCHEMA,
      expected_updated_at: { type: ['string', 'null'], description: 'content_document only: required current translation updated_at when replacing an existing document. Omit or use null when creating a translation.' },
      oneOf: [
        ...resourceValueBranches.map(branch => ({ ...branch, not: { anyOf: [{ required: ['content_blocks'] }, { required: ['expected_updated_at'] }] } })),
        { properties: { resource_type: { const: 'content_document' }, values: localizedDocumentValues } },
      ],
    },
    required: ['resource_type', 'resource_id', 'locale', 'values'],
    outputSchema: { type: 'object', properties: { localization: localizationObject, context: workspaceContextObject }, required: ['localization'], additionalProperties: false },
  }),
  organizationTool({
    name: 'delete_resource_localization',
    description: "Permanently remove one translation and its owned document and redirects. Source content is preserved; imported Q&A remains read-only.",
    domain: 'locales',
    minimumRole: 'admin',
    inputSchema: {
      resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES, 'content_document'] },
      resource_id: { type: 'string' },
      locale: { type: 'string' },
    },
    required: ['resource_type', 'resource_id', 'locale'],
    outputSchema: { type: 'object', properties: { deleted: { type: 'boolean' }, resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES, 'content_document'] }, resource_id: { type: 'string' }, locale: { type: 'string' }, context: workspaceContextObject }, required: ['deleted', 'resource_type', 'resource_id', 'locale'], additionalProperties: false },
  }),
  organizationTool({
    name: 'get_product_catalog_localization',
    description: 'Read catalog text and existing translations for an authored secondary language, including its menu sections.',
    domain: 'locales',
    minimumRole: 'admin',
    inputSchema: { locale: { type: 'string' } },
    required: ['locale'],
    outputSchema: { type: 'object', properties: { locale: { type: 'string' },
      products: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, kind: { type: 'string', enum: PRODUCT_KINDS }, source: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, marketing_features: { type: 'array', items: { type: 'string' } }, unit_label: { type: ['string', 'null'] }, details: productDetailsSchema() }, required: ['name', 'description', 'marketing_features', 'unit_label', 'details'], additionalProperties: false },
        localization: { type: ['object', 'null'], properties: { values: localizedResourceValuesSchema('product'), route_path: { type: ['string', 'null'] } }, required: ['values', 'route_path'], additionalProperties: false } }, required: ['id', 'kind', 'source', 'localization'], additionalProperties: false } },
      collections: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, location_id: { type: ['string', 'null'] }, source: { type: 'object', properties: { name: { type: 'string' }, description: { type: ['string', 'null'] } }, required: ['name', 'description'], additionalProperties: false },
        localization: { type: ['object', 'null'], properties: { values: localizedResourceValuesSchema('collection') }, required: ['values'], additionalProperties: false } }, required: ['id', 'location_id', 'source', 'localization'], additionalProperties: false } },
    }, required: ['locale', 'products', 'collections'], additionalProperties: false },
  }),
  organizationTool({
    name: 'replace_resource_localizations',
    description: 'Atomically replace 1–250 exact resource translations for one language. Omitted resources retain their translations; any invalid item rejects the batch. Uses supplied translations without generating them.',
    domain: 'locales',
    minimumRole: 'admin',
    inputSchema: {
      resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES] },
      locale: { type: 'string' },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 250,
        items: {
          type: 'object',
          properties: {
            resource_id: { type: 'string' },
            values: resourceValuesInput,
            route_path: { type: 'null' },
          },
          required: ['resource_id', 'values'],
          additionalProperties: false,
        },
      },
      oneOf: LOCALIZED_RESOURCE_TYPES.map(resourceType => ({
        properties: {
          resource_type: { const: resourceType },
          items: { type: 'array', items: { properties: { values: localizedResourceValuesSchema(resourceType) } } },
        },
      })),
    },
    required: ['resource_type', 'locale', 'items'],
    outputSchema: { type: 'object', properties: { locale: { type: 'string' }, resource_type: { type: 'string', enum: [...LOCALIZED_RESOURCE_TYPES] }, updated_resource_ids: { type: 'array', items: { type: 'string' } }, context: workspaceContextObject }, required: ['locale', 'resource_type', 'updated_resource_ids'], additionalProperties: false },
  }),
]

export async function handleLocalesTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (toolName === 'add_organization_language') {
    await addOrganizationLanguage(organization.db, organization.env, { organizationId: organization.organizationId, locale: requiredString(args, 'locale') })
    return await listOrganizationLocales(organization.db, organization.organizationId)
  }
  if (toolName === 'publish_organization_language') {
    await publishOrganizationLanguage(organization.db, organization.env, { organizationId: organization.organizationId, locale: requiredString(args, 'locale') })
    return await listOrganizationLocales(organization.db, organization.organizationId)
  }
  if (toolName === 'disable_organization_language') {
    await disableOrganizationLanguage(organization.db, { organizationId: organization.organizationId, locale: requiredString(args, 'locale') })
    return await listOrganizationLocales(organization.db, organization.organizationId)
  }
  if (toolName === 'delete_organization_language') {
    return await deleteDisabledOrganizationLanguageContent(organization.db, { organizationId: organization.organizationId, locale: requiredString(args, 'locale') })
  }
  if (toolName === 'list_organization_locales') {
    return await listOrganizationLocales(organization.db, organization.organizationId)
  }
  if (toolName === 'get_resource_localization') {
    const record = await getLocalizationForAuthoring(organization.env as CloudflareEnv, organization.db, organization.organizationId, requiredString(args, 'resource_type'), requiredString(args, 'resource_id'), requiredString(args, 'locale'))
    return { localization: record }
  }
  if (toolName === 'put_resource_localization') {
    const localization = await putLocalizationForAuthoring(organization.env as CloudflareEnv, organization.db, {
      organizationId: organization.organizationId,
      resourceType: requiredString(args, 'resource_type'),
      resourceId: requiredString(args, 'resource_id'),
      locale: requiredString(args, 'locale'),
      values: args.values,
      contentBlocks: args.content_blocks ?? undefined,
      expectedUpdatedAt: args.expected_updated_at ?? undefined,
      userId: organization.userId,
    })
    return { localization: localization, context: await mutationContextPayload(organization) }
  }
  if (toolName === 'delete_resource_localization') {
    const result = await deleteLocalization(organization.env as CloudflareEnv, organization.db, {
      organizationId: organization.organizationId,
      resourceType: requiredString(args, 'resource_type'),
      resourceId: requiredString(args, 'resource_id'),
      locale: requiredString(args, 'locale'),
    })
    return { ...result, context: await mutationContextPayload(organization) }
  }
  if (toolName === 'get_product_catalog_localization') {
    const catalog = await getProductCatalogLocalization(organization.env as CloudflareEnv, organization.db, organization.organizationId, requiredString(args, 'locale'))
    return catalog
  }
  if (toolName === 'replace_resource_localizations') {
    const result = await replaceResourceLocalizations(organization.env as CloudflareEnv, organization.db, {
      organizationId: organization.organizationId,
      resourceType: requiredString(args, 'resource_type'),
      locale: requiredString(args, 'locale'),
      items: args.items,
      userId: organization.userId,
    })
    return { ...result, context: await mutationContextPayload(organization) }
  }
  return NOT_HANDLED
}
