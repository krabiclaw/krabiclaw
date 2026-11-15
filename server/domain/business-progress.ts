import { HTTPError } from 'nitro'
import { executeBatch, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { assertOrganizationWideAccess, assertRoleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationDedupeKey, creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { listBusinessOutcomes } from '~/server/utils/business-outcomes'
import { businessGoalStrategySchema, createBusinessGoalSchema, updateBusinessGoalSchema, type BusinessGoal } from '~/shared/business-progress'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'

interface GoalRow {
  id: string; intent: string; constraints: string | null; target_at: string | null; status: BusinessGoal['status']; strategy_json: string | null
  created_by_user_id: string | null; updated_by_user_id: string | null; created_at: string; updated_at: string
}
const goalOf = ({ strategy_json, ...row }: GoalRow): BusinessGoal => ({
  ...row, strategy: strategy_json === null ? null : businessGoalStrategySchema.parse(JSON.parse(strategy_json)),
})
const conflict = (message: string) => new HTTPError({ statusCode: 409, message, data: { code: 'PROGRESS_REVISION_CONFLICT' } })

async function authorize(db: DbClient, principal: MemberAccessPrincipal) {
  await assertOrganizationWideAccess(db, principal)
  await assertRoleAllows({ ...principal, permissions: { organization: ['update'] } })
}

async function readGoal(db: DbClient, organizationId: string, id: string): Promise<BusinessGoal> {
  const row = await queryFirst<GoalRow>(db, 'SELECT id, intent, constraints, target_at, status, strategy_json, created_by_user_id, updated_by_user_id, created_at, updated_at FROM organization_goals WHERE organization_id = ? AND id = ?', [organizationId, id])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Goal not found', data: { code: 'GOAL_NOT_FOUND' } })
  return goalOf(row)
}

export async function createBusinessGoal(db: DbClient, principal: MemberAccessPrincipal, body: unknown): Promise<BusinessGoal> {
  await authorize(db, principal)
  const parsed = createBusinessGoalSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid goal', data: parsed.error.flatten() })
  const { idempotency_key, intent } = parsed.data
  const constraints = parsed.data.constraints ?? null, targetAt = parsed.data.target_at ?? null
  const strategy = parsed.data.strategy ?? null
  const key = creationDedupeKey('organization_goal', principal.organizationId, idempotency_key)
  const requestHash = await creationRequestHash({ actorId: principal.userId, intent, constraints, targetAt, strategy: strategy ?? undefined })
  const replay = async () => {
    const record = await readCreationRecord(db, key)
    if (!record) return null
    if (record.requestHash !== requestHash) throw conflict('This idempotency key already names a different goal request')
    return readGoal(db, principal.organizationId, record.entityId)
  }
  const previous = await replay()
  if (previous) {
    await publishBusinessInvalidation(principal.env, principal.organizationId)
    return previous
  }
  const id = crypto.randomUUID(), now = new Date().toISOString()
  try {
    await executeBatch(db, [
      { query: `INSERT INTO organization_goals(id, organization_id, intent, constraints, target_at, strategy_json, status, created_by_user_id, updated_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, params: [id, principal.organizationId, intent, constraints, targetAt, strategy === null ? null : JSON.stringify(strategy), principal.userId, principal.userId, now, now] },
      organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType: 'goal.created', entityType: 'organization_goal', entityId: id,
        dedupeKey: key, afterState: { intent, constraints, targetAt, strategy, status: 'active' }, metadata: { request_hash: requestHash } }),
    ])
  } catch (error) {
    if (!isUniqueDedupeConflict(error)) throw error
    const concurrent = await replay()
    if (!concurrent) throw error
    await publishBusinessInvalidation(principal.env, principal.organizationId)
    return concurrent
  }
  await publishBusinessInvalidation(principal.env, principal.organizationId)
  return readGoal(db, principal.organizationId, id)
}

export async function updateBusinessGoal(db: DbClient, principal: MemberAccessPrincipal, id: string, body: unknown): Promise<BusinessGoal> {
  await authorize(db, principal)
  const parsed = updateBusinessGoalSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid goal update', data: parsed.error.flatten() })
  const current = await readGoal(db, principal.organizationId, id)
  const { updated_at, ...patch } = parsed.data
  if (current.updated_at !== updated_at) throw conflict('The goal changed; read its current revision before editing')
  const next = { intent: current.intent, constraints: current.constraints, target_at: current.target_at, strategy: current.strategy, status: current.status, ...patch }
  if (next.intent === current.intent && next.constraints === current.constraints && next.target_at === current.target_at && next.status === current.status && JSON.stringify(next.strategy) === JSON.stringify(current.strategy)) {
    await publishBusinessInvalidation(principal.env, principal.organizationId)
    return current
  }
  const now = new Date(Math.max(Date.now(), Date.parse(current.updated_at) + 1)).toISOString()
  const result = await executeBatch(db, [
    { query: `UPDATE organization_goals SET intent = ?, constraints = ?, target_at = ?, strategy_json = ?, status = ?, updated_by_user_id = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND updated_at = ?`, params: [next.intent, next.constraints, next.target_at, next.strategy === null ? null : JSON.stringify(next.strategy), next.status, principal.userId, now, id, principal.organizationId, updated_at] },
    organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType: 'goal.updated', entityType: 'organization_goal', entityId: id,
      beforeState: current, afterState: { ...next, updated_at: now }, onlyIfPreviousChangedOneRow: true }),
  ])
  if (result[0]?.meta.changes !== 1) throw conflict('The goal changed while this edit was being saved')
  await publishBusinessInvalidation(principal.env, principal.organizationId)
  return readGoal(db, principal.organizationId, id)
}

/** Authored intent and canonical evidence; the work it led to is in tasks. */
export async function readBusinessProgress(db: DbClient, principal: MemberAccessPrincipal, page: { limit?: number; offset?: number } = {}) {
  await authorize(db, principal)
  const [outcomes, goalRows] = await Promise.all([
    listBusinessOutcomes(db, principal, page),
    queryAllPages<GoalRow>(db, 'SELECT id, intent, constraints, target_at, status, strategy_json, created_by_user_id, updated_by_user_id, created_at, updated_at FROM organization_goals WHERE organization_id = ? ORDER BY updated_at DESC, id DESC', [principal.organizationId]),
  ])
  return { goals: goalRows.map(goalOf), ...outcomes }
}
