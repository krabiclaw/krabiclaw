import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { isOrganizationWideRole } from '~/server/utils/member-access'
import { jobThreadParticipantsKey, postAutomaticTeamMessage, reseatAutomaticThread } from '~/server/domain/team-messages'
import { JOB_TASK_SQL, isJobTask, jobSubject, taskViewForUser, type JobSubject, type TaskRow, type TaskView } from '~/server/domain/tasks'
import { notifyTaskStarting } from '~/server/utils/notifications'
import { addLocalDays, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import type { CloudflareEnv } from '~/server/utils/auth'

/*
  A person's jobs live in team conversations. Each job given to a member or a
  team is posted into the stay's conversation with that person (or team) and
  every owner and admin, the same conversation the app's "Message host" opens.
  Reminders follow in it: the evening before, the morning of, and a warning to
  the hosts when the home is not done two hours before the guests arrive. A
  move or a cancellation is told there at once. Every post has its own key, so
  a wake that runs twice sends nothing twice.

  The organization's hub Durable Object wakes this on every stay or business
  change and at the next reminder it reports, and re-arms itself to that time.
  A job an owner or admin gives themselves has no conversation; its morning-of
  reminder is the task alert, as it is for every other assigned task with a
  start time, an attorney's consultation jobs among them.
*/

const EVENING_BEFORE = '18:00'
const MORNING_OF = '08:00'
const WARNING_BEFORE_ARRIVAL_MS = 2 * 3_600_000
/** How long a closed or cancelled job is still told about in its conversation. */
const RECENT_MS = 7 * 86_400_000
/** How far ahead a job's reminders are armed from one wake; a later wake, or the daily one, reaches the rest. */
const AHEAD_MS = 14 * 86_400_000

interface Member { id: string; userId: string; role: string }

interface Roster {
  /** Every seat: the cleaner (or team) and every owner and admin. */
  seats: string[]
  /** The people the job is for, as users: told by every channel they keep. */
  cleaners: string[]
  /** The owners and admins, as users: told when a job runs late. */
  hosts: string[]
}

export const jobKey = (task: Pick<TaskRow, 'id' | 'product_id'>) => `job:${task.id}:${task.product_id}`

function rosterFor(task: TaskRow, members: Member[], teams: Map<string, string[]>): Roster | null {
  const hosts = members.filter(member => isOrganizationWideRole(member.role))
  let cleaners: Member[]
  if (task.assigned_team_id) cleaners = members.filter(member => (teams.get(task.assigned_team_id!) ?? []).includes(member.userId))
  else {
    const member = members.find(member => member.id === task.assigned_member_id)
    if (!member || isOrganizationWideRole(member.role)) return null
    cleaners = [member]
  }
  if (!cleaners.length) return null
  return {
    seats: [...new Set([...cleaners, ...hosts].map(member => member.id))].sort(),
    cleaners: [...new Set(cleaners.map(member => member.userId))],
    hosts: [...new Set(hosts.map(member => member.userId))],
  }
}

function lines(view: TaskView): string {
  const side = (part: TaskView['sheet']['checkout']) => part ? `${part.label} ${part.time}${part.guest ? ` · ${part.guest}` : ''}` : null
  return [`${view.sheet.heading}: ${view.sheet.title}`, view.sheet.date, side(view.sheet.checkout), side(view.sheet.checkin),
    view.sheet.checkout ? null : view.detail, view.notes].filter((line): line is string => Boolean(line)).join('\n')
}

/** The reminders a job gets, each at its instant, as [key suffix, instant, valid until]. */
function reminders(task: TaskRow): Array<{ key: string; at: Date; until: Date; kind: 'evening' | 'morning' | 'warning' }> {
  const anchor = task.starts_at ?? task.due_at
  if (anchor === null) return []
  const day = localDateAt(new Date(anchor), task.timezone)
  const at = (date: string, time: string) => localDateTimeToInstant(date, time, task.timezone, 'compatible')
  const windowEnd = task.due_at !== null ? new Date(task.due_at) : new Date(Date.parse(anchor) + 12 * 3_600_000)
  const out: ReturnType<typeof reminders> = [
    { kind: 'evening', key: `reminder:${task.id}:evening:${day}`, at: at(addLocalDays(day, -1), EVENING_BEFORE), until: new Date(anchor) },
    { kind: 'morning', key: `reminder:${task.id}:morning:${day}`, at: at(day, MORNING_OF), until: windowEnd },
  ]
  // Only a stay has guests arriving at a home that must be ready.
  if (task.due_at !== null && isJobTask(task) && jobSubject(task).kind === 'stay') out.push({ kind: 'warning', key: `warning:${task.id}:${task.due_at}`, at: new Date(Date.parse(task.due_at) - WARNING_BEFORE_ARRIVAL_MS), until: new Date(task.due_at) })
  return out
}

/**
 * Posts what the organization's cleaners need to hear now and returns when the
 * next reminder is due, or null when nothing is pending.
 */
export async function runOrganizationJobs(env: CloudflareEnv, db: DbClient, organizationId: string, now = new Date()): Promise<{ next: Date | null; failures: unknown[] }> {
  const organization = await queryFirst<{ name: string }>(db, 'SELECT name FROM organization WHERE id = ?', [organizationId])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const [members, teamRows, tasks] = await Promise.all([
    queryAll<Member>(db, 'SELECT id, userId, role FROM member WHERE organizationId = ?', [organizationId]),
    queryAll<{ team_id: string; user_id: string }>(db, 'SELECT t.id AS team_id, tm.userId AS user_id FROM team t JOIN teamMember tm ON tm.teamId = t.id WHERE t.organizationId = ?', [organizationId]),
    // A job has something to say when its time is near (its reminders, from the evening before to its warning) or it changed lately (its post, release or cancellation); an open job long past says nothing more.
    queryAll<TaskRow>(db, `SELECT t.* FROM tasks t WHERE t.organization_id = ? AND (${JOB_TASK_SQL('t')} OR t.starts_at IS NOT NULL)
      AND ((t.status = 'open' AND (COALESCE(t.starts_at, t.due_at, t.created_at) BETWEEN ? AND ? OR t.due_at BETWEEN ? AND ?)) OR t.updated_at >= ?)
      AND (t.assigned_member_id IS NOT NULL OR t.assigned_team_id IS NOT NULL OR ${JOB_TASK_SQL('t')}) ORDER BY COALESCE(t.starts_at, t.due_at, t.created_at), t.id`,
    [organizationId, new Date(now.getTime() - RECENT_MS).toISOString(), new Date(now.getTime() + AHEAD_MS).toISOString(), new Date(now.getTime() - RECENT_MS).toISOString(), new Date(now.getTime() + AHEAD_MS).toISOString(), new Date(now.getTime() - RECENT_MS).toISOString()]),
  ])
  const teams = new Map<string, string[]>()
  for (const row of teamRows) teams.set(row.team_id, [...teams.get(row.team_id) ?? [], row.user_id])
  const subjectIds = [...new Set(tasks.filter(isJobTask).map(task => jobSubject(task).id))]
  const posted = subjectIds.length ? await queryAll<{ thread_id: string; subject_id: string; participants_key: string; idempotency_key: string }>(db, `
    SELECT m.thread_id, COALESCE(t.stay_id, t.booking_id) AS subject_id, t.participants_key, m.idempotency_key FROM team_messages m
      JOIN team_threads t ON t.organization_id = m.organization_id AND t.id = m.thread_id
     WHERE t.organization_id = ? AND COALESCE(t.stay_id, t.booking_id) IN (SELECT value FROM json_each(?)) AND m.automatic = 1`, [organizationId, d1JsonStringSet(subjectIds)]) : []
  const keysByThread = new Map<string, Set<string>>()
  const threads = new Map<string, { subject_id: string; participants_key: string }>()
  for (const row of posted) {
    keysByThread.set(row.thread_id, (keysByThread.get(row.thread_id) ?? new Set()).add(row.idempotency_key))
    threads.set(row.thread_id, { subject_id: row.subject_id, participants_key: row.participants_key })
  }
  const seatUsers = new Map<string, string[]>()
  if (threads.size) {
    for (const seat of await queryAll<{ thread_id: string; user_id: string }>(db, `SELECT s.thread_id, m.userId AS user_id FROM team_thread_members s
        JOIN member m ON m.id = s.member_id AND m.organizationId = s.organization_id WHERE s.organization_id = ? AND s.thread_id IN (SELECT value FROM json_each(?))`,
    [organizationId, d1JsonStringSet([...threads.keys()])])) seatUsers.set(seat.thread_id, [...seatUsers.get(seat.thread_id) ?? [], seat.user_id])
  }
  const hostUsers = members.filter(member => isOrganizationWideRole(member.role)).map(member => member.userId)
  const post = async (subject: JobSubject, seats: readonly string[], key: string, body: string, alertUserIds: readonly string[], threadId?: string) => {
    const result = await postAutomaticTeamMessage(env, db, { organizationId, subject, seatMemberIds: seats, body, idempotencyKey: key, alertUserIds, senderName: organization.name, threadId })
    keysByThread.set(result.threadId, (keysByThread.get(result.threadId) ?? new Set()).add(key))
    return result
  }
  const pending: Date[] = []
  const failures: unknown[] = []
  /** The task alert, once, on the morning of. */
  const alertOnTheDay = async (task: TaskRow, recipients: readonly string[]) => {
    const morning = reminders(task).find(reminder => reminder.kind === 'morning')
    if (!morning) return
    if (morning.at > now) { pending.push(morning.at); return }
    if (now >= morning.until) return
    const day = localDateAt(new Date(task.starts_at ?? task.due_at!), task.timezone)
    const sent = recipients.length ? await queryAll<{ dedupe_key: string }>(db, "SELECT dedupe_key FROM activity_entries WHERE organization_id = ? AND kind = 'notification' AND dedupe_key IN (SELECT value FROM json_each(?))",
      [organizationId, d1JsonStringSet(recipients.map(userId => `notification:task-starting:${task.id}:${day}:${userId}`))]) : []
    const unsent = recipients.filter(userId => !sent.some(row => row.dedupe_key === `notification:task-starting:${task.id}:${day}:${userId}`))
    if (unsent.length) await notifyTaskStarting(env, db, { organizationId, taskId: task.id, day, recipientUserIds: unsent })
  }
  for (const task of tasks) {
    try {
      if (!isJobTask(task)) {
        if (task.status === 'open') await alertOnTheDay(task, task.assigned_team_id ? teams.get(task.assigned_team_id) ?? [] : members.filter(member => member.id === task.assigned_member_id).map(member => member.userId))
        continue
      }
      const subject = jobSubject(task)
      const about = subject.kind === 'booking' ? 'with' : 'at'
      const roster = rosterFor(task, members, teams)
      const view = roster || task.status === 'open' ? await taskViewForUser(db, organizationId, task.id, roster?.cleaners[0] ?? hostUsers[0] ?? null, now) : null
      // Conversations of this stay that once carried this job: the one still held by the same people keeps it,
      // with its seats brought up to today's owners and admins; the others are told it is no longer theirs.
      const elsewhere = [...threads].filter(([threadId, thread]) => thread.subject_id === subject.id && [...keysByThread.get(threadId) ?? []].some(key => key.startsWith(`job:${task.id}:`)))
      const targetKey = roster ? await jobThreadParticipantsKey(subject, roster.seats) : null
      const sameCleaners = (threadId: string) => {
        const cleaners = (seatUsers.get(threadId) ?? []).filter(userId => !hostUsers.includes(userId)).sort()
        return roster !== null && cleaners.length === roster.cleaners.length && cleaners.every((userId, index) => userId === [...roster.cleaners].sort()[index])
      }
      let heldIn = elsewhere.find(([, thread]) => thread.participants_key === targetKey)?.[0] ?? null
      if (task.status === 'open' && roster && heldIn === null) {
        const kept = elsewhere.find(([threadId]) => sameCleaners(threadId))
        if (kept) {
          const { threadId } = await reseatAutomaticThread(db, { organizationId, threadId: kept[0], seatMemberIds: roster.seats, participantsKey: targetKey! })
          threads.set(threadId, { subject_id: subject.id, participants_key: targetKey! })
          seatUsers.set(threadId, [...new Set([...roster.cleaners, ...roster.hosts])])
          heldIn = threadId
        }
      }
      for (const [threadId] of elsewhere) {
        if (threadId === heldIn && task.status === 'open') continue
        const closedKey = task.status === 'open' ? `released:${task.id}` : `${task.status === 'cancelled' ? 'cancelled' : 'closed'}:${task.id}`
        if (keysByThread.get(threadId)?.has(closedKey)) continue
        if (task.status !== 'open' && task.status !== 'cancelled' && task.closed_by_user_id !== null) continue
        const seated = seatUsers.get(threadId) ?? []
        const body = task.status === 'open' ? `No longer yours: ${view!.sheet.heading.toLowerCase()} ${about} ${view!.sheet.title}${view!.sheet.date ? `, ${view!.sheet.date}` : ''}.`
          : `Cancelled: ${view ? `${view.sheet.heading.toLowerCase()} ${about} ${view.sheet.title}${view.sheet.date ? `, ${view.sheet.date}` : ''}` : 'this job'}.`
        await post(subject, [], closedKey, body, seated.filter(userId => !hostUsers.includes(userId)), threadId)
      }
      if (task.status !== 'open' || !view) continue
      // A job nobody holds has been told to whoever held it; there is nobody to remind.
      if (task.assigned_member_id === null && task.assigned_team_id === null) continue
      if (!roster) {
        // An owner's or admin's own job.
        await alertOnTheDay(task, members.filter(member => member.id === task.assigned_member_id).map(member => member.userId))
        continue
      }
      const key = jobKey(task)
      // A post whose alert failed was withdrawn with it, so what is here was told; only what is missing is posted.
      const keys = heldIn ? keysByThread.get(heldIn) ?? new Set<string>() : new Set<string>()
      if (!keys.has(key)) {
        const result = await post(subject, roster.seats, key, lines(view), roster.cleaners, heldIn ?? undefined)
        threads.set(result.threadId, { subject_id: subject.id, participants_key: targetKey! })
        heldIn = result.threadId
      }
      for (const reminder of reminders(task)) {
        if (keysByThread.get(heldIn!)?.has(reminder.key)) continue
        if (reminder.at > now) { pending.push(reminder.at); continue }
        if (now >= reminder.until) continue
        const when = view.when ? `, ${view.when}` : ''
        const body = reminder.kind === 'evening' ? `Tomorrow: ${view.sheet.heading.toLowerCase()} ${about} ${view.sheet.title}${when}.`
          : reminder.kind === 'morning' ? `Today: ${view.sheet.heading.toLowerCase()} ${about} ${view.sheet.title}${when}.`
            : `${view.sheet.title} is not marked done and the next guests arrive${view.sheet.checkin ? ` at ${view.sheet.checkin.time}` : ' in two hours'}.`
        await post(subject, roster.seats, reminder.key, body, reminder.kind === 'warning' ? roster.hosts : roster.cleaners, heldIn!)
      }
    } catch (error) {
      failures.push(error)
    }
  }
  // The jobs that could not be told about are the caller's to report; the next wake still comes from the ones that could.
  return { next: pending.length ? new Date(Math.min(...pending.map(date => date.getTime()))) : null, failures }
}
