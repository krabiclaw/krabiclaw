import type { McpToolDefinition } from './shared'
import { globalTool, locationListItemObject, organizationListItemObject, withToolAnnotations, workspaceContextObject } from './shared'

export const CONTEXT_TOOLS: McpToolDefinition[] = [
  globalTool(withToolAnnotations({
      name: 'get_workspace_context',
      description: "Read the selected business and location and the businesses available to the signed-in user. Selection uses the saved MCP workspace; without an accessible saved business, the only accessible business is selected, or no business is selected when several are available. Use the returned internal organization and location IDs in later tools.",
      domain: 'context',
      minimumRole: 'member',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      outputSchema: {
        type: 'object',
        properties: {
          context: workspaceContextObject,
          organizations: { type: 'array', items: organizationListItemObject },
          locations: { type: 'array', items: locationListItemObject },
        },
        required: ['context', 'organizations', 'locations'],
      },
    })),
  globalTool(withToolAnnotations({
      name: 'set_workspace_context',
      description: "Save the selected business or location for the signed-in user, shared across their MCP connections. Read get_workspace_context or list_organizations for organization IDs and list_locations for location IDs. Supply at least one ID. Omitted organization uses the current selection; omitted location keeps the saved location within the same business and is unset when changing businesses. Explicit IDs on later tools override this saved selection.",
      domain: 'context',
      minimumRole: 'member',
      inputSchema: {
        type: 'object',
        properties: {
          organization_id: { type: 'string', minLength: 1, pattern: '\\S' },
          location_id: { type: 'string', minLength: 1, pattern: '\\S', description: 'Internal location ID from list_locations or get_workspace_context, within the selected business.' },
        },
        anyOf: [{ required: ['organization_id'] }, { required: ['location_id'] }],
        additionalProperties: true,
      },
      outputSchema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          context: workspaceContextObject,
          organizations: { type: 'array', items: organizationListItemObject },
          locations: { type: 'array', items: locationListItemObject },
        },
        required: ['success', 'context', 'organizations', 'locations'],
      },
    })),
]
