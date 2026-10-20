import type { McpToolDefinition } from './shared'
import { pageInfoObject, paginationInputSchema, reviewObject, organizationTool } from './shared'
import type { McpExecutorContext } from './execution'
import { listLocationReviews } from '~/server/utils/mcp-workflows'
import { listOrganizationReviews } from '~/server/utils/organization-reviews'
import { paginateMcpCollection } from '~/server/utils/mcp-pagination'
import { NOT_HANDLED, requiredString } from './execution'

export const REVIEWS_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'list_organization_reviews',
    description: "Read site-wide reviews that have no location, including existing replies, provenance and verification status. This tool makes no changes.",
    domain: 'reviews',
    minimumRole: 'admin',
    inputSchema: { ...paginationInputSchema },
    outputSchema: { type: 'object', properties: { reviews: { type: 'array', items: reviewObject }, page_info: pageInfoObject }, required: ['reviews', 'page_info'] },
  }),
  organizationTool({
      name: 'list_location_reviews',
      description: "Read reviews and existing replies for the selected location. Includes review provenance and verification status. Replies to imported Google reviews are managed in Google; this tool makes no changes.",
      domain: 'reviews',
      minimumRole: 'admin',
      inputSchema: { location_id: { type: 'string' }, ...paginationInputSchema },
      required: ['location_id'],
      outputSchema: {
        type: 'object',
        properties: { reviews: { type: 'array', items: reviewObject }, page_info: pageInfoObject },
        required: ['reviews', 'page_info'],
      },
    }),
]

export async function handleReviewsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case "list_organization_reviews":
      {
        const reviews = await listOrganizationReviews(organization.db, organization.organizationId);
        const page = paginateMcpCollection(reviews, args, { resource: `organization-reviews:${organization.organizationId}` });
        return { reviews: page.items, page_info: page.page_info };
      }
    case "list_location_reviews":
      {
        const locationId = requiredString(args, "location_id");
        const reviews = await listLocationReviews(
          organization.db,
          organization.organizationId,
          locationId,
        );
        const page = paginateMcpCollection(reviews, args, { resource: `location-reviews:${organization.organizationId}:${locationId}` });
        return { reviews: page.items, page_info: page.page_info };
      }
    default:
      return NOT_HANDLED
  }
}
