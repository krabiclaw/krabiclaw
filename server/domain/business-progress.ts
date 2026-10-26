import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryAllPages, queryFirst, type DbClient } from '~/server/db'
import { assertOrganizationWideAccess, assertRoleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { creationDedupeKey, creationRequestHash, isUniqueDedupeConflict, organizationEventQuery, readCreationRecord } from '~/server/utils/organization-events'
import { listBusinessOutcomes, readBusinessProgressReference } from '~/server/utils/business-outcomes'
import type { BusinessProgressReference } from '~/shared/business-outcomes'
import { createBusinessGoalSchema, recommendationFeedbackSchema, updateBusinessGoalSchema, type BusinessGoal, type RecommendationFeedback, type RecommendationFeedbackView } from '~/shared/business-progress'

interface GoalRow {
  id: string; intent: string; constraints: string | null; target_at: string | null; status: BusinessGoal['status']
  created_by_user_id: string | null; updated_by_user_id: string | null; created_at: string; updated_at: string
}
interface FeedbackRow {
  id: string; user_id: string; operation: RecommendationFeedback['operation']; subject_id: string; evidence_revision: string
  goal_id: string | null; goal_revision: string | null; decision: RecommendationFeedback['decision']; note: string | null
  defer_until: string | null; created_at: string; updated_at: string
}
const goalOf = (row: GoalRow): BusinessGoal => ({
  id: row.id, intent: row.intent, constraints: row.constraints, targetAt: row.target_at, status: row.status,
  createdBy: row.created_by_user_id, updatedBy: row.updated_by_user_id, createdAt: row.created_at, revision: row.updated_at,
})
const feedbackOf = (row: FeedbackRow): RecommendationFeedback => ({
  id: row.id, actorId: row.user_id, operation: row.operation, subjectId: row.subject_id, evidenceRevision: row.evidence_revision,
  goalId: row.goal_id, goalRevision: row.goal_revision, decision: row.decision, note: row.note,
  deferUntil: row.defer_until, createdAt: row.created_at, revision: row.updated_at,
})
const conflict = (message: string) => new HTTPError({ statusCode: 409, message, data: { code: 'PROGRESS_REVISION_CONFLICT' } })

async function authorize(db: DbClient, principal: MemberAccessPrincipal) {
  await assertOrganizationWideAccess(db, principal)
  await assertRoleAllows({ ...principal, permissions: { organization: ['update'] } })
}

async function readGoal(db: DbClient, organizationId: string, id: string): Promise<BusinessGoal> {
  const row = await queryFirst<GoalRow>(db, 'SELECT * FROM organization_goals WHERE organization_id = ? AND id = ?', [organizationId, id])
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Goal not found', data: { code: 'GOAL_NOT_FOUND' } })
  return goalOf(row)
}

export async function createBusinessGoal(db: DbClient, principal: MemberAccessPrincipal, body: unknown): Promise<BusinessGoal> {
  await authorize(db, principal)
  const parsed = createBusinessGoalSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid goal', data: parsed.error.flatten() })
  const { idempotencyKey, intent } = parsed.data
  const constraints = parsed.data.constraints ?? null, targetAt = parsed.data.targetAt ?? null
  const key = creationDedupeKey('organization_goal', principal.organizationId, idempotencyKey)
  const requestHash = await creationRequestHash({ actorId: principal.userId, intent, constraints, targetAt })
  const replay = async () => {
    const record = await readCreationRecord(db, key)
    if (!record) return null
    if (record.requestHash !== requestHash) throw conflict('This idempotency key already names a different goal request')
    return readGoal(db, principal.organizationId, record.entityId)
  }
  const previous = await replay()
  if (previous) return previous
  const id = crypto.randomUUID(), now = new Date().toISOString()
  try {
    await executeBatch(db, [
      { query: `INSERT INTO organization_goals(id, organization_id, intent, constraints, target_at, status, created_by_user_id, updated_by_user_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, params: [id, principal.organizationId, intent, constraints, targetAt, principal.userId, principal.userId, now, now] },
      organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType: 'goal.created', entityType: 'organization_goal', entityId: id,
        dedupeKey: key, afterState: { intent, constraints, targetAt, status: 'active' }, metadata: { request_hash: requestHash } }),
    ])
  } catch (error) {
    if (!isUniqueDedupeConflict(error)) throw error
    const concurrent = await replay()
    if (!concurrent) throw error
    return concurrent
  }
  return readGoal(db, principal.organizationId, id)
}

export async function updateBusinessGoal(db: DbClient, principal: MemberAccessPrincipal, id: string, body: unknown): Promise<BusinessGoal> {
  await authorize(db, principal)
  const parsed = updateBusinessGoalSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid goal update', data: parsed.error.flatten() })
  const current = await readGoal(db, principal.organizationId, id)
  const { revision, ...patch } = parsed.data
  if (current.revision !== revision) throw conflict('The goal changed; read its current revision before editing')
  const next = { intent: current.intent, constraints: current.constraints, targetAt: current.targetAt, status: current.status, ...patch }
  if (next.intent === current.intent && next.constraints === current.constraints && next.targetAt === current.targetAt && next.status === current.status) return current
  const now = new Date(Math.max(Date.now(), Date.parse(current.revision) + 1)).toISOString()
  const result = await executeBatch(db, [
    { query: `UPDATE organization_goals SET intent = ?, constraints = ?, target_at = ?, status = ?, updated_by_user_id = ?, updated_at = ?
      WHERE id = ? AND organization_id = ? AND updated_at = ?`, params: [next.intent, next.constraints, next.targetAt, next.status, principal.userId, now, id, principal.organizationId, revision] },
    organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType: 'goal.updated', entityType: 'organization_goal', entityId: id,
      beforeState: current, afterState: { ...next, revision: now }, onlyIfPreviousChangedOneRow: true }),
  ])
  if (result[0]?.meta.changes !== 1) throw conflict('The goal changed while this edit was being saved')
  return readGoal(db, principal.organizationId, id)
}

export async function saveRecommendationFeedback(db: DbClient, principal: MemberAccessPrincipal, body: unknown): Promise<RecommendationFeedback> {
  await authorize(db, principal)
  const parsed = recommendationFeedbackSchema.safeParse(body)
  if (!parsed.success) throw new HTTPError({ statusCode: 400, message: 'Invalid recommendation feedback', data: parsed.error.flatten() })
  const input = parsed.data, goalId = input.goalId ?? null, goalRevision = input.goalRevision ?? null
  const reference = await readBusinessProgressReference(db, principal, input)
  if (reference.evidenceRevision !== input.evidenceRevision) throw conflict('The evidence changed; reassess the current reference before recording feedback')
  if (goalId) {
    const goal = await readGoal(db, principal.organizationId, goalId)
    if (goal.revision !== goalRevision || goal.status !== 'active') throw conflict('The goal changed or was archived; reassess it before recording feedback')
  }
  const params = [principal.organizationId, principal.userId, input.operation, input.subjectId, input.evidenceRevision, goalId, goalRevision]
  const read = async () => {
    const row = await queryFirst<FeedbackRow>(db, `SELECT * FROM recommendation_feedback
      WHERE organization_id = ? AND user_id = ? AND operation = ? AND subject_id = ? AND evidence_revision = ? AND goal_id IS ? AND goal_revision IS ?`, params)
    return row ? feedbackOf(row) : null
  }
  const current = await read()
  const note = input.note ?? null, deferUntil = input.deferUntil ?? null
  const same = (value: RecommendationFeedback) => value.decision === input.decision && value.note === note && value.deferUntil === deferUntil
  if (current && same(current)) return current
  if ((current?.revision ?? null) !== (input.revision ?? null)) throw conflict('Feedback changed; read its current revision before editing')
  if (deferUntil && Date.parse(deferUntil) <= Date.now()) throw new HTTPError({ statusCode: 400, message: 'deferUntil must be in the future' })
  const id = current?.id ?? crypto.randomUUID()
  const now = new Date(Math.max(Date.now(), current ? Date.parse(current.revision) + 1 : 0)).toISOString()
  const mutation = current
    ? { query: `UPDATE recommendation_feedback SET decision = ?, note = ?, defer_until = ?, updated_at = ? WHERE id = ? AND organization_id = ? AND user_id = ? AND updated_at = ?`,
        params: [input.decision, note, deferUntil, now, id, principal.organizationId, principal.userId, current.revision] }
    : { query: `INSERT INTO recommendation_feedback(id, organization_id, user_id, operation, subject_id, evidence_revision, goal_id, goal_revision, decision, note, defer_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        params: [id, ...params, input.decision, note, deferUntil, now, now] }
  const results = await executeBatch(db, [mutation, organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId,
    eventType: 'recommendation.feedback', entityType: 'recommendation_feedback', entityId: id, beforeState: current,
    afterState: { operation: input.operation, subjectId: input.subjectId, evidenceRevision: input.evidenceRevision, goalId, goalRevision, decision: input.decision, note, deferUntil }, onlyIfPreviousChangedOneRow: true })])
  const saved = await read()
  if (!saved) throw new Error('Saved recommendation feedback could not be read')
  if (results[0]?.meta.changes !== 1 && !same(saved)) throw conflict('Feedback changed while this decision was being saved')
  return saved
}

export async function listBusinessGoals(db: DbClient, principal: MemberAccessPrincipal): Promise<BusinessGoal[]> {
  await authorize(db, principal)
  return (await queryAllPages<GoalRow>(db, 'SELECT * FROM organization_goals WHERE organization_id = ? ORDER BY updated_at DESC, id DESC', [principal.organizationId])).map(goalOf)
}

/** The same personal feedback source serves paged progress and on-demand selection. */
export async function listRecommendationFeedback(db: DbClient, principal: MemberAccessPrincipal, page?: { limit: number; offset: number }): Promise<RecommendationFeedback[]> {
  await authorize(db, principal)
  const sql = 'SELECT * FROM recommendation_feedback WHERE organization_id = ? AND user_id = ? ORDER BY updated_at DESC, id DESC'
  const params = [principal.organizationId, principal.userId]
  const rows = page
    ? await queryAll<FeedbackRow>(db, `${sql} LIMIT ? OFFSET ?`, [...params, page.limit + 1, page.offset])
    : await queryAllPages<FeedbackRow>(db, sql, params)
  return rows.map(feedbackOf)
}

export function recommendationFeedbackApplicability(value: RecommendationFeedback, reference: BusinessProgressReference | null, goals: BusinessGoal[], now: Date): RecommendationFeedbackView['applicability'] {
  const reasons: RecommendationFeedbackView['applicability']['reasons'] = []
  if (!reference) reasons.push('subject_missing')
  else if (reference.evidenceRevision !== value.evidenceRevision) reasons.push('evidence_changed')
  if (value.goalId) {
    const goal = goals.find(item => item.id === value.goalId)
    if (!goal || goal.revision !== value.goalRevision) reasons.push('goal_changed')
    if (goal?.status === 'archived') reasons.push('goal_archived')
  }
  if (value.deferUntil && Date.parse(value.deferUntil) <= now.getTime()) reasons.push('defer_elapsed')
  return { current: reasons.length === 0, reasons }
}

/** Authored intent, personal feedback and canonical evidence; no generated task, reward or completion store. */
export async function readBusinessProgress(db: DbClient, principal: MemberAccessPrincipal, page: { limit?: number; offset?: number } = {}) {
  await authorize(db, principal)
  const outcomes = await listBusinessOutcomes(db, principal, page)
  const { limit, offset } = outcomes.pagination
  const [goals, feedbackRows] = await Promise.all([listBusinessGoals(db, principal), listRecommendationFeedback(db, principal, { limit, offset })])
  const references = new Map<string, ReturnType<typeof readBusinessProgressReference>>()
  const now = new Date()
  const feedback = await Promise.all(feedbackRows.slice(0, limit).map(async (value): Promise<RecommendationFeedbackView> => {
    const key = JSON.stringify([value.operation, value.subjectId])
    if (!references.has(key)) references.set(key, readBusinessProgressReference(db, principal, value))
    let reference: BusinessProgressReference | null = null
    try {
      reference = await references.get(key)!
    } catch (error) {
      if (!(error instanceof HTTPError) || error.statusCode !== 404) throw error
    }
    return { ...value, applicability: recommendationFeedbackApplicability(value, reference, goals, now) }
  }))
  const hasMore = feedbackRows.length > limit
  return { goals, feedback, feedbackPagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null }, ...outcomes }
}
