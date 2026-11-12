import { createAccessControl } from 'better-auth/plugins/access'
import { adminAc, defaultStatements, ownerAc } from 'better-auth/plugins/organization/access'

const statements = {
  ...defaultStatements,
  scheduling: ['own'],
  organization: ['read', 'update', 'delete'],
  members: ['read', 'invite', 'update', 'remove'],
  invitations: ['read', 'create', 'cancel'],
  locations: ['read', 'create', 'update', 'delete', 'assigned'],
  content: ['read', 'create', 'update', 'delete', 'publish'],
  media: ['read', 'create', 'update', 'delete'],
  blog: ['read', 'create', 'update', 'delete', 'publish'],
  products: ['read', 'create', 'update', 'delete', 'assigned'],
  analytics: ['read'],
  domains: ['read', 'create', 'update', 'delete'],
  payments: ['read', 'refund', 'disputes', 'payouts', 'integration'],
  billing: ['read', 'update'],
  settings: ['read', 'update'],
  integrations: ['read', 'create', 'update', 'delete'],
  operations: ['read', 'reply', 'update', 'assigned'],
  // Stored work: managers do everything; a member reads and completes the tasks
  // given to them, their team, or the homes they look after (server/domain/tasks.ts).
  task: ['read', 'create', 'assign', 'update', 'complete'],
  // Conversations between the organization's own members; every role takes part.
  team_messages: ['read', 'send'],
} as const

export const organizationAccessControl = createAccessControl(statements)

/**
 * A permission request against the statements above: `{ locations: ['read'] }`.
 *
 * Typed from `statements` so a resource or action this matrix does not declare
 * is a compile error rather than a check that silently answers false.
 */
export type OrganizationPermissions = {
  [Resource in keyof typeof statements]?: Array<(typeof statements)[Resource][number]>
}

const adminStatements = {
  ...adminAc.statements,
  scheduling: ['own'],
  organization: ['read', 'update'],
  members: ['read', 'invite', 'update', 'remove'],
  invitations: ['read', 'create', 'cancel'],
  locations: ['read', 'create', 'update', 'delete'],
  content: ['read', 'create', 'update', 'delete', 'publish'],
  media: ['read', 'create', 'update', 'delete'],
  blog: ['read', 'create', 'update', 'delete', 'publish'],
  products: ['read', 'create', 'update', 'delete'],
  operations: ['read', 'reply', 'update'],
  task: ['read', 'create', 'assign', 'update', 'complete'],
  analytics: ['read'],
  domains: ['read', 'create', 'update', 'delete'],
  payments: ['read', 'refund', 'disputes', 'payouts', 'integration'],
  billing: ['read'],
  settings: ['read', 'update'],
  integrations: ['read', 'create', 'update', 'delete'],
  team_messages: ['read', 'send'],
} as const

const ORGANIZATION_ROLE_LABELS: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' }

/** A member's role as the dashboard names it. */
export function organizationRoleLabel(role: string): string {
  const label = ORGANIZATION_ROLE_LABELS[role]
  if (!label) throw new Error(`Unknown organization role: ${role}`)
  return label
}

export const organizationRoles = {
  member: organizationAccessControl.newRole({
    scheduling: ['own'],
    products: ['assigned'],
    locations: ['assigned'],
    operations: ['assigned'],
    task: ['read', 'complete'],
    team_messages: ['read', 'send'],
  }),
  owner: organizationAccessControl.newRole({
    ...adminStatements,
    ...ownerAc.statements,
    organization: ['read', 'update', 'delete'],
    billing: ['read', 'update'],
  }),
  admin: organizationAccessControl.newRole(adminStatements),
}
