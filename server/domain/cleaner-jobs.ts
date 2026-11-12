import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { isOrganizationWideRole } from '~/server/utils/member-access'
import { jobThreadParticipantsKey, postAutomaticTeamMessage, reseatAutomaticThread } from '~/server/domain/team-messages'
import { JOB_TASK_SQL, isJobTask, jobBookingIdSql, jobEndKeys, jobKey, jobSubject, taskViewForUser, type JobSubject, type TaskRow, type TaskView } from '~/server/domain/tasks'
import { notifyTaskStarting, taskStartingSent } from '~/server/utils/notifications'
import { addLocalDays, localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import type { CloudflareEnv } from '~/server/utils/auth'

/*
  A person's jobs live in team conversations. Each job given to a member is
  posted into the stay's conversation with that person and every owner and admin, the same conversation the app's "Message host" opens.
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
  /** Every seat: the cleaner and every owner and admin. */
  seats: string[]
  /** The people the job is for, as users: told by every channel they keep. */
  cleaners: string[]
  /** The owners and admins, as users: told when a job runs late. */
  hosts: string[]
}

function rosterFor(task: TaskRow, members: Member[]): Roster | null {
  const hosts = members.filter(member => isOrganizationWideRole(member.role))
  const cleaner = members.find(member => member.id === task.assigned_member_id)
  if (!cleaner || isOrganizationWideRole(cleaner.role)) return null
  return {
    seats: [...new Set([cleaner, ...hosts].map(member => member.id))].sort(),
    cleaners: [cleaner.userId],
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
  if (task.due_at !== null && isJobTask(task) && jobSubject(task).unit === 'nights') out.push({ kind: 'warning', key: `warning:${task.id}:${task.due_at}`, at: new Date(Date.parse(task.due_at) - WARNING_BEFORE_ARRIVAL_MS), until: new Date(task.due_at) })
  return out
}

/**
 * Posts what the organization's cleaners need to hear now and returns when the
 * next reminder is due, or null when nothing is pending.
 */
export async function runOrganizationJobs(env: CloudflareEnv, db: DbClient, organizationId: string, now = new Date()): Promise<{ next: Date | null; failures: unknown[] }> {
  const organization = await queryFirst<{ name: string }>(db, 'SELECT name FROM organization WHERE id = ?', [organizationId])
  if (!organization) throw new Error(`Organization ${organizationId} is missing`)
  const [members, tasks] = await Promise.all([
    queryAll<Member>(db, 'SELECT id, userId, role FROM member WHERE organizationId = ?', [organizationId]),
    // A job has something to say when its time is near (its reminders, from the evening before to its warning) or it changed lately (its post, release or cancellation); an open job long past says nothing more.
    queryAll<TaskRow & { job_booking_id: string | null; private_prep: number }>(db, `SELECT t.*, ${jobBookingIdSql('t')} AS job_booking_id,
      (t.subject_type = 'product_session' AND EXISTS (SELECT 1 FROM products p WHERE p.organization_id = t.organization_id AND p.id = t.product_id AND p.kind = 'service')) AS private_prep
      FROM tasks t WHERE t.organization_id = ? AND (${JOB_TASK_SQL('t')} OR t.starts_at IS NOT NULL)
      AND ((t.status = 'open' AND (COALESCE(t.starts_at, t.due_at, t.created_at) BETWEEN ? AND ? OR t.due_at BETWEEN ? AND ?)) OR t.updated_at >= ?)
      AND (t.assigned_member_id IS NOT NULL OR ${JOB_TASK_SQL('t')}) ORDER BY COALESCE(t.starts_at, t.due_at, t.created_at), t.id`,
    [organizationId, new Date(now.getTime() - RECENT_MS).toISOString(), new Date(now.getTime() + AHEAD_MS).toISOString(), new Date(now.getTime() - RECENT_MS).toISOString(), new Date(now.getTime() + AHEAD_MS).toISOString(), new Date(now.getTime() - RECENT_MS).toISOString()]),
  ])
  const subjectIds = [...new Set(tasks.flatMap(task => task.job_booking_id && (isJobTask(task) || task.subject_type === 'product_session') ? [task.job_booking_id] : []))]
  const prepKeys = tasks.filter(task => task.private_prep).map(task => jobKey(task))
  const posted = subjectIds.length || prepKeys.length ? await queryAll<{ message_id: string; thread_id: string; subject_id: string; participants_key: string; idempotency_key: string }>(db, `
    WITH relevant_threads AS (
      SELECT id FROM conversations WHERE organization_id = ? AND kind = 'team' AND booking_id IN (SELECT value FROM json_each(?))
      UNION
      SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
      WHERE c.organization_id = ? AND c.kind = 'team' AND c.booking_id IS NOT NULL AND m.author_kind = 'krabiclaw'
        AND json_extract(m.payload_json, '$.key') IN (SELECT value FROM json_each(?))
    )
    SELECT m.id AS message_id, m.conversation_id AS thread_id, t.booking_id AS subject_id, t.participants_key,
      json_extract(m.payload_json, '$.key') AS idempotency_key
    FROM relevant_threads r JOIN conversations t ON t.id = r.id JOIN messages m ON m.conversation_id = t.id
    WHERE m.author_kind = 'krabiclaw' AND json_type(m.payload_json, '$.key') = 'text' ORDER BY m.conversation_id, m.sequence`,
    [organizationId, d1JsonStringSet(subjectIds), organizationId, d1JsonStringSet(prepKeys)]) : []
  const postsByThread = new Map<string, Map<string, string>>()
  const threads = new Map<string, { subject_id: string; participants_key: string }>()
  for (const row of posted) {
    postsByThread.set(row.thread_id, (postsByThread.get(row.thread_id) ?? new Map()).set(row.idempotency_key, row.message_id))
    threads.set(row.thread_id, { subject_id: row.subject_id, participants_key: row.participants_key })
  }
  const seatUsers = new Map<string, string[]>()
  if (threads.size) {
    for (const seat of await queryAll<{ thread_id: string; user_id: string }>(db, `SELECT s.conversation_id AS thread_id, s.user_id FROM conversation_participants s
        JOIN member m ON m.userId = s.user_id AND m.organizationId = s.organization_id WHERE s.organization_id = ? AND s.conversation_id IN (SELECT value FROM json_each(?))`,
    [organizationId, d1JsonStringSet([...threads.keys()])])) seatUsers.set(seat.thread_id, [...seatUsers.get(seat.thread_id) ?? [], seat.user_id])
  }
  const hostUsers = members.filter(member => isOrganizationWideRole(member.role)).map(member => member.userId)
  const post = async (subject: JobSubject, seats: readonly string[], key: string, body: string, alertUserIds: readonly string[], threadId?: string) => {
    const result = await postAutomaticTeamMessage(env, db, { organizationId, subject, seatMemberIds: seats, body, idempotencyKey: key, alertUserIds, senderName: organization.name, threadId })
    postsByThread.set(result.threadId, (postsByThread.get(result.threadId) ?? new Map()).set(key, result.messageId))
    return result
  }
  const pending: Date[] = []
  const failures: unknown[] = []
  /** The task alert, once, on the morning of: a send the task already has for that day is not repeated. */
  const alertOnTheDay = async (task: TaskRow, recipients: readonly string[]) => {
    const morning = reminders(task).find(reminder => reminder.kind === 'morning')
    if (!morning) return
    if (morning.at > now) { pending.push(morning.at); return }
    if (now >= morning.until) return
    const day = localDateAt(new Date(task.starts_at ?? task.due_at!), task.timezone)
    if (!recipients.length || await taskStartingSent(db, task.id, day)) return
    await notifyTaskStarting(env, db, { organizationId, taskId: task.id, day, recipientUserIds: [...recipients] })
  }
  for (const task of tasks) {
    try {
      const prep = Boolean(task.private_prep)
      const subject: JobSubject | null = isJobTask(task) ? jobSubject(task) : prep && task.job_booking_id ? { id: task.job_booking_id, unit: 'slot' } : null
      const jobPrefix = `job:${task.id}:`
      const endKeys = jobEndKeys(task.id)
      const isJobPost = (key: string) => key.startsWith(jobPrefix)
      // The last recorded assignment or release says whether the thread still
      // carries this work. A session can have been discussed under another booking.
      const lastPost = (threadId: string) => [...postsByThread.get(threadId) ?? []].findLast(([key]) =>
        isJobPost(key) || endKeys.some(end => key === end || key.startsWith(`${end}:`)))
      const elsewhere = [...threads].filter(([threadId, thread]) => (prep || thread.subject_id === subject?.id)
        && [...(postsByThread.get(threadId)?.keys() ?? [])].some(isJobPost))
      const roster = subject ? rosterFor(task, members) : null
      if (!subject && !elsewhere.length) {
        if (task.status === 'open') await alertOnTheDay(task, members.filter(member => member.id === task.assigned_member_id).map(member => member.userId))
        continue
      }
      const view = roster || task.status === 'open' ? await taskViewForUser(db, organizationId, task.id, roster?.cleaners[0] ?? hostUsers[0] ?? null, now) : null
      // A booking may have changed while loading the card. Re-read on the
      // next alarm instead of using a new client's card in an old thread.
      if (prep && view && view.version !== task.version) { pending.push(now); continue }
      if (prep && view && view.booking_id !== (subject?.id ?? null)) throw new Error(`Prep task ${task.id} does not match its booking conversation`)
      const about = subject?.unit === 'nights' ? 'at' : 'with'
      const targetKey = roster && subject ? await jobThreadParticipantsKey(subject, roster.seats) : null
      let heldIn = elsewhere.find(([, thread]) => thread.subject_id === subject?.id && thread.participants_key === targetKey)?.[0] ?? null
      if (task.status === 'open' && roster && subject && heldIn === null) {
        const kept = elsewhere.find(([threadId, thread]) => {
          const cleaners = (seatUsers.get(threadId) ?? []).filter(userId => !hostUsers.includes(userId)).sort()
          return thread.subject_id === subject.id && cleaners.length === roster.cleaners.length
            && cleaners.every((userId, index) => userId === [...roster.cleaners].sort()[index])
        })
        if (kept) {
          const { threadId } = await reseatAutomaticThread(db, { organizationId, threadId: kept[0], seatMemberIds: roster.seats, participantsKey: targetKey! })
          threads.set(threadId, { subject_id: subject.id, participants_key: targetKey! })
          seatUsers.set(threadId, [...new Set([...roster.cleaners, ...roster.hosts])])
          heldIn = threadId
        }
      }
      for (const [threadId, thread] of elsewhere) {
        if (threadId === heldIn && task.status === 'open') continue
        const last = lastPost(threadId)
        if (!last || !isJobPost(last[0])) continue
        if (task.status !== 'open' && task.status !== 'cancelled' && task.closed_by_user_id !== null) continue
        const end = `${task.status === 'open' ? 'released' : task.status === 'cancelled' ? 'cancelled' : 'closed'}:${task.id}`
        const endKey = postsByThread.get(threadId)?.has(end) ? `${end}:${last[1]}` : end
        const seated = seatUsers.get(threadId) ?? []
        // A prior booking's team only needs to know its prep is no longer theirs.
        const details = subject?.id === thread.subject_id && view ? `${view.sheet.heading.toLowerCase()} ${about} ${view.sheet.title}${view.sheet.date ? `, ${view.sheet.date}` : ''}` : prep ? 'prep for this session' : 'this job'
        const label = { open: 'No longer yours', done: 'Completed', skipped: 'Skipped', cancelled: 'Cancelled' }[task.status]
        const body = `${label}: ${details}.`
        await post({ id: thread.subject_id, unit: subject?.unit ?? 'slot' }, [], endKey, body, seated.filter(userId => !hostUsers.includes(userId)), threadId)
      }
      if (task.status !== 'open' || !view || !task.assigned_member_id) continue
      if (!roster || !subject) {
        await alertOnTheDay(task, members.filter(member => member.id === task.assigned_member_id).map(member => member.userId))
        continue
      }
      const last = heldIn ? lastPost(heldIn) : undefined
      const baseKey = jobKey(task)
      // A newer release ends an assignment. A later reactivation is a new post
      // keyed by that message, so retries still announce it once.
      if (!last || (last[0] !== baseKey && !last[0].startsWith(`${baseKey}:after:`))) {
        const result = await post(subject, roster.seats, jobKey(task, last?.[1]), lines(view), roster.cleaners, heldIn ?? undefined)
        threads.set(result.threadId, { subject_id: subject.id, participants_key: targetKey! })
        heldIn = result.threadId
      }
      for (const reminder of reminders(task)) {
        if (postsByThread.get(heldIn!)?.has(reminder.key)) continue
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
