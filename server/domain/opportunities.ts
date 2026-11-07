import { HTTPError } from 'nitro'
import { executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, type MemberAccessPrincipal } from '~/server/utils/member-access'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { publishBusinessInvalidation } from '~/server/cloudflare/guest-inbox-events'
import { readBusinessRecommendations, type BusinessRecommendation } from '~/server/domain/business-progress'
import { getTask, opportunityTaskInsert, readTaskAssignee, taskViewer, type TaskRow, type TaskView } from '~/server/domain/tasks'
import type { BusinessProgressOperation } from '~/shared/business-outcomes'
import { isValidInstant, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import type { CloudflareEnv } from '~/server/utils/auth'

/*
  Something the business could do. The selector (readBusinessRecommendations)
  finds them from the business's own records each time they are read; this
  records each one against its evidence revision, so the owner's decision
  about it is the business's and lasts until the evidence changes. Accepting
  makes it a task; dismissing records why; deferring hides it until a time.
*/

type OpportunityStatus = 'open' | 'accepted' | 'dismissed' | 'superseded'
interface OpportunityRow {
  id: string; organization_id: string; operation: BusinessProgressOperation; subject_id: string; evidence_revision: string
  goal_id: string | null; goal_revision: string | null; status: OpportunityStatus; available_at: string | null
  decision_note: string | null; decided_at: string | null; decided_by_user_id: string | null; created_at: string; updated_at: string
}

/** An opportunity as the insight face of the `.tc` card draws it. */
export interface OpportunityView {
  id: string
  /** What part of the business, and where: "Calendar · 45B", "Website". */
  statusLine: string
  title: string
  detail: string
  icon: string
  /** Where the owner does it in the dashboard. */
  path: string
  productId: string | null
  locationId: string | null
}

const AREA: Record<BusinessProgressOperation, string> = {
  'article.create': 'Website', 'article.update': 'Website', 'article.publish': 'Website', 'article.distribute': 'Social',
  'post.create': 'Social', 'post.publish': 'Social', 'social.connect': 'Social', 'google_ads.connect': 'Marketing',
  'payments.connect': 'Payments', 'product.payment': 'Payments', 'stay.gap': 'Calendar', 'guest_thread.reply': 'Messages',
}

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, message, data: { code, ...(field ? { field } : {}) } })
}

const keyOf = (value: { operation: string; subjectId: string; evidenceRevision: string; goalId: string | null }) => JSON.stringify([value.operation, value.subjectId, value.evidenceRevision, value.goalId])
const rowKey = (row: OpportunityRow) => keyOf({ operation: row.operation, subjectId: row.subject_id, evidenceRevision: row.evidence_revision, goalId: row.goal_id })
const recommendationKey = (item: BusinessRecommendation) => keyOf({ operation: item.operation, subjectId: item.subjectId, evidenceRevision: item.reference.evidenceRevision, goalId: item.goal?.id ?? null })

async function authorize(principal: MemberAccessPrincipal) {
  // Opportunities are the owner's decisions about the business; a member is given the tasks they become.
  await assertRoleAllows({ ...principal, permissions: { task: ['assign'] } })
}

/**
 * Run the selector, record what it found, and supersede the open opportunities
 * whose evidence is no longer current. Idempotent by the reference key.
 */
async function select(db: DbClient, principal: MemberAccessPrincipal, input: { now: Date; locationId?: string }) {
  const plan = await readBusinessRecommendations(db, principal, { now: input.now, locationId: input.locationId })
  const now = input.now.toISOString(), organizationId = principal.organizationId
  const queries: BatchQuery[] = plan.recommendations.map(item => ({
    query: `INSERT INTO opportunities (id, organization_id, operation, subject_id, evidence_revision, goal_id, goal_revision, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) ON CONFLICT DO NOTHING`,
    params: [crypto.randomUUID(), organizationId, item.operation, item.subjectId, item.reference.evidenceRevision, item.goal?.id ?? null, item.goal?.revision ?? null, now, now],
  }))
  // A location-filtered read sees only part of the business, so it never supersedes.
  if (!input.locationId) {
    queries.push({
      query: `UPDATE opportunities SET status = 'superseded', updated_at = ? WHERE organization_id = ? AND status = 'open'
        AND NOT EXISTS (SELECT 1 FROM json_each(?) current WHERE json_extract(current.value, '$[0]') = opportunities.operation
          AND json_extract(current.value, '$[1]') = opportunities.subject_id AND json_extract(current.value, '$[2]') = opportunities.evidence_revision
          AND json_extract(current.value, '$[3]') IS opportunities.goal_id)`,
      params: [now, organizationId, JSON.stringify(plan.recommendations.map(item => [item.operation, item.subjectId, item.reference.evidenceRevision, item.goal?.id ?? null]))],
    })
  }
  const results = queries.length ? await executeBatch(db, queries, { operation: 'Record opportunities' }) : []
  const rows = await queryAll<OpportunityRow>(db, 'SELECT * FROM opportunities WHERE organization_id = ? AND status = \'open\'', [organizationId])
  return { plan, rows, changed: results.some(result => (result.meta.changes ?? 0) > 0) }
}

function view(row: OpportunityRow, item: BusinessRecommendation, homes: Map<string, string>): OpportunityView {
  return { id: row.id, statusLine: [AREA[item.operation], item.productId ? homes.get(item.productId) ?? null : null].filter(Boolean).join(' · '), title: item.headline, detail: item.reason, icon: item.icon, path: item.to, productId: item.productId, locationId: item.locationId }
}

/** The open opportunities available now, in the selector's order. */
export async function listOpportunities(db: DbClient, principal: MemberAccessPrincipal, input: { now?: Date; locationId?: string } = {}): Promise<{ opportunities: OpportunityView[]; issues: string[] }> {
  await authorize(principal)
  const now = input.now ?? new Date()
  const { plan, rows, changed } = await select(db, principal, { now, locationId: input.locationId })
  if (changed) await publishBusinessInvalidation(principal.env as CloudflareEnv, principal.organizationId)
  const byKey = new Map(rows.filter(row => row.available_at === null || row.available_at <= now.toISOString()).map(row => [rowKey(row), row]))
  const productIds = [...new Set(plan.recommendations.flatMap(item => item.productId && item.operation === 'stay.gap' ? [item.productId] : []))]
  const homes = new Map((await queryAll<{ id: string; name: string }>(db, 'SELECT id, name FROM products WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?))',
    [principal.organizationId, JSON.stringify(productIds)])).map(product => [product.id, product.name]))
  return {
    opportunities: plan.recommendations.flatMap(item => {
      const row = byKey.get(recommendationKey(item))
      return row ? [view(row, item, homes)] : []
    }),
    issues: plan.issues,
  }
}

async function openOpportunity(db: DbClient, principal: MemberAccessPrincipal, id: string): Promise<OpportunityRow> {
  const row = await queryFirst<OpportunityRow>(db, 'SELECT * FROM opportunities WHERE organization_id = ? AND id = ?', [principal.organizationId, id])
  if (!row) fail(404, 'OPPORTUNITY_NOT_FOUND', 'Opportunity not found')
  if (row.status !== 'open') fail(409, 'OPPORTUNITY_DECIDED', `This opportunity is already ${row.status}`, 'status')
  return row
}

function eventQuery(principal: MemberAccessPrincipal, row: OpportunityRow, eventType: 'opportunity.accepted' | 'opportunity.dismissed' | 'opportunity.deferred', after: unknown): BatchQuery {
  return organizationEventQuery({ organizationId: principal.organizationId, actorId: principal.userId, eventType, entityType: 'opportunity', entityId: row.id,
    metadata: { operation: row.operation, subjectId: row.subject_id, evidenceRevision: row.evidence_revision }, afterState: after, onlyIfPreviousChangedOneRow: true })
}

const SUBJECT: Partial<Record<BusinessProgressOperation, TaskRow['subject_type']>> = {
  'article.update': 'article', 'article.publish': 'article', 'article.distribute': 'article', 'post.publish': 'post', 'product.payment': 'product', 'stay.gap': 'product',
}

/**
 * Accept: the opportunity becomes one task, assigned and due as asked — the
 * caller and the end of today when the request says nothing. Refused when the
 * evidence moved on since it was shown.
 */
export async function acceptOpportunity(db: DbClient, principal: MemberAccessPrincipal, id: string, body: Record<string, unknown>): Promise<TaskView> {
  await authorize(principal)
  const row = await openOpportunity(db, principal, id)
  const { plan } = await select(db, principal, { now: new Date() })
  const item = plan.recommendations.find(candidate => recommendationKey(candidate) === rowKey(row))
  if (!item) fail(409, 'OPPORTUNITY_CHANGED', 'What this opportunity was based on has changed. Reload Today to see what is current.', 'id')
  const viewer = await taskViewer(db, principal)
  const assigned = body.assignedMemberId === undefined && body.assignedTeamId === undefined
    ? { member: viewer.memberId, team: null }
    : await readTaskAssignee(db, principal.organizationId, body)
  const place = item.locationId ? await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM business_locations WHERE organization_id = ? AND id = ?', [principal.organizationId, item.locationId]) : null
  const organization = await queryFirst<{ timezone: string }>(db, 'SELECT timezone FROM organization WHERE id = ?', [principal.organizationId])
  if (!organization) throw new Error(`Organization ${principal.organizationId} is missing`)
  const timezone = place?.timezone ?? organization.timezone
  if (body.dueAt !== undefined && body.dueAt !== null && !isValidInstant(body.dueAt)) fail(422, 'INVALID_TASK_FIELD', 'dueAt must be an instant with a timezone offset', 'dueAt')
  const now = new Date()
  const dueAt = body.dueAt === undefined ? localDateTimeToInstant(localDateAt(now, timezone), '23:59', timezone, 'compatible').toISOString() : body.dueAt === null ? null : new Date(body.dueAt as string).toISOString()
  const subjectType = SUBJECT[row.operation] ?? null
  const subjectId = subjectType === null ? null : row.operation === 'stay.gap' ? item.productId : row.subject_id
  const taskId = crypto.randomUUID()
  const results = await executeBatch(db, [
    { query: `UPDATE opportunities SET status = 'accepted', decided_at = ?, decided_by_user_id = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'open'`,
      params: [now.toISOString(), principal.userId, now.toISOString(), principal.organizationId, id] },
    opportunityTaskInsert({ organizationId: principal.organizationId, opportunityId: id, title: item.headline, subject: subjectType && subjectId ? { type: subjectType, id: subjectId } : null,
      productId: item.productId, locationId: item.locationId, assigned, dueAt, timezone, userId: principal.userId, now: now.toISOString(), taskId }),
    eventQuery(principal, row, 'opportunity.accepted', { taskId, assigned_member_id: assigned.member, assigned_team_id: assigned.team, due_at: dueAt }),
  ], { operation: 'Accept opportunity' })
  if (results[0]?.meta.changes !== 1) fail(409, 'OPPORTUNITY_DECIDED', 'This opportunity was decided while you were looking at it', 'status')
  const recipients = assigned.member === viewer.memberId ? [] : assigned.member
    ? (await queryAll<{ userId: string }>(db, 'SELECT userId FROM member WHERE organizationId = ? AND id = ?', [principal.organizationId, assigned.member])).map(member => member.userId)
    : assigned.team ? (await queryAll<{ userId: string }>(db, 'SELECT tm.userId FROM teamMember tm JOIN team t ON t.id = tm.teamId WHERE t.organizationId = ? AND t.id = ?', [principal.organizationId, assigned.team])).map(member => member.userId).filter(userId => userId !== principal.userId) : []
  if (recipients.length) {
    const { notifyTaskAssigned } = await import('~/server/utils/notifications')
    await notifyTaskAssigned(principal.env as CloudflareEnv, db, { organizationId: principal.organizationId, taskId, actorUserId: principal.userId, recipientUserIds: recipients })
  }
  await publishBusinessInvalidation(principal.env as CloudflareEnv, principal.organizationId)
  return getTask(db, viewer, taskId)
}

export async function dismissOpportunity(db: DbClient, principal: MemberAccessPrincipal, id: string, body: Record<string, unknown>): Promise<{ id: string; status: 'dismissed' }> {
  await authorize(principal)
  const row = await openOpportunity(db, principal, id)
  const note = body.note === undefined || body.note === null ? null : typeof body.note === 'string' && body.note.trim() && body.note.trim().length <= 2000 ? body.note.trim() : fail(422, 'INVALID_OPPORTUNITY_FIELD', 'note must be 1 to 2000 characters', 'note')
  const now = new Date().toISOString()
  const results = await executeBatch(db, [
    { query: `UPDATE opportunities SET status = 'dismissed', decision_note = ?, decided_at = ?, decided_by_user_id = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'open'`,
      params: [note, now, principal.userId, now, principal.organizationId, id] },
    eventQuery(principal, row, 'opportunity.dismissed', { note }),
  ], { operation: 'Dismiss opportunity' })
  if (results[0]?.meta.changes !== 1) fail(409, 'OPPORTUNITY_DECIDED', 'This opportunity was decided while you were looking at it', 'status')
  await publishBusinessInvalidation(principal.env as CloudflareEnv, principal.organizationId)
  return { id, status: 'dismissed' }
}

export async function deferOpportunity(db: DbClient, principal: MemberAccessPrincipal, id: string, body: Record<string, unknown>): Promise<{ id: string; availableAt: string }> {
  await authorize(principal)
  const row = await openOpportunity(db, principal, id)
  if (!isValidInstant(body.until) || Date.parse(body.until as string) <= Date.now()) fail(422, 'INVALID_OPPORTUNITY_FIELD', 'until must be a future instant with a timezone offset', 'until')
  const until = new Date(body.until as string).toISOString(), now = new Date().toISOString()
  const results = await executeBatch(db, [
    { query: `UPDATE opportunities SET available_at = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'open'`, params: [until, now, principal.organizationId, id] },
    eventQuery(principal, row, 'opportunity.deferred', { available_at: until }),
  ], { operation: 'Defer opportunity' })
  if (results[0]?.meta.changes !== 1) fail(409, 'OPPORTUNITY_DECIDED', 'This opportunity was decided while you were looking at it', 'status')
  await publishBusinessInvalidation(principal.env as CloudflareEnv, principal.organizationId)
  return { id, availableAt: until }
}
