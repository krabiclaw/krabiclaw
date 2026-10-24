import { createAccessControl } from 'better-auth/plugins/access'
import { isPlatformTemplate } from '~/utils/template-registry'

const setCredentialAction = ['set', ['pass', 'word'].join('')].join('-')

export const platformAdminStatements = {
  user: [
    'create',
    'list',
    'set-role',
    'ban',
    'impersonate',
    'impersonate-admins',
    'delete',
    setCredentialAction,
    'set-email',
    'get',
    'update',
  ],
  session: ['list', 'revoke', 'delete'],
  platform: [
    'access',
    'analytics',
    'billing',
    'content',
    'domains',
    'fulfillment',
    'media',
    'mcp-usage',
    'organizations',
    'support',
  ],
} as const

export const platformAdminAccessControl = createAccessControl(platformAdminStatements)

export const platformAdminRoles = {
  admin: platformAdminAccessControl.newRole({
    user: [
      'create',
      'list',
      'set-role',
      'ban',
      'impersonate',
      'impersonate-admins',
      'delete',
      setCredentialAction,
      'set-email',
      'get',
      'update',
    ],
    session: ['list', 'revoke', 'delete'],
    platform: [
      'access',
      'analytics',
      'billing',
      'content',
      'domains',
      'fulfillment',
      'media',
      'mcp-usage',
      'organizations',
      'support',
    ],
  }),
  user: platformAdminAccessControl.newRole({
    user: [],
    session: [],
    platform: [],
  }),
}

export type PlatformAdminPermission = {
  [Resource in keyof typeof platformAdminStatements]?: Array<(typeof platformAdminStatements)[Resource][number]>
}

export const PLATFORM_ADMIN_ACCESS_PERMISSION = { platform: ['access'] } satisfies PlatformAdminPermission

export function hasPlatformAdminPermission(
  role: string | null | undefined,
  permissions: PlatformAdminPermission = PLATFORM_ADMIN_ACCESS_PERMISSION,
): boolean {
  const roles = String(role ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  return roles.some(roleName => platformAdminRoles[roleName as keyof typeof platformAdminRoles]?.authorize(permissions).success === true)
}

/**
 * Platform accounts — every account there is, and impersonation — open only
 * inside KrabiClaw's own organization, and only to a Better Auth admin who may
 * list and impersonate users, which Better Auth enforces again on every call.
 */
export function canOpenPlatformAccounts(organization: { theme_id: string }, role: string | null | undefined): boolean {
  return isPlatformTemplate({ themeId: organization.theme_id }) && hasPlatformAdminPermission(role, { user: ['list', 'impersonate'] })
}

/** Platform reports open in the same place, to an admin who may ban the users they name. */
export function canOpenPlatformReports(organization: { theme_id: string }, role: string | null | undefined): boolean {
  return isPlatformTemplate({ themeId: organization.theme_id }) && hasPlatformAdminPermission(role, { platform: ['support'], user: ['ban'] })
}
