import { defineHandler } from 'nitro'
import { readBody } from 'nitro/h3'

import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth } from '~/server/utils/auth'
import { LODGING_INTERNAL_CALLER, validateInternalRequest } from '~/server/utils/internal-secret'
import { organizationAdapter } from '~/server/utils/member-access'

const PAGE = 100
// D1 binds at most 100 parameters per statement; each list below shares its
// statement with one or two other parameters.
const MAX_IDS = 90

// Current members of one organization, who each one is, and their live session ids, for the
// lodging service's background work (push recipients, scheduled sends, socket
// re-validation), which runs with no user. It states facts; it grants nothing.
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const validation = await validateInternalRequest(event, env, LODGING_INTERNAL_CALLER)
  if (!validation.ok) return jsonResponse({ error: validation.error }, { status: validation.status })

  const body = await readBody<{ organizationId?: unknown; userIds?: unknown }>(event)
  const organizationId = typeof body?.organizationId === 'string' ? body.organizationId.trim() : ''
  if (!organizationId) return jsonResponse({ error: 'organizationId is required' }, { status: 400 })
  const userIds = body?.userIds
  if (userIds !== undefined && !(Array.isArray(userIds) && userIds.every(id => typeof id === 'string' && id))) {
    return jsonResponse({ error: 'userIds must be a list of user ids' }, { status: 400 })
  }
  if (Array.isArray(userIds) && userIds.length > MAX_IDS) {
    return jsonResponse({ error: `userIds may name at most ${MAX_IDS} users per request` }, { status: 400 })
  }

  const adapter = await organizationAdapter(env)
  if (!await adapter.findOrganizationById(organizationId)) return jsonResponse({ error: 'Organization not found' }, { status: 404 })

  const filter = userIds ? { field: 'userId', operator: 'in' as const, value: userIds as string[] } : undefined
  const members: { id: string; userId: string; role: string; user: { name: string; email: string; image?: string | null } }[] = []
  for (let offset = 0; ; offset += PAGE) {
    const page = await adapter.listMembers({ organizationId, filter, limit: PAGE, offset })
    members.push(...page.members)
    if (members.length >= page.total || page.members.length === 0) break
  }

  const context = await createAuth(env).$context
  const memberUserIds = [...new Set(members.map(member => member.userId))]
  const sessions: { id: string; userId: string }[] = []
  for (let start = 0; start < memberUserIds.length; start += MAX_IDS) {
    sessions.push(...await context.adapter.findMany<{ id: string; userId: string }>({
      model: 'session',
      where: [
        { field: 'userId', operator: 'in', value: memberUserIds.slice(start, start + MAX_IDS) },
        { field: 'expiresAt', operator: 'gt', value: new Date() },
      ],
      select: ['id', 'userId'],
    }))
  }

  return jsonResponse(members.map(member => ({
    userId: member.userId,
    memberId: member.id,
    role: member.role,
    name: member.user.name,
    email: member.user.email,
    image: member.user.image ?? null,
    sessionIds: sessions.filter(session => session.userId === member.userId).map(session => session.id),
  })))
})
