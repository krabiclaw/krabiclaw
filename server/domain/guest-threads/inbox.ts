import { HTTPError } from 'nitro'
import { executeBatch, type DbClient } from '~/server/db'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { guestNameColumns, guestTranscript, type ThreadWideFacts, type TranscriptView } from './detail'
import { messagePhotoRowsSql, type MessagePhotoRow } from './attachments'
import { resolveGuestThreadMailbox } from './mailbox'
import { parseGuestRequest, participantLabel } from '~/server/domain/requests'
import { providerTimestamp } from '~/server/integrations/channex/messages'
import { conversationMessage, groupConversationEntries, type ConversationHistory } from '~/server/domain/conversation-history-data'
import { guestReplyDestination } from './operations'
import { assertConversationAccess, conversationParticipantsQuery, isEventMessage, MEMBER_REPLY_EVENT, MIRRORED_EVENT, OPENING_EVENT, SCHEDULED_MESSAGE_EVENT, SUBMISSION_EVENT, type ConversationParticipantRow, type ConversationRow, type ConversationWindow, type MessageRow } from '~/server/domain/conversations'
import { formatFormAnswer } from '~/shared/form-questions'
import { EXPERIENCE_PRESENTATION } from '~/utils/product-presentation'
import { normalizeVertical } from '~/utils/vertical-copy'
import { calendarDate, clockTime, firstName, initial, localDateKey, providerInstant, stayWhen } from './presentation'
import type { ConversationEntry, ConversationMessage, ConversationPage } from '~/shared/messages-contract'
import { formatCalendarRange } from '~/utils/timezone'
import type {
  GuestThreadEntryViewModel,
  InboxChannel,
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

type Viewer = ({ audience: 'member'; userId: string; principal: MemberAccessPrincipal } | { audience: 'buyer'; userId: string }) & { conversation?: ConversationRow }
type MessageItem = ConversationMessage
type ExternalConversationKind = Exclude<InboxThreadKind, 'team'>

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
  kind: ExternalConversationKind
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
export function inboxGuestNames(raw: Pick<TranscriptView, 'entries' | 'guestName' | 'participantLabel' | 'conversationChannel' | 'window'>): { kind: ExternalConversationKind; guestName: string; guestFullName: string } {
  const kind = (raw.window?.support ?? isSupportThread(raw.entries)) ? 'support' : 'guest'
  const airbnbName = raw.entries.findLast(entry => entry.actorKind === 'guest' && entry.eventName === MIRRORED_EVENT && text(meta(entry)?.name))
  // Airbnb gives the guest's first name on their messages; the stay, once booked, has their full name.
  const airbnbFirstName = raw.window ? raw.window.channelGuestName : airbnbName ? text(meta(airbnbName)!.name)! : null
  const guestFullName = kind === 'support' ? 'Airbnb Support' : raw.guestName ?? airbnbFirstName ?? raw.participantLabel
  const guestName = kind === 'support' ? 'Airbnb Support'
    : airbnbFirstName ?? (raw.conversationChannel === 'airbnb' && raw.guestName ? firstName(raw.guestName) : guestFullName)
  return { kind, guestName, guestFullName }
}

function threadFacts(raw: TranscriptView, timeZone: string, now: Date): ThreadFacts {
  const { kind, guestName } = inboxGuestNames(raw)
  const inquiry = raw.inquiry
  const record = raw.operationalRecord
  // A stay is its nights; a booking is its start, in the home's clock; an inquiry is the dates asked about.
  const when = record?.check_in_date && record.check_out_date ? stayWhen(record.check_in_date, record.check_out_date, now, timeZone)
    : record ? `${calendarDate(localDateKey(record.starts_at, timeZone))}, ${clockTime(record.starts_at, timeZone)}`
      : inquiry && kind === 'guest' ? formatCalendarRange(inquiry.checkIn, inquiry.checkOut, 'en-US') : null
  return {
    raw, kind, guestName, channel: raw.conversationChannel,
    home: raw.locationLabel, when, timeZone,
    ownerFirstName: raw.automaticOwner ? firstName(raw.automaticOwner) : null,
    automaticTitles: raw.templateTitles,
    inquiry,
  }
}

const RECEIPT_RANK = ['pending', 'sending', 'accepted', 'sent', 'delivered', 'read'] as const

/** What became of a reply, said once under the newest one as Airbnb says it. */
export function conversationDeliveryReceipt(deliveries: readonly Pick<GuestThreadEntryViewModel['deliveries'][number], 'purpose' | 'provider' | 'status'>[], guestName: string): string | null {
  const attempts = deliveries.filter(delivery => delivery.purpose === 'member_reply' || delivery.purpose === 'scheduled_message')
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
function recordTitle(record: NonNullable<TranscriptView['operationalRecord']>, vertical: string | null): string {
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

/** Builds the stream: day headers, runs of messages with one time each, and events as sentences. */
function stream(facts: ThreadFacts, viewer: Viewer, now: Date, canReply: boolean): ConversationEntry[] {
  const { raw, timeZone } = facts
  const items: Exclude<ConversationEntry, { type: 'day' }>[] = []
  const message = (entry: GuestThreadEntryViewModel, body: string | null, item: Pick<MessageItem, 'side' | 'author' | 'label'>, attachments = entry.attachments) => {
    const next = conversationMessage({
      id: entry.id, sequence: entry.sequence, authorUserId: entry.actorUserId,
      automatic: entry.eventName === SCHEDULED_MESSAGE_EVENT, sentAt: entrySentAt(entry),
      body, attachments, unshownFiles: unshownFiles(entry), ...item,
    })
    items.push(next)
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

  function guestAuthor(entry: GuestThreadEntryViewModel) {
    if (viewer.audience === 'buyer' && entry.actorUserId === viewer.userId) return 'You'
    // Opening and submission rows may predate a guest account. Invited travelers do not see those private booking records.
    if (viewer.audience === 'buyer' && (entry.eventName === OPENING_EVENT || entry.eventName === SUBMISSION_EVENT)) return 'You'
    return entry.actorLabel ?? facts.guestName
  }

  let newestBusiness: { item: MessageItem; entry: GuestThreadEntryViewModel } | null = null
  function applyReceipt(item: MessageItem, entry: GuestThreadEntryViewModel) {
    item.receipt = conversationDeliveryReceipt(entry.deliveries, facts.guestName)
    item.retryable = canReply && item.receipt === 'Not delivered' && entry.eventName === MEMBER_REPLY_EVENT && !item.photos.length && Boolean(text(item.body))
  }
  for (const entry of raw.entries) {
    if (entry.eventName === SUBMISSION_EVENT) {
      // A contact form's words open its conversation: what the guest wrote, then their answers.
      const answers = raw.answers.map(answer => `${answer.label} ${formatFormAnswer(answer, { yes: 'Yes', no: 'No' })}`)
      const words = [text(entry.body), ...answers].filter(Boolean).join('\n\n') || null
      if (words) message(entry, words, { side: 'guest', author: guestAuthor(entry), label: null }, [])
      continue
    }
    if (entry.kind === 'message') {
      // A message with no words, photo or file (an Airbnb host action Channex records that way) says nothing.
      if (!text(entry.body) && !entry.attachments.length && !unshownFiles(entry)) continue
      if (entry.actorKind === 'guest') {
        message(entry, entry.body, { side: 'guest', author: guestAuthor(entry), label: null })
        continue
      }
      // The booking's own message states what the guest asked for, on their side of the conversation.
      if (entry.eventName === OPENING_EVENT) {
        message(entry, entry.body, { side: 'guest', author: guestAuthor(entry), label: null })
        continue
      }
      if (entry.actorKind === 'krabiclaw' && entry.eventName === MIRRORED_EVENT) {
        message(entry, entry.body, { side: 'guest', author: text(meta(entry)?.name) ?? 'Airbnb Support', label: null })
        continue
      }
      const item = message(entry, entry.body, { side: 'business', ...businessAuthor(entry) })
      if (raw.window && viewer.audience === 'member' && conversationDeliveryReceipt(entry.deliveries, facts.guestName) === 'Not delivered') applyReceipt(item, entry)
      newestBusiness = { item, entry }
      continue
    }
    const sentence = eventSentence(entry, facts, viewer)
    items.push({ type: 'event', id: entry.id, sequence: entry.sequence, text: sentence, sent_at: entry.occurredAt })
  }
  if (newestBusiness && viewer.audience === 'member') {
    const { item, entry } = newestBusiness
    applyReceipt(item, entry)
  }
  return groupConversationEntries(items, timeZone, now)
}

/** Booking and contact context for the shared conversation history. */
export async function projectGuestConversation(db: DbClient, conversation: ConversationRow, viewer: Viewer, now: Date, window: ConversationWindow | undefined, history: Promise<ConversationHistory>, includeHeader = true) {
  const detail = await guestTranscript(db, conversation, viewer.audience === 'buyer' ? viewer.userId : null, window, history)
  if (!detail) return null
  const { view: raw, timeZone } = detail
  const facts = threadFacts(raw, timeZone, now)
  const [replyComposer, { page }] = await Promise.all([
    includeHeader && viewer.audience === 'member' ? guestReplyDestination(db, detail.request, detail.channelFacts) : null,
    history,
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
    booking_id: record?.id ?? null,
    record_kind: record ? record.unit === 'nights' ? 'stay' : 'booking' : null,
    record_title: record ? recordTitle(record, raw.organizationVertical) : null,
    activity_path: raw.activityPath,
    stream: items,
    page,
    composer: {
      channel: viewer.audience === 'member' && raw.conversationChannel === 'airbnb' ? 'airbnb' : 'email',
      available: replyComposer?.channel !== null,
      reason: replyComposer?.channel === null ? replyComposer.reason : null,
    },
  } satisfies Omit<InboxThread, 'stream'> & { stream: ConversationEntry[]; page: Omit<ConversationPage['page'], 'read_through'> }
}

/**
 * "In this conversation": the people in it with their roles, its photos newest
 * first, and what the viewer may do to it. A support case has no Report or
 * Block: Airbnb is not a guest.
 */
export async function getInboxThreadDetails(db: DbClient, threadId: string, organizationId: string, viewer: Extract<Viewer, { audience: 'member' }>, now = new Date()): Promise<InboxThreadDetails | null> {
  const conversation = viewer.conversation ?? await assertConversationAccess(db, viewer.principal, threadId, true)
  if (conversation.id !== threadId || conversation.organization_id !== organizationId || conversation.kind === 'team') return null
  const thread = parseGuestRequest(conversation)
  const [factsResult, peopleResult, photosResult] = await executeBatch(db, [
    { query: `SELECT c.blocked_at, c.last_message_at, seat.archived_at, b.ends_at, ${guestNameColumns('c')}
        FROM conversations c
        JOIN conversation_participants seat ON seat.conversation_id = c.id AND seat.organization_id = c.organization_id AND seat.role = 'member' AND seat.user_id = ?
        JOIN member m ON m.userId = seat.user_id AND m.organizationId = seat.organization_id
        LEFT JOIN bookings b ON b.id = c.booking_id AND b.organization_id = c.organization_id
        WHERE c.id = ? AND c.organization_id = ?`, params: [viewer.userId, threadId, organizationId] },
    conversationParticipantsQuery(conversation, viewer.userId, 'member'),
    { query: messagePhotoRowsSql(
      "mp.owner_type = 'message' AND m.conversation_id = ? AND mp.organization_id = ?",
      'JOIN messages m ON m.id = mp.owner_id AND m.organization_id = mp.organization_id',
      `, m.author_kind, m.event_name, m.occurred_at,
       CASE WHEN m.event_name = '${MIRRORED_EVENT}' THEN json_extract(m.payload_json, '$.provider_inserted_at') END AS provider_time`,
      'm.sequence, mp.sort_order',
    ), params: [threadId, organizationId] },
  ], { operation: 'Read conversation details' })
  const facts = factsResult!.results[0] as (ThreadWideFacts & { blocked_at: string | null; archived_at: string | null; last_message_at: string; ends_at: string | null }) | undefined
  if (!facts) return null
  const people = peopleResult!.results as ConversationParticipantRow[]
  const { kind, guestFullName } = inboxGuestNames({
    entries: [], guestName: thread.payload.guest.name, participantLabel: participantLabel(thread), conversationChannel: 'direct',
    window: { support: Boolean(facts.support), channelGuestName: facts.channel_guest_name },
  })
  const guest = { name: guestFullName, initial: initial(guestFullName), role: kind === 'support' ? 'Airbnb Support' as const : 'Guest' as const }
  const participants = people.map(person => {
    const name = person.role === 'guest' && person.id === thread.user_id ? guestFullName : person.name
    return {
      name, initial: initial(name), role: person.role === 'guest' ? guest.role : person.membership_role?.split(',').map(role => role.trim()).includes('owner') ? 'Host' as const : 'Co-host' as const,
    }
  })
  if (!people.some(person => person.role === 'guest' && person.id === thread.user_id)) participants.unshift(guest)
  const photoRows = photosResult!.results as (MessagePhotoRow & Pick<MessageRow, 'author_kind' | 'event_name' | 'occurred_at'> & { provider_time: string | null })[]
  const photos = photoRows.filter(row => !isEventMessage(row)).map(row => ({
    id: row.id, url: row.public_url, thumbnail_url: row.thumbnail_url ?? row.public_url, width: row.width, height: row.height,
    sent_at: row.event_name === MIRRORED_EVENT ? providerInstant(providerTimestamp(row.provider_time, `message:${row.owner_id}`, 'provider_inserted_at')) : row.occurred_at,
  })).sort((a, b) => b.sent_at.localeCompare(a.sent_at))
  const mailbox = resolveGuestThreadMailbox(facts, facts.ends_at === null ? null : { ends_at: facts.ends_at }, now.toISOString(), { lastMessageAt: facts.last_message_at })
  const support = kind === 'support'
  return {
    participants,
    photos,
    actions: {
      archive: mailbox.canArchive,
      unarchive: mailbox.canUnarchive,
      report: !support,
      block: !support && mailbox.mailbox !== 'blocked',
      unblock: !support && mailbox.mailbox === 'blocked',
    },
  }
}
