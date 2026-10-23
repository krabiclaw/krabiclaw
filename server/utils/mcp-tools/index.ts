import { PROVIDERS_TOOLS, handleProvidersTools } from './providers'
import { PAYMENTS_TOOLS, handlePaymentsTools } from './payments'
import type { McpToolDefinition } from './shared'
import { TOOL_ANNOTATIONS_BY_NAME } from './shared'
import { ANALYTICS_TOOLS, handleAnalyticsTools } from './analytics'
import { BLOG_TOOLS, handleBlogTools } from './blog'
import { CONTENT_TOOLS, handleContentTools } from './content'
import { CONTEXT_TOOLS } from './context'
import { LOCALES_TOOLS, handleLocalesTools } from './locales'
import { LOCATIONS_TOOLS, handleLocationsTools } from './locations'
import { MEDIA_TOOLS, handleMediaTools } from './media'
import { PRODUCTS_TOOLS, handleProductsTools } from './products'
import { POSTS_TOOLS, handlePostsTools } from './posts'
import { QA_TOOLS, handleQaTools } from './qa'
import { REVIEWS_TOOLS, handleReviewsTools } from './reviews'
import { ORGANIZATIONS_TOOLS, handleOrganizationsTools } from './organizations'
import { BOOKINGS_TOOLS, handleBookingsTools } from './bookings'
import { STAYS_TOOLS, handleStaysTools } from './stays'
import { GUEST_MESSAGING_TOOLS, handleGuestMessagingTools } from './guest-messaging'
import { SUBMISSIONS_TOOLS, handleSubmissionsTools } from './submissions'
import { GOOGLE_ADS_TOOLS, handleGoogleAdsTools } from './google-ads'
import { HTTPError } from 'nitro';
import type { H3Event } from 'nitro'
import { queryFirst } from '~/server/db'
import { requireMcpOrganization, requireMcpUser, type McpUserContext } from '~/server/utils/mcp-auth'
import { resolveMcpWorkspace } from '~/server/utils/mcp-context'
import { onboardingPublicationMissingFields, readOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { activateOnboardingDraft, saveOnboardingDraft } from '~/server/utils/onboarding-apply'
import { mcpProtocolError, MCP_ERROR } from '~/server/utils/mcp-protocol'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server'
import { paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { hasOrganizationEntitlement } from '~/server/utils/billing'
import {
  NOT_HANDLED,
  humanizeEntitlement,
  normalizeWorkspaceArguments,
  resolveOrganizationPublicOrigin,
  workspaceContextPayload,
  workspaceLocationsPayload,
  workspaceOrganizationsPayload,
} from './execution'
import type { McpExecutorContext } from './execution'

export const MCP_PUBLIC_TOOLS: McpToolDefinition[] = [
  ...PROVIDERS_TOOLS,
  ...PAYMENTS_TOOLS,
  ...ANALYTICS_TOOLS,
  ...BLOG_TOOLS,
  ...CONTENT_TOOLS,
  ...CONTEXT_TOOLS,
  ...LOCALES_TOOLS,
  ...LOCATIONS_TOOLS,
  ...MEDIA_TOOLS,
  ...PRODUCTS_TOOLS,
  ...POSTS_TOOLS,
  ...QA_TOOLS,
  ...REVIEWS_TOOLS,
  ...ORGANIZATIONS_TOOLS,
  ...SUBMISSIONS_TOOLS,
  ...BOOKINGS_TOOLS,
  ...STAYS_TOOLS,
  ...GUEST_MESSAGING_TOOLS,
  ...GOOGLE_ADS_TOOLS,
].sort((a, b) => a.name.localeCompare(b.name))

export const MCP_INTERNAL_TOOLS: McpToolDefinition[] = []

export const MCP_TOOLS: McpToolDefinition[] = [
  ...MCP_PUBLIC_TOOLS,
  ...MCP_INTERNAL_TOOLS,
].sort((a, b) => a.name.localeCompare(b.name))


{
  const toolNames = new Set(MCP_TOOLS.map((tool) => tool.name))
  for (const name of TOOL_ANNOTATIONS_BY_NAME.keys()) {
    if (!toolNames.has(name)) {
      throw new Error(`MCP tool annotation classification exists for unknown tool "${name}".`)
    }
  }

  const seenNames = new Set<string>()
  for (const tool of MCP_TOOLS) {
    if (seenNames.has(tool.name)) {
      throw new Error(`Duplicate MCP tool name registered: "${tool.name}".`)
    }
    seenNames.add(tool.name)
  }
}

export function getMcpTool(name: string) {
  return MCP_TOOLS.find((tool) => tool.name === name) ?? null
}

const inputSchemas = new Map(MCP_TOOLS.map(tool => [tool.name, fromJsonSchema<Record<string, unknown>>(tool.inputSchema as JsonSchemaType)]))

// Workspace selection is a domain default. The SDK still validates every
// field and every nested constraint against the advertised JSON Schema.
export function mcpToolInputSchema(event: H3Event, tool: McpToolDefinition, user?: McpUserContext) {
  const schema = inputSchemas.get(tool.name)!
  return { '~standard': {
    ...schema['~standard'],
    validate: async (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return schema['~standard'].validate(value)
      const args = await normalizeWorkspaceArguments(event, tool.name, tool.inputSchema, value as Record<string, unknown>, user)
      return schema['~standard'].validate(args)
    },
  } }
}

// Exported so non-MCP callers (chowbot-adapter.ts) dispatch through the same
// domain-handler registry instead of hand-copying it — one list of which
// domain owns which tool, not two.
export const DOMAIN_HANDLERS: Record<string, (_ctx: McpExecutorContext) => Promise<unknown>> = {
  providers: handleProvidersTools,
  payments: handlePaymentsTools,
  analytics: handleAnalyticsTools,
  blog: handleBlogTools,
  content: handleContentTools,
  locales: handleLocalesTools,
  locations: handleLocationsTools,
  media: handleMediaTools,
  products: handleProductsTools,
  posts: handlePostsTools,
  qa: handleQaTools,
  reviews: handleReviewsTools,
  organizations: handleOrganizationsTools,
  submissions: handleSubmissionsTools,
  bookings: handleBookingsTools,
  stays: handleStaysTools,
  guest_messaging: handleGuestMessagingTools,
  google_ads: handleGoogleAdsTools,
}

export async function executeMcpToolCall(
  event: H3Event,
  toolName: string,
  rawArguments: Record<string, unknown>,
  authenticatedUser?: McpUserContext,
) {
  const tool = getMcpTool(toolName);
  if (!tool) {
    throw mcpProtocolError(
      MCP_ERROR.methodNotFound,
      `Unknown tool: ${toolName}`,
      { unknownToolName: toolName },
      'protocol',
    );
  }

  // Called by registered SDK tools after schema validation and workspace resolution.
  const normalizedArguments = rawArguments;

  if (toolName === 'get_website_draft' || toolName === 'save_website_draft') {
    const user = authenticatedUser ?? await requireMcpUser(event)
    const location = normalizedArguments.location as Record<string, unknown> | undefined
    const { row, payload } = toolName === 'get_website_draft'
      ? await readOnboardingDraft(user.db, user.userId, optionalString(normalizedArguments, 'draft_id') ?? undefined)
      : await saveOnboardingDraft(user.env, user.db, user.userId, {
          draftId: optionalString(normalizedArguments, 'draft_id') ?? undefined,
          expectedUpdatedAt: optionalString(normalizedArguments, 'revision'), idempotencyKey: requiredString(normalizedArguments, 'idempotency_key'),
          name: normalizedArguments.name, vertical: normalizedArguments.vertical, subdomain: normalizedArguments.subdomain,
          details: { sourceLocale: normalizedArguments.source_locale, currency: normalizedArguments.currency, timezone: normalizedArguments.timezone,
            streetAddress: location?.street_address, addressLine2: location?.address_line_2, city: location?.city, region: location?.region,
            postalCode: location?.postal_code, country: location?.country, phone: location?.phone, websiteUrl: location?.website_url },
          brandDraft: { heroHeadline: normalizedArguments.hero_headline, heroSubtitle: normalizedArguments.hero_subtitle },
          products: Array.isArray(normalizedArguments.products) ? normalizedArguments.products.map(product => {
            const item = product as Record<string, unknown>
            return { name: item.name, category: item.category, amountMinor: item.amount_minor }
          }) : normalizedArguments.products,
        })
    if (row.organization_id) event.context.mcpExecutionContext = { organizationId: row.organization_id }
    const details = payload.source.details
    return {
      draft_id: row.id, revision: row.updated_at, ...(row.organization_id ? { organization_id: row.organization_id } : {}), status: row.status,
      ...(payload.request ? { idempotency_key: payload.request.key } : {}),
      subdomain: row.subdomain_candidate, name: payload.preview.brandName, vertical: payload.preview.vertical, source_locale: details.sourceLocale,
      ...(details.currency ? { currency: details.currency } : {}), ...(details.timezone ? { timezone: details.timezone } : {}),
      location: Object.fromEntries(Object.entries({ street_address: details.streetAddress, address_line_2: details.addressLine2, city: details.city,
        region: details.region, postal_code: details.postalCode, country: details.country, phone: details.phone, website_url: details.websiteUrl }).filter(([, value]) => value !== null)),
      ...(payload.preview.config.draft_hero_headline ? { hero_headline: payload.preview.config.draft_hero_headline } : {}),
      ...(payload.preview.config.draft_hero_subtitle ? { hero_subtitle: payload.preview.config.draft_hero_subtitle } : {}),
      products: payload.preview.products.map(product => ({ name: product.name, category: product.collection, ...(product.price ? { amount_minor: product.price.unit_amount } : {}) })),
      missing_fields: onboardingPublicationMissingFields(row, payload),
    }
  }

  if (toolName === 'publish_website') {
    const user = authenticatedUser ?? await requireMcpUser(event)
    const draftId = requiredString(normalizedArguments, 'draft_id')
    const created = await activateOnboardingDraft(user.env, user.db, { userId: user.userId, draftId, expectedUpdatedAt: requiredString(normalizedArguments, 'revision'), origin: event.req })
    event.context.mcpExecutionContext = { organizationId: created.organizationId, locationId: created.locationId }
    try {
      await upsertMcpWorkspacePreference(user.db, { userId: user.userId, organizationId: created.organizationId, locationId: created.locationId })
      const workspace = await resolveMcpWorkspace(user.db, user.env, user.userId, { organizationId: created.organizationId, locationId: created.locationId, requireOrganization: true, requireLocation: true })
      return { organization_id: created.organizationId, location_id: created.locationId, draft_id: draftId, public_url: created.publicUrl, ready: true, context: workspaceContextPayload(workspace.organization, workspace.location) }
    } catch (error) {
      throw new HTTPError({ statusCode: 500, statusMessage: 'Website is live, but workspace selection failed', data: { code: 'WEBSITE_WORKSPACE_SELECTION_FAILED', organization_id: created.organizationId, draft_id: draftId }, cause: error })
    }
  }

  if (toolName === "list_organizations") {
    const user = authenticatedUser ?? await requireMcpUser(event);
    const workspace = await resolveMcpWorkspace(
      user.db,
      user.env,
      user.userId,
    );
    const organizations = workspace.organizations.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.slug,
      subdomain: entry.subdomain,
      orgSlug: entry.slug,
      publicUrl: resolveOrganizationPublicOrigin({ public_url: entry.public_url }),
      status: entry.status,
      active: entry.id === workspace.organization?.id,
    }));
    const currentUser = {
      id: user.userId,
      isPlatformAdmin: user.isPlatformAdmin,
    };
    const page = paginateMcpCollection(organizations, rawArguments, { resource: `organizations:${user.userId}` });
    return renderStructuredResponse(
      { organizations: page.items, currentUser, page_info: page.page_info },
      organizations.length === 0
        ? "You have no websites yet. Use save_website_draft to start your business website."
        : `You have ${organizations.length} organization${organizations.length > 1 ? "s" : ""}: ${organizations.map((entry) => entry.name).join(", ")}.`,
    );
  }

  if (toolName === "get_workspace_context") {
    const user = authenticatedUser ?? await requireMcpUser(event);
    const workspace = await resolveMcpWorkspace(
      user.db,
      user.env,
      user.userId,
    );
    return {
      context: workspaceContextPayload(workspace.organization, workspace.location),
      organizations: workspaceOrganizationsPayload(workspace),
      locations: workspaceLocationsPayload(workspace),
    };
  }

  if (toolName === "set_workspace_context") {
    if (!Object.hasOwn(normalizedArguments, 'organization_id') && !Object.hasOwn(normalizedArguments, 'location_id')) {
      throw new HTTPError({ statusCode: 400, statusMessage: 'Select an organization or location' })
    }
    const user = authenticatedUser ?? await requireMcpUser(event);
    const organizationId = optionalString(normalizedArguments, "organization_id");
    const locationId = optionalString(normalizedArguments, "location_id");
    let workspace;
    try {
      workspace = await resolveMcpWorkspace(
        user.db,
        user.env,
        user.userId,
        {
          organizationId,
          locationId,
          requireOrganization: Boolean(organizationId) || Boolean(locationId),
          requireLocation: Boolean(locationId),
        },
      );
      if (!workspace.organization && !workspace.location) {
        throw new Error("Workspace context is empty. At least one of organization or location must be resolved.");
      }
    } catch (error) {
      rethrowWorkspaceError(error);
    }

    await upsertMcpWorkspacePreference(user.db, {
      userId: user.userId,
      organizationId: workspace.organization?.id ?? null,
      locationId: workspace.location?.id ?? null,
    });

    const refreshed = await resolveMcpWorkspace(
      user.db,
      user.env,
      user.userId,
      {
        organizationId: workspace.organization?.id ?? null,
        locationId: workspace.location?.id ?? null,
      },
    );

    return {
      success: true,
      context: workspaceContextPayload(refreshed.organization, refreshed.location),
      organizations: workspaceOrganizationsPayload(refreshed),
      locations: workspaceLocationsPayload(refreshed),
    };
  }

  const organizationId = requiredString(normalizedArguments, "organization_id");
  const organization = await requireMcpOrganization(event, organizationId, tool.minimumRole, authenticatedUser);
  // Attribution records the organization actually authorized for execution,
  // including a saved workspace resolved from a bearer-authenticated request.
  const executionContext = { organizationId: organization.organizationId, locationId: null as string | null };
  event.context.mcpExecutionContext = executionContext;
  const args = omit(normalizedArguments, ["organization_id"]);
  const explicitLocationId = optionalString(rawArguments, "location_id");
  if (explicitLocationId) {
    const location = await queryFirst<{ id: string }>(organization.db, `
      SELECT id
      FROM business_locations
      WHERE id = ? AND organization_id = ?
      LIMIT 1
    `, [explicitLocationId, organization.organizationId]);
    if (!location) {
      throw new HTTPError({ statusCode: 404, statusMessage: 'Location not found for this organization' });
    }
  }

  executionContext.locationId = optionalString(normalizedArguments, "location_id");

  if (
    tool.requiredEntitlement &&
    !(await hasOrganizationEntitlement(organization.env as CloudflareEnv, organization.organizationId,
      tool.requiredEntitlement,
    ))
  ) {
    throw new HTTPError({
      statusCode: 403,
      statusMessage: `${humanizeEntitlement(tool.requiredEntitlement)} is not enabled for this organization.`,
    });
  }

  const domainHandler = tool.domain ? DOMAIN_HANDLERS[tool.domain] : undefined;
  if (domainHandler) {
    const result = await domainHandler({ event, toolName, rawArguments, normalizedArguments, tool, organizationId, organization, args });
    if (result !== NOT_HANDLED) return result;
  }
  throw mcpProtocolError(
        MCP_ERROR.methodNotFound,
        `Unhandled tool: ${toolName}`,
      );
}
