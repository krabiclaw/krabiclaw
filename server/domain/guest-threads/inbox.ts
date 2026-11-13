import { HTTPError } from 'nitro'
import { d1JsonStringSet, queryAll, queryFirst, type DbClient } from '~/server/db'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import { SCHEDULED_MESSAGE_CONVERSATION_SQL, visibleScheduledMessagesSql } from '~/server/domain/guest-messaging'
import { stayAccessFor } from '~/server/domain/stays'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { loadGuestThreadDetail, type TranscriptView } from './detail'
import { guestReplyDestination } from './operations'
import { MEMBER_REPLY_EVENT, MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, type ConversationRow } from '~/server/domain/conversations'
import { formatFormAnswer } from '~/shared/form-questions'
import { EXPERIENCE_PRESENTATION } from '~/utils/product-presentation'
import { normalizeVertical } from '~/utils/vertical-copy'
import { calendarDate, clockTime, firstName, initial, localDateKey, providerInstant, sendTime, stayWhen, transcriptDays } from './presentation'
import { formatCalendarRange } from '~/utils/timezone'
import type {
  GuestThreadDetailViewModel,
  GuestThreadEntryViewModel,
  InboxChannel,
  InboxPendingMessage,
  InboxStreamItem,
  InboxThread,
  InboxThreadDetails,
  InboxThreadKind,
} from './types'

/*
  The conversation as every surface draws it (inbox-parity.md, "The thread"),
  reduced from the canonical thread read in `detail.ts`. What the ledger holds
  for the business's own bookkeeping — deliveries, event names, payloads,
  provider ids, the opening submission's fields — is read here and does not
  leave it.
*/

type Viewer = { audience: 'member'; userId: string; principal: MemberAccessPrincipal; conversation?: ConversationRow } | { audience: 'buyer'; userId: string }
type MessageItem = Extract<InboxStreamItem, { type: 'message' }>

function invalid(message: string, field: string, entryId: string): never {
  throw new HTTPError({ statusCode: 500, message, data: { code: 'INVALID_GUEST_THREAD_ENTRY', field, entry_id: entryId } })
}

/** An Airbnb Support case: Airbnb's agents wrote, and no guest did. */
export function isSupportThread(entries: Pick<GuestThreadEntryViewModel, 'kind' | 'actorKind' | 'eventName'>[]): boolean {
  return entries.some(entry => entry.kind === 'message' && entry.actorKind === 'krabiclaw' && entry.eventName === MIRRORED_EVENT)
    && !entries.some(entry => entry.kind === 'message' && entry.actorKind === 'guest')
}

function meta(entry: GuestThreadEntryViewModel): Record<string, unknown> | null {
  const value = entry.payload?.meta
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * What a message carried that the conversation does not show: an Airbnb
 * attachment that is not a photo (or not stored yet), or a file a guest sent by
 * email that is not one.
 */
function unshownFiles(entry: GuestThreadEntryViewModel): number {
  const links = entry.eventName === MIRRORED_EVENT && Array.isArray(entry.payload?.attachments) ? entry.payload.attachments.length : 0
  const named = Array.isArray(entry.payload?.unshownFiles) ? entry.payload.unshownFiles.length : 0
  return Math.max(links - entry.attachments.length, 0) + named
}

/** The instant a message was said: the provider's time when it has one, else when KrabiClaw recorded it. */
export function entrySentAt(entry: Pick<GuestThreadEntryViewModel, 'providerTimestamp' | 'occurredAt'>): string {
  return entry.providerTimestamp ? providerInstant(entry.providerTimestamp) : entry.occurredAt
}

interface ThreadFacts {
  raw: TranscriptView
  kind: InboxThreadKind
  guestName: string
  channel: InboxChannel
  home: string | null
  when: string | null
  timeZone: string
  ownerFirstName: string | null
  automaticTitles: Map<string, string>
  inquiry: { checkIn: string; checkOut: string } | null
}

/**
 * Who the guest is, as every surface names them: Airbnb Support for a support case; otherwise
 * the first name Airbnb gives on the guest's messages, else the booked name, else the label.
 */
export function inboxGuestNames(raw: Pick<TranscriptView, 'entries' | 'guestName' | 'participantLabel' | 'conversationChannel'>): { kind: InboxThreadKind; guestName: string; guestFullName: string } {
  const kind: InboxThreadKind = isSupportThread(raw.entries) ? 'support' : 'guest'
  const airbnbName = raw.entries.findLast(entry => entry.actorKind === 'guest' && entry.eventName === MIRRORED_EVENT && text(meta(entry)?.name))
  // Airbnb gives the guest's first name on their messages; the stay, once booked, has their full name.
  const airbnbFirstName = airbnbName ? text(meta(airbnbName)!.name)! : null
  const guestFullName = kind === 'support' ? 'Airbnb Support' : raw.guestName ?? airbnbFirstName ?? raw.participantLabel
  const guestName = kind === 'support' ? 'Airbnb Support'
    : airbnbFirstName ?? (raw.conversationChannel === 'airbnb' && raw.guestName ? firstName(raw.guestName) : guestFullName)
  return { kind, guestName, guestFullName }
}

async function threadFacts(db: DbClient, raw: TranscriptView, organizationId: string, timeZone: string, now: Date): Promise<ThreadFacts> {
  const { kind, guestName } = inboxGuestNames(raw)
  const automaticIds = raw.entries.filter(entry => entry.eventName === SCHEDULED_MESSAGE_EVENT).map(entry => entry.id)
  const [owner, automatic] = await Promise.all([
    automaticIds.length ? queryFirst<{ name: string }>(db, `SELECT u.name FROM member m JOIN user u ON u.id = m.userId
      WHERE m.organizationId = ? AND m.role = 'owner' ORDER BY m.createdAt, m.id LIMIT 1`, [organizationId]) : null,
    automaticIds.length ? queryAll<{ message_id: string; template_title: string }>(db,
      'SELECT message_id, template_title FROM scheduled_guest_messages WHERE organization_id = ? AND message_id IN (SELECT value FROM json_each(?))',
      [organizationId, d1JsonStringSet(automaticIds)]) : [],
  ])
  const inquiry = raw.inquiry
  const record = raw.operationalRecord
  // A stay is its nights; a booking is its start, in the home's clock; an inquiry is the dates asked about.
  const when = record?.check_in_date && record.check_out_date ? stayWhen(record.check_in_date, record.check_out_date, now, timeZone)
    : record ? `${calendarDate(localDateKey(record.starts_at, timeZone))}, ${clockTime(record.starts_at, timeZone)}`
      : inquiry && kind === 'guest' ? formatCalendarRange(inquiry.checkIn, inquiry.checkOut, 'en-US') : null
  return {
    raw, kind, guestName, channel: raw.conversationChannel,
    home: raw.locationLabel, when, timeZone,
    ownerFirstName: owner ? firstName(owner.name) : null,
    automaticTitles: new Map(automatic.map(row => [row.message_id, row.template_title])),
    inquiry,
  }
}

const RECEIPT_RANK = ['pending', 'sending', 'accepted', 'sent', 'delivered', 'read'] as const

/** What became of a reply, said once under the newest one as Airbnb says it. */
function receipt(entry: GuestThreadEntryViewModel, guestName: string): string | null {
  const attempts = entry.deliveries.filter(delivery => delivery.purpose === 'member_reply' || delivery.purpose === 'scheduled_message')
  const providerReplies = attempts.filter(delivery => delivery.provider !== 'log_only')
  const replies = providerReplies.length ? providerReplies : attempts
  if (!replies.length) return null
  if (replies.every(delivery => delivery.status === 'failed' || delivery.status === 'skipped')) return 'Not delivered'
  const best = replies.reduce((top, delivery) => RECEIPT_RANK.indexOf(delivery.status as typeof RECEIPT_RANK[number]) > RECEIPT_RANK.indexOf(top.status as typeof RECEIPT_RANK[number]) ? delivery : top)
  if (best.provider === 'log_only') return 'Recorded locally'
  switch (best.status) {
    case 'read': return `Read by ${guestName}`
    case 'delivered': return 'Delivered'
    case 'accepted': case 'sent': return 'Sent'
    default: return 'Sending'
  }
}

function recordNoun(raw: TranscriptView): string {
  const record = raw.operationalRecord
  if (!record || record.unit === 'nights') return 'reservation'
  return resolveBookingPresentation(record.product_kind, raw.organizationVertical).noun
}

/** What Show reservation calls the record, in the business's own word: a stay or a table is a reservation, a class an experience. */
function recordTitle(record: NonNullable<GuestThreadDetailViewModel['operationalRecord']>, vertical: string | null): string {
  if (record.unit === 'nights') return 'Reservation'
  if (record.product_kind === 'experience' && normalizeVertical(vertical ?? '') !== 'service') return EXPERIENCE_PRESENTATION.itemLabel
  return resolveBookingPresentation(record.product_kind, vertical).label
}

/** Who did something, as the reader says it: "You", a teammate's first name, the guest. */
function actorName(entry: GuestThreadEntryViewModel, facts: ThreadFacts, viewer: Viewer): string {
  if (entry.actorKind === 'guest') return viewer.audience === 'buyer' ? 'You' : facts.guestName
  if (entry.actorUserId && entry.actorUserId === viewer.userId) return 'You'
  if (entry.actorKind === 'member') return viewer.audience === 'buyer' ? facts.raw.organizationName ?? 'The business' : entry.actorLabel ? firstName(entry.actorLabel) : 'You'
  return facts.raw.organizationName ?? 'KrabiClaw'
}

/** A sentence the server writes for KrabiClaw's event in the conversation. */
function eventSentence(entry: GuestThreadEntryViewModel, facts: ThreadFacts, viewer: Viewer): string {
  const name = entry.eventName ?? ''
  const actor = actorName(entry, facts, viewer)
  const noun = recordNoun(facts.raw)
  const firstLine = text(entry.body)?.split('\n')[0]?.trim() ?? null
  if (name.startsWith('booking_change.')) {
    const outcome = name.slice('booking_change.'.length)
    if (outcome === 'accepted' || outcome === 'declined' || outcome === 'withdrawn') {
      return `${viewer.audience === 'buyer' ? 'Your' : `${facts.guestName}’s`} change was ${outcome}${facts.channel === 'airbnb' ? ' on Airbnb' : ''}`
    }
    if (firstLine) return firstLine
  }
  const action = name.split('.').at(-1)
  if (action === 'guest_cancelled') return `${viewer.audience === 'buyer' ? 'You' : facts.guestName} canceled the ${noun}`
  if (action === 'cancel' || action === 'cancelled') return `${actor} canceled the ${noun}`
  if (action === 'confirm' || action === 'confirmed') return `${actor} confirmed the ${noun}`
  if (action === 'reject') return `${actor} declined the ${noun}`
  if (action === 'no_show') return `${actor} marked the ${noun} as a no-show`
  if (name === 'review.requested') return 'Review invitation sent'
  if (firstLine) return firstLine
  invalid(`The conversation activity ${name || entry.kind} has nothing to say`, 'event_name', entry.id)
}

/** Builds the stream: day headers, runs of messages with one time each, events as sentences, change requests. */
function stream(facts: ThreadFacts, viewer: Viewer, now: Date, canReply: boolean): InboxStreamItem[] {
  const { raw, timeZone } = facts
  const items: InboxStreamItem[] = []
  const days = transcriptDays(timeZone, now)
  let day: string | null = null
  let previous: MessageItem | null = null
  const place = (sentAt: string, id: string) => {
    const at = new Date(sentAt)
    const date = days.date(at)
    if (date.key !== day) { items.push({ type: 'day', id: `day:${id}`, label: days.label(at, date) }); day = date.key; previous = null }
  }
  const message = (entry: GuestThreadEntryViewModel, body: string | null, item: Omit<MessageItem, 'type' | 'id' | 'sent_at' | 'time' | 'body' | 'receipt' | 'retryable' | 'unshown_files'>) => {
    const sentAt = entrySentAt(entry)
    place(sentAt, entry.id)
    const run = previous !== null && previous.side === item.side && previous.author === item.author
    const next: MessageItem = { type: 'message', id: entry.id, sent_at: sentAt, time: run ? null : clockTime(sentAt, timeZone), body, receipt: null, retryable: false, unshown_files: unshownFiles(entry), ...item }
    items.push(next)
    previous = next
    return next
  }

  // In the buyer's own inbox the buyer is the guest side and the business answers.
  const businessAuthor = (entry: GuestThreadEntryViewModel): { author: string; label: string | null } => {
    if (entry.eventName === SCHEDULED_MESSAGE_EVENT) {
      const title = facts.automaticTitles.get(entry.id) ?? null
      return { author: viewer.audience === 'buyer' ? raw.organizationName ?? 'The business' : facts.ownerFirstName ? `${facts.ownerFirstName} · Automatic` : 'Automatic', label: title }
    }
    if (viewer.audience === 'buyer') return { author: raw.organizationName ?? 'The business', label: null }
    // A message Channex marks `property` is the host's side, whoever typed it on Airbnb.
    if (entry.eventName === MIRRORED_EVENT || entry.actorUserId === viewer.userId) return { author: 'You', label: null }
    if (!entry.actorLabel) invalid('The business message has no author', 'actor_user_id', entry.id)
    return { author: entry.actorLabel === 'Deleted account' ? entry.actorLabel : firstName(entry.actorLabel), label: null }
  }

  let newestBusiness: { item: MessageItem; entry: GuestThreadEntryViewModel } | null = null
  for (const entry of raw.entries) {
    if (entry.eventName === SUBMISSION_EVENT) {
      // A contact form's words open its conversation: what the guest wrote, then their answers.
      const answers = raw.answers.map(answer => `${answer.label} ${formatFormAnswer(answer, { yes: 'Yes', no: 'No' })}`)
      const words = [text(entry.body), ...answers].filter(Boolean).join('\n\n') || null
      if (words) message(entry, words, { side: 'guest', author: viewer.audience === 'buyer' ? 'You' : facts.guestName, label: null, photos: [], translated: null })
      continue
    }
    if (entry.kind === 'message') {
      // A message with no words, photo or file (an Airbnb host action Channex records that way) says nothing.
      if (!text(entry.body) && !entry.attachments.length && !unshownFiles(entry)) continue
      const photos = entry.attachments.map(photo => ({ id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl, width: photo.width, height: photo.height }))
      if (entry.actorKind === 'guest') {
        const translation = text(meta(entry)?.translated_message)
        const translated = translation !== null && translation !== text(entry.body)
        message(entry, translated ? translation : entry.body, { side: 'guest', author: viewer.audience === 'buyer' ? 'You' : facts.guestName, label: null, photos, translated: translated ? { original: entry.body! } : null })
        continue
      }
      // The booking's own message states what the guest asked for, on their side of the conversation.
      if (entry.eventName === OPENING_EVENT) {
        message(entry, entry.body, { side: 'guest', author: viewer.audience === 'buyer' ? 'You' : facts.guestName, label: null, photos, translated: null })
        continue
      }
      if (entry.actorKind === 'krabiclaw' && entry.eventName === MIRRORED_EVENT) {
        message(entry, entry.body, { side: 'guest', author: text(meta(entry)?.name) ?? 'Airbnb Support', label: null, photos, translated: null })
        continue
      }
      const item = message(entry, entry.body, { side: 'business', ...businessAuthor(entry), photos, translated: null })
      newestBusiness = { item, entry }
      continue
    }
    if (entry.bookingChange) {
      const sentAt = entry.occurredAt
      place(sentAt, entry.id)
      items.push({ type: 'change', id: entry.id, sent_at: sentAt, change: entry.bookingChange })
      previous = null
      continue
    }
    const sentence = eventSentence(entry, facts, viewer)
    place(entry.occurredAt, entry.id)
    items.push({ type: 'event', id: entry.id, text: sentence, sent_at: entry.occurredAt })
    previous = null
  }
  if (newestBusiness && viewer.audience === 'member') {
    const { item, entry } = newestBusiness
    item.receipt = receipt(entry, facts.guestName)
    // A team member's text reply that did not arrive can be sent again under its own key, where the reply
    // operation can still send (`guestReplyDestination`); an automatic or photo reply cannot.
    item.retryable = canReply && item.receipt === 'Not delivered' && entry.eventName === MEMBER_REPLY_EVENT && !item.photos.length && Boolean(text(item.body))
  }
  return items
}

/** The thread's messages still to go out: its automatic messages for managers, and the viewer's own send-later replies. */
async function readPendingMessages(db: DbClient, threadId: string, organizationId: string, principal: MemberAccessPrincipal) {
  const visible = visibleScheduledMessagesSql('m', await stayAccessFor(principal))
  return queryAll<{ id: string; author_user_id: string | null; template_title: string | null; body: string; due_at: string; timezone: string | null; status: string }>(db, `
    SELECT m.id, m.author_user_id, m.template_title, m.body, m.due_at, m.timezone, m.status FROM scheduled_guest_messages m
     WHERE m.organization_id = ? AND ${SCHEDULED_MESSAGE_CONVERSATION_SQL} = ? AND ${visible.query} AND m.due_at IS NOT NULL
       AND (m.status = 'pending' OR (m.status = 'sending' AND m.author_user_id IS NOT NULL)) ORDER BY m.due_at, m.id`, [organizationId, threadId, ...visible.params])
}

function pendingMessages(rows: Awaited<ReturnType<typeof readPendingMessages>>, timeZone: string): InboxPendingMessage[] {
  return rows.map(row => row.author_user_id === null
    ? { id: row.id, source: 'automatic' as const, label: row.template_title!, due_at: row.due_at, time: sendTime(row.due_at, row.timezone!), body: row.body, cancellable: true }
    : { id: row.id, source: 'later' as const, label: row.body, due_at: row.due_at, time: sendTime(row.due_at, timeZone), body: row.body, cancellable: row.status === 'pending' })
}

/** The conversation's view model, or null when the viewer has no such conversation. */
export async function getInboxThread(db: DbClient, threadId: string, organizationId: string, viewer: Viewer, now = new Date()): Promise<InboxThread | null> {
  const [detail, scheduled] = await Promise.all([
    loadGuestThreadDetail(db, threadId, organizationId, viewer.audience === 'buyer'
      ? { buyerUserId: viewer.userId }
      : { memberUserId: viewer.userId, conversation: viewer.conversation }, now, true),
    viewer.audience === 'member' && viewer.conversation
      ? readPendingMessages(db, threadId, organizationId, viewer.principal)
      : null,
  ])
  if (!detail) return null
  const { view: raw, timeZone } = detail
  const [facts, replyComposer, pending] = await Promise.all([
    threadFacts(db, raw, organizationId, timeZone, now),
    viewer.audience === 'member' ? guestReplyDestination(db, detail.request, detail.channelFacts) : null,
    scheduled ?? (viewer.audience === 'member' ? readPendingMessages(db, raw.id, organizationId, viewer.principal) : []),
  ])
  const items = stream(facts, viewer, now, replyComposer?.channel !== null)
  const record = raw.operationalRecord
  return {
    id: raw.id,
    kind: facts.kind,
    title: viewer.audience === 'buyer' ? raw.organizationName ?? facts.guestName : facts.guestName,
    avatar_initial: initial(viewer.audience === 'buyer' ? raw.organizationName ?? facts.guestName : facts.guestName),
    channel: facts.channel,
    home: facts.home,
    when: facts.when,
    translated: items.some(item => item.type === 'message' && item.translated !== null),
    booking_id: record?.id ?? null,
    record_kind: record ? record.unit === 'nights' ? 'stay' : 'booking' : null,
    record_title: record ? recordTitle(record, raw.organizationVertical) : null,
    activity_path: raw.activityPath,
    stream: items,
    pending: pendingMessages(pending, timeZone),
    composer: {
      channel: viewer.audience === 'member' && raw.conversationChannel === 'airbnb' ? 'airbnb' : 'email',
      available: replyComposer?.channel !== null,
      reason: replyComposer?.channel === null ? replyComposer.reason : null,
    },
  }
}

/**
 * "In this conversation": the people in it with their roles, its photos newest
 * first, and what the viewer may do to it. A support case has no Report or
 * Block: Airbnb is not a guest.
 */
export async function getInboxThreadDetails(db: DbClient, threadId: string, organizationId: string, viewer: Extract<Viewer, { audience: 'member' }>, now = new Date()): Promise<InboxThreadDetails | null> {
  const detail = await loadGuestThreadDetail(db, threadId, organizationId, { memberUserId: viewer.userId, conversation: viewer.conversation }, now)
  if (!detail) return null
  const raw = detail.view
  const { kind, guestFullName } = inboxGuestNames(raw)
  const team = await queryAll<{ user_id: string; name: string; role: string }>(db, `
    SELECT m.userId AS user_id, u.name, m.role FROM member m JOIN user u ON u.id = m.userId
     WHERE m.organizationId = ? AND (m.role = 'owner'
       OR m.userId IN (SELECT value FROM json_each(?))
       OR m.id = (SELECT c.assigned_member_id FROM conversations conversation JOIN bookings b ON b.id = conversation.booking_id AND b.organization_id = conversation.organization_id
         JOIN product_booking_configs c ON c.organization_id = b.organization_id AND c.product_id = b.product_id WHERE conversation.id = ?))
     ORDER BY m.role = 'owner' DESC, m.createdAt, m.id`,
  [organizationId, d1JsonStringSet(raw.entries.flatMap(entry => entry.actorKind === 'member' && entry.actorUserId ? [entry.actorUserId] : [])), raw.id])
  const photos = raw.entries.filter(entry => entry.kind === 'message')
    .flatMap(entry => entry.attachments.map(photo => ({ id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl, width: photo.width, height: photo.height, sent_at: entrySentAt(entry) })))
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
  const support = kind === 'support'
  return {
    participants: [
      { name: guestFullName, initial: initial(guestFullName), role: support ? 'Airbnb Support' : 'Guest' },
      ...team.map(member => ({ name: member.name, initial: initial(member.name), role: member.role === 'owner' ? 'Host' as const : 'Co-host' as const })),
    ],
    photos,
    actions: {
      show_reservation: raw.operationalRecord !== null,
      archive: raw.canArchive,
      unarchive: raw.canUnarchive,
      report: !support,
      block: !support && raw.mailbox !== 'blocked',
      unblock: !support && raw.mailbox === 'blocked',
    },
  }
}
