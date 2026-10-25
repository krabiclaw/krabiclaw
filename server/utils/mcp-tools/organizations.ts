import type { McpToolDefinition } from './shared'
import { HTTPError } from 'nitro'
import { SUPPORTED_CURRENCIES, currentUserObject, globalTool, pageInfoObject, paginationInputSchema, organizationSummaryItem, organizationTool, withToolAnnotations, workspaceContextObject, PHONE_FORMAT } from './shared'
import { ALL_VERTICALS } from '~/utils/vertical-copy'
import { PLATFORM_LOCALES } from '~/shared/platform-locales'
import { timezoneSchema } from '~/utils/timezone'
import { setPublicConsultationMode } from '~/server/utils/professional-services'
import type { McpExecutorContext } from './execution'
import { MCP_ERROR, mcpProtocolError } from '~/server/utils/mcp-protocol'
import { getOrganizationForMcp } from '~/server/utils/mcp-workflows'
import { resolveMcpWorkspace } from '~/server/utils/mcp-context'
import { loadSettingsPayload, updateOrganizationSettingsFields } from '~/server/utils/organization-settings'
import { ORGANIZATION_FONT_OPTIONS, ORGANIZATION_FONT_PRESETS } from '~/shared/organization-fonts'
import { SITE_PALETTE_ROLES, STARTER_PALETTES, paletteContrast, type SitePalettePatch } from '~/shared/site-palette'
import { SITE_RECIPE_DESCRIPTIONS, SITE_RECIPE_KEYS, SITE_RECIPE_OPTIONS } from '~/shared/site-recipe'
import { resolveColor } from '~/utils/color-utils'
import { requireMcpOrganizationApi } from '~/server/utils/mcp-auth'
import { organizationRoles } from '~/utils/organization-access'
import { getOrganizationTeamsData, getInvitationDeliveries } from '~/server/utils/dashboard-members'
import { assertRoleAllows, organizationAdapter } from '~/server/utils/member-access'

const PALETTE_COLORS_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(SITE_PALETTE_ROLES.map(entry => [entry.role, { type: 'string', description: entry.rule }])),
  additionalProperties: false,
} as const
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { NOT_HANDLED, assertDomainSuccess, mutationContextPayload, requiredString, workspaceContextPayload } from './execution'

const ORGANIZATION_MEDIA_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    asset_id: { type: 'string' },
    slot: { type: 'string' },
    public_url: { type: ['string', 'null'] },
    thumbnail_url: { type: ['string', 'null'] },
    kind: { type: 'string' },
  },
  required: ['asset_id', 'slot', 'public_url', 'thumbnail_url', 'kind'],
} as const

const ANNOUNCEMENT_SCHEMA = {
  type: ['object', 'null'],
  description: 'The universal announcement banner or modal shown to visitors on the public website, available to every theme. An image, when set, is a separate organization media placement (slot "announcement"), not a field here.',
  properties: {
    headline: { type: 'string', maxLength: 120, description: 'Required in every write, even an empty string when disabling without discarding it.' },
    description: { type: ['string', 'null'], maxLength: 500 },
    cta_label: { type: ['string', 'null'], description: 'Button label. Requires cta_url and vice versa.' },
    cta_url: { type: ['string', 'null'], description: 'Button destination, http or https. Requires cta_label and vice versa.' },
    dismissible: { type: 'boolean', description: 'Whether a visitor who closes it will not be shown it again on that device.' },
    enabled: { type: 'boolean', description: 'Whether the announcement is currently shown. false keeps the saved content without showing it.' },
    format: { type: 'string', enum: ['modal', 'banner'], description: 'Display style: modal popup dialog or top banner bar (default modal).' },
  },
  required: ['headline'],
} as const
const ANNOUNCEMENT_READ_SCHEMA = { type: ['object', 'null'], properties: {
  headline: { type: 'string' }, description: { type: ['string', 'null'] }, cta_label: { type: ['string', 'null'] }, cta_url: { type: ['string', 'null'] },
  dismissible: { type: 'boolean' }, enabled: { type: 'boolean' }, format: { type: 'string', enum: ['modal', 'banner'] },
} } as const

const memberObject = { type: 'object', properties: {
  id: { type: 'string' }, organizationId: { type: 'string' }, userId: { type: 'string' }, role: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
}, required: ['id', 'organizationId', 'userId', 'role', 'createdAt'] } as const
const invitationObject = { type: 'object', properties: {
  id: { type: 'string' }, email: { type: 'string' }, role: { type: 'string' }, status: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' },
  delivery: { type: ['object','null'], properties: {status:{type:'string'},error:{type:['string','null']}}, required:['status','error'] },
}, required: ['id', 'email', 'role', 'status', 'expiresAt','delivery'], additionalProperties: false } as const
const roleField = { type: 'string', enum: Object.keys(organizationRoles) }
const teamObject = { type: 'object', properties: {
  id: { type: 'string' }, name: { type: 'string' }, organizationId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  members: { type: 'array', items: { type: 'object', properties: {
    id: { type: 'string' }, teamId: { type: 'string' }, userId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
  }, required: ['id', 'teamId', 'userId', 'createdAt'] } },
}, required: ['id', 'name', 'organizationId', 'createdAt', 'members'] } as const
const teamOutput = { type: 'object', properties: { team: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'], additionalProperties: false } }, required: ['team'] }

const websiteDraftLocationSchema = {
  type: 'object', properties: {
    street_address: { type: 'string' }, address_line_2: { type: 'string' }, city: { type: 'string' }, region: { type: 'string' }, postal_code: { type: 'string' },
    country: { type: 'string', pattern: '^[A-Z]{2}$' }, phone: { type: 'string', description: PHONE_FORMAT }, website_url: { type: 'string', format: 'uri' },
  }, additionalProperties: false,
} as const
const websiteDraftProductSchema = {
  type: 'object', properties: { name: { type: 'string', minLength: 1, pattern: '\\S' }, category: { type: 'string' }, amount_minor: { type: 'integer', minimum: 0 } },
  required: ['name'], additionalProperties: false,
} as const
const websiteDraftOutputSchema = {
  type: 'object', properties: {
    draft_id: { type: 'string' }, revision: { type: 'string', format: 'date-time' }, organization_id: { type: 'string' }, idempotency_key: { type: 'string' },
    status: { type: 'string', enum: ['active', 'committed'] }, subdomain: { type: 'string' },
    name: { type: 'string' }, vertical: { type: 'string', enum: ALL_VERTICALS }, source_locale: { type: 'string' },
    currency: { type: 'string' }, timezone: { type: 'string' }, location: websiteDraftLocationSchema,
    hero_headline: { type: 'string' }, hero_subtitle: { type: 'string' }, products: { type: 'array', items: websiteDraftProductSchema },
    missing_fields: { type: 'array', items: { type: 'string', enum: ['source_locale', 'currency', 'timezone', 'subdomain'] } },
  }, required: ['draft_id', 'revision', 'status', 'subdomain', 'name', 'vertical', 'source_locale', 'location', 'products', 'missing_fields'], additionalProperties: false,
} as const

export const ORGANIZATIONS_TOOLS: McpToolDefinition[] = [
  globalTool(withToolAnnotations({
    name: 'get_website_draft', description: 'Read your saved website setup. Omit draft_id to resume your unfinished website.',
    domain: 'organizations', minimumRole: 'admin',
    inputSchema: { type: 'object', properties: { draft_id: { type: 'string', minLength: 1 } }, additionalProperties: false },
    outputSchema: websiteDraftOutputSchema,
  })),
  globalTool(withToolAnnotations({
    name: 'save_website_draft', description: 'Save website answers without publishing. Use the returned draft_id and revision for changes; reuse the creation key on retry.',
    domain: 'organizations', minimumRole: 'admin',
    inputSchema: { type: 'object', properties: {
      draft_id: { type: 'string', minLength: 1, description: 'Existing draft to edit; omit when creating.' }, revision: { type: 'string', format: 'date-time', description: 'Required when editing: the revision returned by get_website_draft.' },
      idempotency_key: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
      name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S', description: 'Required when creating; omitted on an edit to retain it.' },
      vertical: { type: 'string', enum: ALL_VERTICALS, description: 'Required when creating; omitted on an edit to retain it.' }, source_locale: { type: 'string', enum: PLATFORM_LOCALES.map(locale => locale.locale), description: 'Required when creating; a saved draft cannot be relabelled into another language.' },
      currency: { type: 'string', enum: SUPPORTED_CURRENCIES }, timezone: timezoneSchema,
      subdomain: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$' },
      location: websiteDraftLocationSchema,
      hero_headline: { type: 'string', maxLength: 500 }, hero_subtitle: { type: 'string', maxLength: 2000 },
      products: { type: 'array', items: websiteDraftProductSchema },
    }, required: ['idempotency_key'], additionalProperties: false },
    outputSchema: websiteDraftOutputSchema,
  })),
  globalTool(withToolAnnotations({
    name: 'publish_website', description: 'Publish a saved website draft, select it as your workspace and notify KrabiClaw operators by email. Finish any returned missing fields before retrying.',
    domain: 'organizations', minimumRole: 'admin',
    inputSchema: { type: 'object', properties: { draft_id: { type: 'string', minLength: 1 }, revision: { type: 'string', format: 'date-time' } }, required: ['draft_id', 'revision'], additionalProperties: false },
    outputSchema: { type: 'object', properties: {
      organization_id: { type: 'string' }, location_id: { type: 'string' }, draft_id: { type: 'string' },
      public_url: { type: 'string', format: 'uri' }, ready: { const: true }, context: workspaceContextObject,
    }, required: ['organization_id', 'location_id', 'draft_id', 'public_url', 'ready', 'context'], additionalProperties: false },
  })),
  organizationTool({
    name: 'list_teams', description: 'Read the business’s Better Auth teams and their members. Choose a team for an offering when any available member can host its bookings.',
    domain: 'organizations', minimumRole: 'admin', outputSchema: { type: 'object', properties: { teams: { type: 'array', items: teamObject } }, required: ['teams'] },
  }),
  organizationTool({
    name: 'create_team', description: 'Create a named team within this business using Better Auth. Existing teammates can then be added to it.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { name: { type: 'string', minLength: 1, pattern: '\\S' } }, required: ['name'], outputSchema: teamOutput,
  }),
  organizationTool({
    name: 'update_team', description: 'Rename a team in this business.', domain: 'organizations', minimumRole: 'admin', inputSchema: { team_id: { type: 'string' }, name: { type: 'string', minLength: 1, pattern: '\\S' } }, required: ['team_id', 'name'], outputSchema: teamOutput,
  }),
  organizationTool({
    name: 'set_team_member', description: 'Add an existing business teammate to a team, or remove them from it. Existing bookings keep their saved provider.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { team_id: { type: 'string' }, user_id: { type: 'string' }, included: { type: 'boolean' } }, required: ['team_id', 'user_id', 'included'], outputSchema: { type: 'object', properties: { team_id: { type: 'string' }, user_id: { type: 'string' }, included: { type: 'boolean' } }, required: ['team_id', 'user_id', 'included'], additionalProperties: false },
  }),
  organizationTool({
    name: 'delete_team', description: 'Delete a team from this business. Existing bookings keep their saved provider. Offerings assigned to this team require a new schedule assignment.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { team_id: { type: 'string' } }, required: ['team_id'],
    outputSchema: { type: 'object', properties: { deleted: { const: true }, team_id: { type: 'string' } }, required: ['deleted', 'team_id'] },
  }),
  organizationTool({
    name: 'list_organization_members', description: 'Read the business’s teammates and invitations. Member IDs identify organization memberships; user IDs identify people.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } },
    outputSchema: { type: 'object', properties: { members: { type: 'array', items: { ...memberObject, properties: { ...memberObject.properties, user: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' }, image: { type: ['string', 'null'] } }, required: ['id', 'name', 'email'] } }, required: [...memberObject.required, 'user'] } }, total: { type: 'integer', minimum: 0 }, invitations: { type: 'array', items: invitationObject } }, required: ['members', 'total', 'invitations'], additionalProperties: false },
  }),
  organizationTool({
    name: 'invite_organization_member', description: 'Invite a teammate by email using Better Auth. The invitation remains pending until they accept. Set resend only when the user wants an existing invitation sent again.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { email: { type: 'string', format: 'email' }, role: roleField, resend: { type: 'boolean' } }, required: ['email', 'role'],
    outputSchema: { type: 'object', properties: { invitation: invitationObject }, required: ['invitation'], additionalProperties: false },
  }),
  organizationTool({
    name: 'update_organization_member_role', description: 'Change a teammate’s business role. Better Auth enforces owner privileges and protects the last owner.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { member_id: { type: 'string' }, role: roleField }, required: ['member_id', 'role'],
    outputSchema: { type: 'object', properties: { member: memberObject }, required: ['member'], additionalProperties: false },
  }),
  organizationTool({
    name: 'remove_organization_member', description: 'Remove a teammate’s membership in this business. Better Auth enforces removal permissions and protects the last owner.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { member_id: { type: 'string' } }, required: ['member_id'],
    outputSchema: { type: 'object', properties: { member: memberObject }, required: ['member'], additionalProperties: false },
  }),
  organizationTool({
    name: 'cancel_organization_invitation', description: 'Cancel a pending invitation to this business.',
    domain: 'organizations', minimumRole: 'admin', inputSchema: { invitation_id: { type: 'string' } }, required: ['invitation_id'],
    outputSchema: { type: 'object', properties: { invitation: invitationObject }, required: ['invitation'], additionalProperties: false },
  }),
  globalTool(withToolAnnotations({
      name: 'list_organizations',
      description: "List sites available to the signed-in user and the current account identity. Match the requested site against these results and use its internal ID; a public URL, domain or business name is not an organization_id.",
      domain: 'organizations',
      minimumRole: 'admin',
      inputSchema: { type: 'object', properties: { ...paginationInputSchema }, additionalProperties: true },
      outputSchema: {
        type: 'object',
        properties: {
          organizations: {
            type: 'array',
            items: organizationSummaryItem,
          },
          currentUser: currentUserObject,
          page_info: pageInfoObject,
        },
        required: ['organizations', 'currentUser', 'page_info'],
      },
    })),
  organizationTool({
      name: 'get_organization',
      description: "Read the selected KrabiClaw site’s identity, public address and settings. organization_id is the internal ID returned by get_workspace_context or list_organizations, not a URL, domain or business name.",
      domain: 'organizations',
      minimumRole: 'admin',
      outputSchema: {
        type: 'object',
        properties: {
          organization: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              organization_id: { type: 'string' },
              subdomain: { type: 'string' },
              theme: { type: 'string' },
              status: { type: 'string' },
              name: { type: ['string', 'null'] },
              brand_description: { type: ['string', 'null'] },
              media: { type: 'array', items: ORGANIZATION_MEDIA_ITEM_SCHEMA },
              public_url: { type: ['string', 'null'] },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
            required: ['id', 'subdomain', 'status'],
          },
        },
        required: ['organization'],
      },
    }),
  organizationTool({
      name: 'get_organization_settings',
      description: "Read editable settings for the selected KrabiClaw site. Use its internal organization_id from get_workspace_context or list_organizations, not its public URL, domain or name.",
      domain: 'organizations',
      minimumRole: 'admin',
      outputSchema: {
        type: 'object',
        properties: {
          settings: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              organization_id: { type: 'string' },
              subdomain: { type: 'string' },
              theme: { type: 'string' },
              status: { type: 'string' },
              public_url: { type: ['string', 'null'] },
              custom_domain_status: { type: ['string', 'null'] },
              name: { type: ['string', 'null'] },
              brand_description: { type: ['string', 'null'] },
              font_preset: { type: 'string', enum: [...ORGANIZATION_FONT_PRESETS] },
              ...Object.fromEntries(SITE_RECIPE_KEYS.map(key => [key, { type: 'string', enum: [...SITE_RECIPE_OPTIONS[key]], description: `${SITE_RECIPE_DESCRIPTIONS[key]} Absent when the site uses the Default.` }])),
              palette: { type: ['object', 'null'], description: 'The colors the site renders, light and dark: its own, or the default. Null on KrabiClaw\'s own site.', properties: { light: PALETTE_COLORS_SCHEMA, dark: PALETTE_COLORS_SCHEMA } },
              palette_source: { type: ['string', 'null'], enum: ['custom', 'default', null] },
              announcement: ANNOUNCEMENT_READ_SCHEMA,
              media: { type: 'array', items: ORGANIZATION_MEDIA_ITEM_SCHEMA },
              contact_email: { type: ['string', 'null'] },
              address_visibility: { type: 'string', enum: ['visible', 'hidden'] },
              default_currency: { type: 'string' },
              timezone: { type: 'string' },
              press_email: { type: ['string', 'null'] },
              partnerships_email: { type: ['string', 'null'] },
              catering_email: { type: ['string', 'null'] },
              careers_email: { type: ['string', 'null'] },
              google_analytics_measurement_id: { type: ['string', 'null'] },
              seo_title: { type: ['string', 'null'] },
              seo_description: { type: ['string', 'null'] },
              canonical_url: { type: ['string', 'null'] },
              created_at: { type: 'string' },
              updated_at: { type: 'string' },
            },
            required: ['id', 'subdomain', 'default_currency', 'timezone'],
          },
        },
        required: ['settings'],
      },
    }),
  organizationTool({
      name: 'update_organization_settings',
      description: "Change the selected site’s brand, description, website font, colors, button and heading styling, contact email, default currency, visitor announcement banner/popup or Live/Draft status. Only supplied settings change. An announcement replaces all its fields, and null removes it. Logos and announcement images are separate media placements; this tool does not change them. Returns the updated settings. Published website settings change immediately; this does not create a short post, blog article or social publication.",
      domain: 'organizations',
      minimumRole: 'admin',
      inputSchema: {
        name: { type: 'string' },
        brand_description: { type: 'string' },
        font_preset: { type: 'string', enum: [...ORGANIZATION_FONT_PRESETS], description: `Website heading and body fonts, on every template: ${ORGANIZATION_FONT_OPTIONS.map(option => `${option.value} (${option.label})`).join(', ')}. Thai, Vietnamese and Japanese text renders in every choice.` },
        ...Object.fromEntries(SITE_RECIPE_KEYS.map(key => [key, { type: 'string', enum: [...SITE_RECIPE_OPTIONS[key]], description: SITE_RECIPE_DESCRIPTIONS[key] }])),
        palette: {
          type: ['object', 'null'],
          description: `Website colors, each with a light and a dark value. Roles: ${SITE_PALETTE_ROLES.map(entry => `${entry.role} (${entry.rule})`).join(' ')} Start from a starter (${STARTER_PALETTES.map(entry => entry.id).join(', ')}) and/or name only the roles to change; colors are #RRGGBB or a plain description such as "forest green". Borders and tints are derived. null returns to the default colors. The result reports any text or button pair below WCAG AA contrast.`,
          properties: {
            starter: { type: 'string', enum: STARTER_PALETTES.map(entry => entry.id) },
            light: PALETTE_COLORS_SCHEMA,
            dark: PALETTE_COLORS_SCHEMA,
          },
          additionalProperties: false,
        },
        announcement: ANNOUNCEMENT_SCHEMA,
        contact_email: { type: ['string', 'null'], description: 'Public contact email shown to guests. Pass null to clear it.' },
        address_visibility: { type: 'string', enum: ['visible', 'hidden'], description: 'Show or hide office addresses on service websites.' },
        default_currency: { type: 'string', enum: [...SUPPORTED_CURRENCIES], description: 'ISO 4217 code. Existing prices keep their stored currency and amount; nothing is converted.' },
        timezone: { ...timezoneSchema, description: 'The business\'s reporting timezone: the day boundaries of its analytics. Bookings keep their location\'s or provider\'s timezone.' },
        status: { type: 'string', enum: ['published', 'draft', 'active', 'inactive'], description: 'Website status: published/active is Live (public and indexable), draft/inactive is Draft (preview only). A suspended website cannot be changed.' },
        press_email: { type: 'string' },
        partnerships_email: { type: 'string' },
        catering_email: { type: 'string' },
        careers_email: { type: 'string' },
      },
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          entity: { type: 'string', enum: ['organization_settings'] },
          id: { type: 'string' },
          changed_fields: { type: 'array', items: { type: 'string' } },
          saved_fields: { type: 'object', description: 'Persisted values of only the supplied settings, keyed by changed_fields.' },
          address_visibility: { type: 'string', enum: ['visible', 'hidden'] },
          contrast_warnings: { type: 'array', items: { type: 'object', properties: { mode: { type: 'string' }, pair: { type: 'string' }, ratio: { type: 'number' }, minimum: { type: 'number' } }, required: ['mode', 'pair', 'ratio', 'minimum'] } },
          updated_at: { type: 'string' },
          context: workspaceContextObject,
        },
        required: ['ok', 'entity', 'id', 'changed_fields', 'saved_fields'],
      },
    }),
  organizationTool({
      name: 'set_consultation_mode',
      description: 'Choose native legal consultation bookings, an external scheduler, or Contact on the Schedule page. Supply external_url to connect a scheduler; omission retains the saved URL. Null clears the URL only when not using the external scheduler.',
      domain: 'organizations', minimumRole: 'admin', inputSchema: { mode: { type: 'string', enum: ['native', 'external_url', 'native_disabled'] }, external_url: { type: ['string', 'null'] } },
      required: ['mode'],
      outputSchema: { type: 'object', properties: { settings: { type: 'object', properties: { mode: { type: 'string', enum: ['native', 'external_url', 'native_disabled'] }, external_url: { type: ['string', 'null'] } }, required: ['mode', 'external_url'] } }, required: ['settings'] },
    }),
]

// MCP callers may describe a color in words; the stored palette holds hex only.
function resolvePaletteColorNames(patch: SitePalettePatch): SitePalettePatch {
  const resolveMode = (colors: SitePalettePatch['light']) => colors && Object.fromEntries(Object.entries(colors).map(([role, value]) => {
    const resolved = typeof value === 'string' ? resolveColor(value) : null
    if (!resolved) throw mcpProtocolError(MCP_ERROR.invalidParams, `Unsupported color for ${role}: ${String(value)}`)
    return [role, resolved]
  }))
  return { ...patch, ...(patch.light && { light: resolveMode(patch.light) }), ...(patch.dark && { dark: resolveMode(patch.dark) }) }
}

export async function handleOrganizationsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  switch (toolName) {
    case 'list_teams': return { teams: await getOrganizationTeamsData(organization.env, organization.organizationId) }
    case 'create_team':
    case 'update_team':
    case 'set_team_member':
    case 'delete_team': {
      const { api, headers } = await requireMcpOrganizationApi(ctx.event, organization)
      const organizationId = organization.organizationId
      let teamId: string
      if (toolName === 'create_team') teamId = (await api.createTeam({ headers, body: { organizationId, name: requiredString(args, 'name') } })).id
      else {
        teamId = requiredString(args, 'team_id')
        if (toolName === 'update_team') await api.updateTeam({ headers, body: { teamId, data: { organizationId, name: requiredString(args, 'name') } } })
        else if (toolName === 'delete_team') await api.removeTeam({ headers, body: { teamId, organizationId } })
        else {
          const body = { teamId, organizationId, userId: requiredString(args, 'user_id') }
          if (args.included === true) await api.addTeamMember({ headers, body })
          else await api.removeTeamMember({ headers, body })
        }
      }
      const team = (await getOrganizationTeamsData(organization.env, organizationId)).find(team => team.id === teamId)
      if (toolName === 'delete_team') {
        if (team) throw new Error('The deleted team is still present')
        return { deleted: true, team_id: teamId }
      }
      if (!team) throw new Error('The saved team could not be read back')
      if (toolName === 'set_team_member') {
        const included = team.members.some(member => member.userId === args.user_id)
        if (included !== args.included) throw new Error('The saved team membership does not match the requested change')
        return { team_id: team.id, user_id: requiredString(args, 'user_id'), included }
      }
      return { team: { id: team.id, name: team.name } }
    }
    case 'list_organization_members': {
      await assertRoleAllows({ ...organization.membership, permissions: { members: ['read'], invitations: ['read'] } })
      const adapter = await organizationAdapter(organization.env)
      const [result, invitations] = await Promise.all([
        adapter.listMembers({ organizationId: organization.organizationId, limit: args.limit as number | undefined, offset: args.offset as number | undefined }),
        adapter.listInvitations({ organizationId: organization.organizationId }),
      ])
      const deliveries = await getInvitationDeliveries(organization.db, organization.organizationId, invitations)
      return { ...result, invitations: invitations.map(invitation => {
        const delivery = deliveries.get(invitation.id)
        return { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt, delivery: delivery ? { status: delivery.status, error: delivery.error } : null }
      }) }
    }
    case 'invite_organization_member': {
      const { api, headers } = await requireMcpOrganizationApi(ctx.event, organization)
      const invitation = await api.createInvitation({ headers, body: { organizationId: organization.organizationId, email: requiredString(args, 'email'), role: requiredString(args, 'role') as keyof typeof organizationRoles, resend: args.resend === true } })
      const delivery = (await getInvitationDeliveries(organization.db, organization.organizationId, [invitation])).get(invitation.id) ?? null
      if (!delivery || ['failed','pending'].includes(delivery.status)) throw new HTTPError({statusCode:502,statusMessage:delivery?.error ?? 'Invitation was saved, but its email delivery is unconfirmed',data:{invitation_id: typeof invitation.id === 'string' && invitation.id.trim() ? invitation.id : undefined}})
      return { invitation: { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt, delivery: { status: delivery.status, error: delivery.error } } }
    }
    case 'update_organization_member_role': {
      const { api, headers } = await requireMcpOrganizationApi(ctx.event, organization)
      const member = await api.updateMemberRole({ headers, body: { organizationId: organization.organizationId, memberId: requiredString(args, 'member_id'), role: requiredString(args, 'role') } })
      return { member }
    }
    case 'remove_organization_member': {
      const { api, headers } = await requireMcpOrganizationApi(ctx.event, organization)
      const result = await api.removeMember({ headers, body: { organizationId: organization.organizationId, memberIdOrEmail: requiredString(args, 'member_id') } })
      return { member: result.member }
    }
    case 'cancel_organization_invitation': {
      const { api, headers } = await requireMcpOrganizationApi(ctx.event, organization)
      const invitationId = requiredString(args, 'invitation_id')
      const invitations = await api.listInvitations({ headers, query: { organizationId: organization.organizationId } })
      if (!invitations.some(invitation => invitation.id === invitationId)) throw new HTTPError({ statusCode: 404, statusMessage: 'Invitation not found in this business' })
      const invitation = await api.cancelInvitation({ headers, body: { invitationId } })
      if (!invitation) throw new Error('Better Auth did not return the cancelled invitation')
      const delivery = (await getInvitationDeliveries(organization.db, organization.organizationId, [invitation])).get(invitation.id)
      return { invitation: { id: invitation.id, email: invitation.email, role: invitation.role, status: invitation.status, expiresAt: invitation.expiresAt, delivery: delivery ? { status: delivery.status, error: delivery.error } : null } }
    }
    case "get_organization":
      {
        const organizationRecord = await getOrganizationForMcp(
          organization.db,
          organization.env,
          organization.organizationId,
          organization.userId,
        );
        const workspace = await resolveMcpWorkspace(
          organization.db,
          organization.env,
          organization.userId,
          { organizationId: organization.organizationId },
        );
        return {
          organization: organizationRecord,
          context: workspaceContextPayload(workspace.organization, workspace.location),
        };
      }
    case "get_organization_settings":
      return {
        settings: await loadSettingsPayload(
          organization.db,
          organization.env,
          organization.organizationId,

        ),
      };
    case "update_organization_settings": {
      const updates = { ...args } as Record<
        string,
        unknown
      >;
      if (updates.status === 'published') {
        updates.status = 'active';
      } else if (updates.status === 'draft') {
        updates.status = 'inactive';
      }
      if (updates.palette && typeof updates.palette === 'object') updates.palette = resolvePaletteColorNames(updates.palette as SitePalettePatch);
      const result = await updateOrganizationSettingsFields(
        organization.db,
        organization.env,
        organization.organizationId,
        updates,
        organization.userId
      );
      assertDomainSuccess(result);
      const settingsResult = (result.data as { settings: Awaited<ReturnType<typeof loadSettingsPayload>> }).settings;
      const updateSettingsContext = await mutationContextPayload(organization);
      return renderStructuredResponse(
        {
          ok: true,
          entity: "organization_settings",
          id: organization.organizationId,
          changed_fields: Object.keys(updates),
          saved_fields: Object.fromEntries(Object.keys(updates).map(key => [key, settingsResult[key as keyof typeof settingsResult]])),
          ...(settingsResult.address_visibility !== undefined ? { address_visibility: settingsResult.address_visibility } : {}),
          contrast_warnings: settingsResult.palette ? paletteContrast(settingsResult.palette).filter(check => check.ratio < check.minimum) : [],
          updated_at: settingsResult.updated_at,
          context: updateSettingsContext,
        },
        "Updated organization settings.",
      );
    }
    case "set_consultation_mode": {
      const saved = await setPublicConsultationMode(organization.db, organization.organizationId, requiredString(args, 'mode') as 'native' | 'external_url' | 'native_disabled', args.external_url)
      return { settings: { mode: saved.mode, external_url: saved.external_url } }
    }
    default:
      return NOT_HANDLED
  }
}
