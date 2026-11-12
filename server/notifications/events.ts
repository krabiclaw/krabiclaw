import type { MemberAlertMessage, NotificationFact, NotificationHistory, NotificationQuote, NotificationSection } from './messages'
import { formatFormAnswer, type FormAnswerSnapshot } from '~/shared/form-questions'
import { formatPhone } from '~/utils/phone'
import { formatCalendarDate, formatCalendarRange } from '~/utils/timezone'
import type { BookingPresentation } from '~/utils/booking-presentation'
import { stayGuestFirstName } from '~/shared/bookings'

/**
 * The owner-facing events that send on both channels, each described once.
 *
 * Facts are ordered by importance: the WhatsApp mapping reads them by key and
 * the approved templates have fixed slots, so what matters is placed high here
 * rather than remembered separately at a send site.
 *
 * `date` and `time` are separate facts rather than one "when" string because
 * the approved templates have a slot for each — and because showing them as two
 * cells is how a reservation reads at a glance.
 *
 * Titles are the email's subject, in Airbnb's form: the event first, then the
 * person or place after a dash or "for" — "Reservation canceled - Mina Park,
 * Jul 20", "Message from Jamie" — never a former state before the event.
 */

/** The first name a subject addresses someone by. */
function firstName(name: string): string {
  return stayGuestFirstName(name) ?? name
}

/** A day as a subject names it: "Jul 20". */
function subjectDay(date: string): string {
  return formatCalendarDate(date, 'en-US', { month: 'short', day: 'numeric' })
}

// A fact the event has is stated as it is; one the event genuinely lacks is
// null and is left out. Nothing here writes in text for a fact that is absent:
// a WhatsApp template whose slot it would have filled fails the send instead.
function fact(key: string, label: string, value: string | null, lead = false): NotificationFact | null {
  return value === null ? null : { key, label, value: value.trim(), lead }
}

function facts(...entries: Array<NotificationFact | null>): NotificationFact[] {
  return entries.filter((entry): entry is NotificationFact => entry !== null)
}

/**
 * The guest's answers to the business's own questions: a fact of the event like
 * its notes, so every channel and the in-app notification carry them, one line
 * per question in the wording the guest answered.
 */
function answersFact(answers: readonly FormAnswerSnapshot[] | null | undefined): NotificationFact | null {
  if (!answers?.length) return null
  return fact('answers', 'Answers', answers.map(answer => `${answer.label}: ${formatFormAnswer(answer, { yes: 'Yes', no: 'No' })}`).join('\n'))
}

/** A class, consultation or table booking as its owner reads it, in the place's own clock. */
export interface BookingEventInput {
  guestName: string
  guestEmail: string
  guestPhone: string | null
  date: string
  /** The day as the subject names it, "Jul 20", in the place's own clock. */
  day: string
  time: string
  partySize: string
  /** Where it happens; null for an online booking. */
  locationName: string | null
  organizationName: string
  notes: string | null
  heroImageUrl: string | null
  replyUrl: string
  /** What the guest paid online for it; null when nothing was paid on the site. */
  paid?: string | null
  /** The guest's answers to the business's own questions. */
  answers?: readonly FormAnswerSnapshot[] | null
  productTitle: string
  presentation: BookingPresentation
  partyLabel?: string
  counterpartyLabel?: string
}

/** What was booked, and where: the offering and its place, as one fact. */
function bookedWhat(input: Pick<BookingEventInput, 'productTitle' | 'locationName'>): string {
  return [input.productTitle, input.locationName].filter(Boolean).join(' · ')
}

/** A stay a guest booked: paid for on the site, or sent by a channel such as Airbnb. */
export interface StayEventInput {
  guestName: string
  guestEmail: string | null
  guestPhone: string | null
  homeName: string
  /** The channel the stay was booked on; null for a stay booked on the site. */
  channel: string | null
  checkIn: string
  checkOut: string
  /** The stay's nights as calendar dates, which the subject names. */
  stayDates: { checkIn: string; checkOut: string }
  /** The guest's own arrival time, when they gave one. */
  arrival: string | null
  nights: string
  guests: string
  /** The booking total; on a channel, the total the channel states, not the payout. */
  total: string | null
  /** What the guest paid on the site; a channel collects its own. */
  paid: string | null
  /** What the guest still owes on the site, when they have not paid it all. */
  balance: string | null
  /** The nights are already held by another stay: a double booking to resolve. */
  overlap: boolean
  notes: string | null
  /** The guest's answers to the home's questions. */
  answers?: readonly FormAnswerSnapshot[] | null
  organizationName: string
  heroImageUrl: string | null
  replyUrl: string
}

export function stayBookedMessage(input: StayEventInput): MemberAlertMessage {
  return {
    title: input.overlap
      ? `Double booking - ${input.guestName}, ${formatCalendarRange(input.stayDates.checkIn, input.stayDates.checkOut, 'en-US')}`
      : `Reservation confirmed - ${input.guestName} arrives ${subjectDay(input.stayDates.checkIn)}`,
    preheader: `${input.homeName} · ${input.checkIn} – ${input.checkOut}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.homeName } : null,
    intro: input.overlap ? `These nights at ${input.homeName} are already held by another stay. Move or cancel one of them before check-in.` : undefined,
    facts: facts(
      fact('context', 'Place to stay', input.homeName, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('checkIn', 'Check-in', input.checkIn, true),
      fact('checkOut', 'Check-out', input.checkOut, true),
      fact('arrival', 'Arriving', input.arrival),
      fact('nights', 'Nights', input.nights, true),
      fact('partySize', 'Guests', input.guests, true),
      fact('total', input.channel ? `Booking total on ${input.channel}` : 'Booking total', input.total, true),
      fact('paid', 'Paid online', input.paid, true),
      fact('balance', 'Balance due', input.balance, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('notes', 'Message from the guest', input.notes),
      answersFact(input.answers),
    ),
    primaryAction: { url: input.replyUrl, label: input.overlap ? 'Resolve double booking' : input.channel ? 'Open stay' : 'Reply in dashboard' },
    category: 'reservations_bookings',
    emailPurpose: 'transactional',
    emailReason: `You received this email because you receive stay booking notifications for ${input.organizationName}.`,
    organizationName: input.organizationName,
  }
}

/** A stay was canceled: by its guest on the site, with what their booked policy refunded, or on its channel. */
export function stayCancelledMessage(input: Omit<StayEventInput, 'notes' | 'total' | 'paid' | 'balance' | 'overlap'> & { refund: string | null }): MemberAlertMessage {
  return {
    title: `Reservation canceled - ${input.guestName}, ${subjectDay(input.stayDates.checkIn)}`,
    preheader: `${input.homeName} · ${input.checkIn} – ${input.checkOut}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.homeName } : null,
    intro: input.channel ? `The stay was canceled on ${input.channel}, and its nights are open again here. Any refund is ${input.channel}'s to make.` : undefined,
    facts: facts(
      fact('context', 'Place to stay', input.homeName, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('checkIn', 'Check-in', input.checkIn, true),
      fact('checkOut', 'Check-out', input.checkOut, true),
      fact('arrival', 'Arriving', input.arrival),
      fact('nights', 'Nights', input.nights, true),
      fact('partySize', 'Guests', input.guests, true),
      fact('refund', 'Refunded by your cancellation policy', input.refund, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
    ),
    primaryAction: { url: input.replyUrl, label: input.channel ? 'Open stay' : 'Open in dashboard' },
    category: 'reservations_bookings',
    emailPurpose: 'transactional',
    emailReason: `You received this email because a stay with ${input.organizationName} was canceled and you receive its booking notifications.`,
    organizationName: input.organizationName,
  }
}

/**
 * The guest as a member who looks after the home reads them: a first name,
 * or the reservation's own label when its channel sent no name.
 */
export function memberGuestName(guest: { name: string } | { label: string }): string {
  return 'label' in guest ? guest.label : stayGuestFirstName(guest.name) ?? guest.name
}

/**
 * A stay alert as a member looking after the home receives it: the turnover's
 * facts, with no contact, money or notes, opening the stay instead of the
 * guest's conversation. Owners and admins receive the input as it is.
 */
export function stayTurnoverAlert<T extends Pick<StayEventInput, 'guestName' | 'guestEmail' | 'guestPhone' | 'replyUrl'>>(input: T, stayUrl: string, guestName: string): T {
  const money = Object.fromEntries((['notes', 'answers', 'total', 'paid', 'balance', 'refund'] as const).filter(field => field in input).map(field => [field, null]))
  return { ...input, ...money, guestName, guestEmail: null, guestPhone: null, replyUrl: stayUrl }
}

export function bookingCreatedMessage(input: BookingEventInput & { status: 'pending' | 'confirmed' }): MemberAlertMessage {
  const counterparty = input.counterpartyLabel ?? input.presentation.counterpartyLabel
  const partyLabel = input.partyLabel ?? input.presentation.partyLabel
  return {
    // A booking that arrived confirmed says so; one waiting for the business is a request.
    title: input.status === 'confirmed'
      ? `${input.presentation.label} confirmed - ${input.guestName}, ${input.day}`
      : `${input.presentation.label} request from ${input.guestName} for ${input.day}`,
    preheader: `${input.productTitle} · ${input.date} at ${input.time}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.productTitle } : null,
    facts: facts(
      fact('context', input.presentation.label, bookedWhat(input), true),
      fact('guestName', counterparty, input.guestName, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', partyLabel, input.partySize, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('notes', 'Special requests', input.notes),
      answersFact(input.answers),
      fact('paid', 'Paid online', input.paid ?? null),
    ),
    primaryAction: { url: input.replyUrl, label: 'Reply in dashboard' },
    category: 'reservations_bookings',
    emailPurpose: 'transactional',
    emailReason: `You received this email because you receive ${input.presentation.noun} notifications for ${input.organizationName}.`,
    organizationName: input.organizationName,
  }
}

export function bookingCancelledMessage(input: BookingEventInput & { wasConfirmed: boolean }): MemberAlertMessage {
  const counterparty = input.counterpartyLabel ?? input.presentation.counterpartyLabel
  const partyLabel = input.partyLabel ?? input.presentation.partyLabel
  const standing = input.wasConfirmed ? `Confirmed ${input.presentation.noun}` : `${input.presentation.label} request`
  return {
    title: `${input.presentation.label} ${input.wasConfirmed ? 'canceled' : 'request withdrawn'} - ${input.guestName}, ${input.day}`,
    preheader: `${input.productTitle} · ${input.date} at ${input.time}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.productTitle } : null,
    facts: facts(
      fact('context', 'What was canceled', `${standing} · ${bookedWhat(input)}`, true),
      fact('guestName', counterparty, input.guestName, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', partyLabel, input.partySize, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail),
      fact('notes', 'Special requests', input.notes),
    ),
    primaryAction: { url: input.replyUrl, label: 'Open in dashboard' },
    category: 'reservations_bookings',
    emailPurpose: 'transactional',
    emailReason: `You received this email because a ${input.presentation.noun} with ${input.organizationName} was canceled and you receive its booking notifications.`,
    organizationName: input.organizationName,
  }
}

export interface ContactEventInput {
  guestName: string
  guestEmail: string
  subject: string
  message: string
  productTitle: string | null
  organizationName: string
  consentAcknowledged: boolean
  replyUrl: string
}

/** A message alert's reply-to answers the guest as the member it was sent to. */
export const REPLY_NOTE = 'Reply to this email or from the dashboard.'

export function contactReceivedMessage(input: ContactEventInput): MemberAlertMessage {
  // The product a guest is asking about is the whole point of the message, and
  // the approved template has no slot for it — so it rides in the subject,
  // which does have one, rather than staying in the email alone.
  const subject = [input.subject, input.productTitle].filter(Boolean).join(' · ')
  const first = firstName(input.guestName)
  return {
    title: `Message from ${first}`,
    preheader: input.message.slice(0, 120),
    hero: null,
    intro: subject ? `About: ${subject}` : undefined,
    facts: facts(
      fact('guestName', 'From', input.guestName, true),
      fact('subject', 'About', subject, true),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('message', 'Message', input.message, true),
      input.consentAcknowledged ? fact('consent', 'Contact/privacy notice', 'Acknowledged') : null,
    ),
    quote: { author: input.guestName, body: input.message, translation: null, photos: [] },
    primaryAction: { url: input.replyUrl, label: 'Reply' },
    finePrint: REPLY_NOTE,
    category: 'messages',
    emailPurpose: 'transactional',
    emailReason: `You received this email because someone contacted ${input.organizationName} and you receive its website messages.`,
    organizationName: input.organizationName,
  }
}

/**
 * What a conversation is about now, under its message: a stay's details, or an
 * inquiry's with the time Airbnb counts a reply as on time. A contact or team
 * conversation, and an Airbnb Support case, have none.
 */
export interface ConversationRecord {
  /** The home's own picture; none is substituted. */
  image: { imageUrl: string; alt: string } | null
  homeName: string
  /** Calendar dates. */
  checkIn: string
  checkOut: string
  guests: string
  /** An inquiry's reply deadline, in the home's clock with its zone: "Oct 31, 4:53 PM MDT". Null for a booked stay. */
  replyBy: string | null
}

function recordSection(record: ConversationRecord): NotificationSection {
  const day = (date: string) => formatCalendarDate(date, 'en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  return {
    title: record.replyBy === null ? 'Reservation details' : 'Inquiry',
    image: record.image,
    facts: facts(
      fact('home', 'Home', record.homeName),
      fact('guests', 'Guests', record.guests),
      fact('checkIn', 'Check-in', day(record.checkIn)),
      fact('checkOut', 'Checkout', day(record.checkOut)),
      fact('replyBy', 'Reply by', record.replyBy),
    ),
  }
}

export interface MessageEventInput {
  /** Who wrote: a guest or teammate by the name the conversation records, or Airbnb Support about a case. */
  sender: { kind: 'person'; name: string; email: string | null } | { kind: 'support' }
  conversationLabel: string
  /** The home, class or booking the conversation belongs to, when it belongs to one. */
  about: string | null
  /** What lists, push and WhatsApp say: the words, or what was sent when there are none. */
  messagePreview: string
  /** The words as written; empty when the message is only photos or files. */
  body: string
  photos: NotificationQuote['photos']
  translation: NotificationQuote['translation']
  /** The conversation's last messages before this one, oldest first. */
  history: NotificationHistory
  record: ConversationRecord | null
  organizationName: string | null
  replyUrl: string
}

const SUPPORT = 'Airbnb Support'

export function messageReceived(input: MessageEventInput): MemberAlertMessage {
  const subject = [input.conversationLabel, input.about, input.organizationName].filter(Boolean).join(' · ')
  const support = input.sender.kind === 'support'
  const name = input.sender.kind === 'person' ? input.sender.name : SUPPORT
  const first = support ? SUPPORT : firstName(name)
  return {
    title: support ? 'New message about your Airbnb Support case' : `Message from ${first}`,
    preheader: input.messagePreview.slice(0, 120),
    hero: null,
    facts: facts(
      fact('guestName', 'From', name, true),
      fact('subject', 'Conversation', subject, true),
      fact('guestEmail', 'Email', input.sender.kind === 'person' ? input.sender.email : null),
      fact('message', 'Message', input.messagePreview, true),
    ),
    quote: { author: first, body: input.body, translation: input.translation, photos: input.photos },
    history: input.history,
    primaryAction: { url: input.replyUrl, label: 'Reply' },
    finePrint: REPLY_NOTE,
    sections: input.record && !support ? [recordSection(input.record)] : [],
    category: 'messages',
    emailPurpose: 'transactional',
    emailReason: input.organizationName
      ? `You received this email because you receive messages for ${input.organizationName}.`
      : 'You received this email because you receive notifications about this conversation.',
    organizationName: input.organizationName,
  }
}

export interface InquiryEventInput {
  guestName: string
  /** The guest's words that asked, as the conversation recorded them. */
  message: string
  photos: NotificationQuote['photos']
  translation: NotificationQuote['translation']
  record: ConversationRecord & { replyBy: string }
  organizationName: string
  replyUrl: string
}

/** An Airbnb guest asked about dates before booking; Airbnb times the host's reply. */
export function inquiryReceivedMessage(input: InquiryEventInput): MemberAlertMessage {
  const { record } = input
  const dates = formatCalendarRange(record.checkIn, record.checkOut, 'en-US')
  const nights = Math.round((Date.parse(`${record.checkOut}T00:00:00Z`) - Date.parse(`${record.checkIn}T00:00:00Z`)) / 86_400_000)
  const first = firstName(input.guestName)
  return {
    title: `Inquiry for ${record.homeName} for ${dates}`,
    preheader: `Reply by ${record.replyBy} · ${input.message.slice(0, 100)}`,
    hero: null,
    facts: facts(
      fact('guestName', 'From', input.guestName, true),
      fact('subject', 'Inquiry', `Airbnb inquiry · ${record.homeName}`, true),
      fact('message', 'Asking for', `Reply by ${record.replyBy} · ${dates} · ${nights} night${nights === 1 ? '' : 's'} · ${record.guests}`, true),
    ),
    quote: { author: first, body: input.message, translation: input.translation, photos: input.photos },
    primaryAction: { url: input.replyUrl, label: 'Reply' },
    finePrint: REPLY_NOTE,
    sections: [recordSection(record)],
    category: 'messages',
    emailPurpose: 'transactional',
    emailReason: `You received this email because a guest asked ${input.organizationName} about a stay on Airbnb and you receive its messages.`,
    organizationName: input.organizationName,
  }
}

export interface ReviewEventInput {
  authorName: string
  rating: number
  content: string
  /** The guest also wrote to the business privately; its text is read where it is authorized, never in an alert. */
  hasPrivateFeedback?: boolean
  organizationName: string
  reviewsUrl: string
}

export function reviewReceivedMessage(input: ReviewEventInput): MemberAlertMessage {
  // The approved template has a rating slot and an excerpt slot and no author
  // slot, so the author leads the excerpt — the email's own headline is
  // "Read {author}'s review", and WhatsApp used to name nobody at all.
  const privately = input.hasPrivateFeedback ? ' and private feedback' : ''
  const excerpt = input.content.trim() ? `${input.authorName}: ${input.content.trim()}` : `${input.authorName} left a rating${privately}.`
  return {
    title: `Read ${firstName(input.authorName)}'s review`,
    preheader: input.content.slice(0, 120) || `${input.rating} out of 5`,
    hero: null,
    facts: facts(
      fact('rating', 'Rating', `${input.rating} / 5`, true),
      fact('review', 'Review', excerpt, true),
    ),
    primaryAction: { url: input.reviewsUrl, label: 'View review' },
    category: 'reviews',
    emailPurpose: 'subscribed',
    emailReason: `You receive this email under your review notification preferences for ${input.organizationName}.`,
    organizationName: input.organizationName,
  }
}

export interface BookingChangeAssignment {
  beforeMemberId: string | null; beforeName: string | null
  afterMemberId: string | null; afterName: string | null
  label: string
}

/** One side of a change: what is booked now, or what the change asks for. */
export interface BookingChangeTerms {
  /** A stay's dates, or a booking's date. */
  date: string
  /** A booking's time; a stay has none. */
  time: string | null
  nights: number | null
  partySize: string
  location: string
  /** The booking total, not the payout; null where the change states no price or the reader may not see money. */
  total: string | null
  assignee: string | null
}

/** A difference between the two sides, worded for an owner; `financial` ones are left out wherever money is. */
export interface BookingChangeDifference {
  text: string
  financial?: boolean
}

/** `changed` is a change its channel confirmed, which nobody here was asked to answer. */
export type BookingChangeStatus = 'requested' | 'accepted' | 'declined' | 'withdrawn' | 'changed'

export interface BookingChangeEventInput {
  recordKind: string
  /** What was booked, when it has a name of its own (a class, a consultation type); it names the booking better than its kind. */
  offering?: string | null
  /** The channel the guest asked on, when it was not this site. */
  channel: string | null
  guestName: string
  /** Who asked: the guest, or the member of the business who proposed it. Only a pending proposal names its member. */
  requestedBy: { kind: 'guest' } | { kind: 'business'; name: string | null }
  status: BookingChangeStatus
  current: BookingChangeTerms
  requested: BookingChangeTerms
  differences: BookingChangeDifference[]
  counterpartyLabel?: string
  partyLabel?: string
  locationLabel?: string
  assigneeLabel?: string
  replyUrl: string
  organizationName: string
}

/** The same change as a member who may not see money reads it: no totals, no price difference, the guest as `memberGuestName` names them. */
export function bookingChangeWithoutMoney(input: BookingChangeEventInput, replyUrl: string, guestName: string): BookingChangeEventInput {
  return {
    ...input, replyUrl, guestName,
    current: { ...input.current, total: null }, requested: { ...input.requested, total: null },
    differences: input.differences.filter(difference => !difference.financial),
  }
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`

/** What an Airbnb stay change does, read from the two sets of dates, guests and totals. */
export function stayChangeDifferences(current: { checkIn: string; checkOut: string; guests: number; infants: number; totalMinor: number }, requested: { checkIn: string; checkOut: string; guests: number; infants: number; totalMinor: number }, money: (minor: number) => string): BookingChangeDifference[] {
  const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
  const arrival = days(current.checkIn, requested.checkIn)
  const departure = days(current.checkOut, requested.checkOut)
  const nights = days(requested.checkIn, requested.checkOut) - days(current.checkIn, current.checkOut)
  const guests = requested.guests - current.guests
  const infants = requested.infants - current.infants
  const total = requested.totalMinor - current.totalMinor
  return [
    ...(arrival ? [{ text: `Arrives ${plural(Math.abs(arrival), 'day')} ${arrival < 0 ? 'earlier' : 'later'}` }] : []),
    ...(departure ? [{ text: `Leaves ${plural(Math.abs(departure), 'day')} ${departure < 0 ? 'earlier' : 'later'}` }] : []),
    ...(nights ? [{ text: `${plural(Math.abs(nights), nights > 0 ? 'more night' : 'fewer night', nights > 0 ? 'more nights' : 'fewer nights')}` }] : []),
    ...(guests ? [{ text: `${plural(Math.abs(guests), guests > 0 ? 'more guest' : 'fewer guest', guests > 0 ? 'more guests' : 'fewer guests')}` }] : []),
    ...(infants ? [{ text: `${plural(Math.abs(infants), infants > 0 ? 'more infant' : 'fewer infant', infants > 0 ? 'more infants' : 'fewer infants')}` }] : []),
    ...(total ? [{ text: `Booking total ${total > 0 ? '+' : '−'}${money(Math.abs(total))}`, financial: true }] : []),
  ]
}

/** What a booking or reservation change does, read from the two occurrences. */
export function occurrenceChangeDifferences(current: BookingChangeTerms, requested: BookingChangeTerms, labels: { party: string; assignee: string }): BookingChangeDifference[] {
  const moved = current.date !== requested.date
  const retimed = current.time !== requested.time
  return [
    ...(moved || retimed ? [{ text: moved && retimed ? `Moves to ${requested.date} at ${requested.time}` : moved ? `Moves to ${requested.date}` : `Moves to ${requested.time}` }] : []),
    ...(current.location !== requested.location ? [{ text: `Moves to ${requested.location}` }] : []),
    ...(current.partySize !== requested.partySize ? [{ text: `${labels.party}: ${requested.partySize}` }] : []),
    ...(current.assignee !== requested.assignee ? [{ text: `${labels.assignee}: ${requested.assignee ?? 'Unassigned'}` }] : []),
  ]
}

// A row both sides lack is absent; one side lacking it is a change to or from nothing.
function comparison(current: string | null, requested: string | null): string | null {
  if (current === null && requested === null) return null
  if (current === requested) return `${requested} (unchanged)`
  return `${current ?? 'None'} → ${requested ?? 'None'}`
}

/**
 * A change to a booking, as its owners read it: what is booked now beside what
 * the change asks for, each row as "current → requested", what actually
 * differs, who asked or answered, and whether anything is confirmed yet.
 */
export function bookingChangeMessage(input: BookingChangeEventInput): MemberAlertMessage {
  const counterparty = input.counterpartyLabel ?? (input.recordKind === 'consultation' ? 'Client' : 'Guest')
  const partyLabel = input.partyLabel ?? (input.recordKind === 'consultation' ? 'Clients' : input.recordKind === 'stay' ? 'Guests' : 'Party size')
  const what = input.channel ? `${input.channel} ${input.recordKind}` : input.recordKind
  const asker = input.requestedBy.kind === 'guest' ? input.guestName : input.requestedBy.name ?? input.organizationName
  const awaitingHost = input.status === 'requested' && input.requestedBy.kind === 'guest'
  const standing = {
    requested: awaitingHost
      ? `Requested by ${asker}${input.channel ? ` on ${input.channel}` : ''} · not confirmed until you accept`
      : `Proposed by ${asker} · waiting for ${input.guestName} to accept`,
    accepted: `Accepted by ${input.guestName} · the new details are confirmed`,
    declined: `Declined by ${input.guestName} · the current details stay booked`,
    withdrawn: `Withdrawn by ${input.guestName}${input.channel ? ` on ${input.channel}` : ''} · the current details stay booked`,
    changed: `Changed${input.channel ? ` on ${input.channel}` : ''} · the new details are confirmed`,
  }[input.status]
  const differences = input.differences.map(difference => difference.text).join(' · ') || 'No change to the booked details'
  // A stay is a reservation, as Airbnb calls it; a booking or consultation keeps its own name.
  const noun = input.recordKind === 'stay' ? 'reservation' : input.recordKind
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1)
  return {
    title: {
      requested: awaitingHost ? `${Noun} change requested - ${input.guestName}` : `${Noun} change proposed - ${input.guestName}`,
      accepted: `Your ${noun} change was accepted`,
      declined: `Your ${noun} change was declined`,
      withdrawn: `Your ${noun} change was withdrawn`,
      changed: `${Noun} changed - ${input.guestName}`,
    }[input.status],
    preheader: differences,
    hero: null,
    intro: {
      requested: awaitingHost
        ? `Nothing changes until you accept.${input.channel ? ` Your answer goes to ${input.guestName} on ${input.channel}.` : ''}`
        : `${input.guestName} has been asked to accept or decline. The current details stay booked until they accept.`,
      accepted: 'The new details are confirmed.',
      declined: 'The current details stay booked.',
      withdrawn: 'The current details stay booked, and there is nothing to answer.',
      changed: `The new details are confirmed${input.channel ? ` on ${input.channel}` : ''}, and the home's calendar here follows them.`,
    }[input.status],
    facts: facts(
      fact('guestName', counterparty, input.guestName, true),
      fact('status', 'Status', standing, true),
      fact('summary', 'What changes', differences, true),
      fact('location', input.locationLabel ?? 'Location', comparison(input.current.location, input.requested.location), true),
      fact('date', input.recordKind === 'stay' ? 'Dates' : 'Date', comparison(input.current.date, input.requested.date), true),
      fact('time', 'Time', comparison(input.current.time, input.requested.time), true),
      fact('nights', 'Nights', comparison(input.current.nights === null ? null : String(input.current.nights), input.requested.nights === null ? null : String(input.requested.nights))),
      fact('partySize', partyLabel, comparison(input.current.partySize, input.requested.partySize), true),
      fact('total', 'Booking total', comparison(input.current.total, input.requested.total)),
      fact('assignee', input.assigneeLabel ?? 'Assigned to', input.current.assignee === null && input.requested.assignee === null ? null
        : comparison(input.current.assignee ?? 'Unassigned', input.requested.assignee ?? 'Unassigned')),
      fact('recordKind', 'Booking', input.offering ?? what.charAt(0).toUpperCase() + what.slice(1), true),
    ),
    primaryAction: { url: input.replyUrl, label: awaitingHost ? 'Review requested changes' : input.status === 'changed' ? 'Open stay' : 'Open conversation' },
    category: 'reservations_bookings',
    emailPurpose: 'transactional',
    emailReason: `You received this email because changes were proposed or answered for a ${input.recordKind} with ${input.organizationName} and you receive its booking notifications.`,
    organizationName: input.organizationName,
  }
}

export interface DomainEventInput {
  event: 'added' | 'synced' | 'deleted'
  domain: string
  status: string
  /** Why the domain is not live, as its provider stated it. */
  error: string | null
  /** The DNS records still to add at the domain's registrar, with what each is for. */
  records: Array<{ type: string; name: string; value: string; purpose: string }>
  /** For an apex domain, the forward the registrar needs instead of a record. */
  apexNote: string | null
  dashboardUrl: string
}

const DOMAIN_IMPACT: Record<string, string> = {
  active: 'Your site is live at this domain, with HTTPS.',
  pending: 'Your site is not live at this domain yet. Add the DNS records below at your domain registrar; KrabiClaw checks them and switches the domain on once they are in place.',
  verifying: 'The DNS records were found and the domain is being verified. Your site goes live at this domain once verification finishes; nothing else is needed from you unless a record is still listed below.',
  blocked: 'This domain cannot serve your site. Review the reason below in domain settings.',
  failed: 'This domain could not be set up, and your site is not live at it. Review the reason below, correct the DNS records, then check the domain again.',
  disabled: 'This domain no longer serves your site.',
  deleted: 'This domain no longer serves your site. Remove its KrabiClaw DNS records at your registrar if you are not using them elsewhere.',
}

const RECORD_PURPOSE: Record<string, string> = { ownership: 'Proves you own the domain', dcv_delegation: 'Lets the certificate renew', traffic: 'Points the domain at your site', ssl: 'Issues the HTTPS certificate' }

export function domainUpdateMessage(input: DomainEventInput): MemberAlertMessage {
  const headline = { added: `Domain added: ${input.domain}`, synced: input.status === 'active' ? `${input.domain} is live` : `${input.domain} is ${input.status}`, deleted: `Domain removed: ${input.domain}` }[input.event]
  const impact = DOMAIN_IMPACT[input.status]
  if (!impact) throw new Error(`Domain status ${input.status} has no stated impact`)
  const records = input.status === 'active' || input.event === 'deleted' ? [] : input.records
  return {
    title: headline,
    preheader: `${input.domain} · ${input.status}`,
    hero: null,
    intro: impact,
    facts: facts(
      fact('domain', 'Domain', input.domain, true),
      fact('status', 'Status', input.status, true),
      fact('error', 'Reason', input.error),
    ),
    sections: [
      ...records.map((record, index) => ({
        title: `DNS record ${index + 1} of ${records.length}: ${RECORD_PURPOSE[record.purpose] ?? record.purpose}`,
        facts: facts(fact('type', 'Type', record.type), fact('name', 'Name', record.name), fact('value', 'Value', record.value)),
      })),
      ...(input.apexNote && records.length ? [{ title: 'At the domain itself', body: input.apexNote }] : []),
    ],
    primaryAction: { url: input.dashboardUrl, label: 'Open domain settings' },
    category: 'organization_and_billing',
    emailPurpose: 'transactional',
    emailReason: `You received this email because you receive status updates for ${input.domain}.`,
  }
}

export interface OnboardingCompletedInput {
  organizationName: string
  ownerName: string
  ownerEmail: string
  siteUrl: string
  viewCustomerUrl: string
}

/** Tells the KrabiClaw operator a new business finished onboarding and is live. */
export interface ContentReportedInput {
  organizationName: string
  reporter: string
  subject: 'conversation' | 'message'
  blocked: boolean
  reason: string
  excerpt: string
  reviewUrl: string
}

/** A member reported a guest or a teammate; KrabiClaw acts on it within 24 hours. */
export function contentReportedMessage(input: ContentReportedInput): MemberAlertMessage {
  const what = input.subject === 'conversation' ? 'a guest conversation' : 'a team message'
  return {
    title: `${input.blocked ? 'Guest blocked and reported' : 'Content reported'} in ${input.organizationName}`,
    preheader: `${input.reporter} reported ${what}. Review it within 24 hours.`,
    hero: null,
    facts: facts(
      fact('business', 'Business', input.organizationName, true),
      fact('reporter', 'Reported by', input.reporter, true),
      fact('reason', 'Reason', input.reason, true),
      fact('excerpt', 'Reported content', input.excerpt),
    ),
    primaryAction: { url: input.reviewUrl, label: 'Review report' },
    category: 'account_security',
    emailPurpose: 'transactional',
    emailReason: 'You received this email because you handle content reports for KrabiClaw.',
  }
}

export function onboardingCompletedMessage(input: OnboardingCompletedInput): MemberAlertMessage {
  return {
    title: `${input.organizationName} is live on KrabiClaw`,
    preheader: `${input.ownerName} finished onboarding`,
    hero: null,
    facts: facts(
      fact('business', 'Business', input.organizationName, true),
      fact('owner', 'Owner', `${input.ownerName} (${input.ownerEmail})`, true),
      fact('site', 'Site', input.siteUrl),
    ),
    primaryAction: { url: input.viewCustomerUrl, label: 'View customer' },
    secondaryAction: { url: input.siteUrl, label: 'Open site' },
    category: 'organization_and_billing',
    emailPurpose: 'transactional',
    emailReason: `You received this email because ${input.organizationName} completed setup and you receive KrabiClaw business onboarding alerts.`,
  }
}

export interface OwnerWelcomeInput {
  organizationName: string
  ownerName: string
  siteUrl: string
  dashboardUrl: string
  vertical: string | null | undefined
}

/** Selects vertical-tailored greeting prompts for new business onboarding. */
function welcomeVerticalPrompt(vertical: string | null | undefined, organizationName: string): string {
  const v = vertical?.trim().toLowerCase()
  switch (v) {
    case 'experience':
      return `What kind of experience or activity are you planning to host with ${organizationName}? If you need a hand setting up your first activity, booking schedule, or customizing your site, just reply directly to this email — I’m happy to help you get everything dialed in.`
    case 'restaurant':
      return `What kind of dining experience or cuisine are you featuring at ${organizationName}? If you need a hand setting up your menu, table reservations, or customizing your site, just reply directly to this email — I’m happy to help you get everything dialed in.`
    case 'lodging':
      return `Tell me a bit about your property — how many homes or rooms are you hosting with ${organizationName}? If you need a hand adding your first stay, setting up calendar sync with Airbnb or Vrbo, or customizing your site, just reply directly to this email — I’m happy to help you get everything dialed in.`
    case 'service':
      return `Tell me a bit about your practice at ${organizationName}. If you need a hand setting up your practice areas, consultation requests, attorney profiles, or customizing your site, just reply directly to this email — I’m happy to help you get everything dialed in.`
    default:
      return `What are you planning to build with ${organizationName}? If you need a hand setting up your offerings, booking flow, or customizing your site, just reply directly to this email — I’m happy to help you get everything dialed in.`
  }
}

/** A personal founder welcome from Paul to every new business owner who finishes onboarding. */
export function ownerWelcomeMessage(input: OwnerWelcomeInput): MemberAlertMessage {
  const greeting = firstName(input.ownerName)
  const verticalPrompt = welcomeVerticalPrompt(input.vertical, input.organizationName)
  const body = [
    `I saw that you just launched ${input.organizationName} on KrabiClaw (${input.siteUrl}) — congratulations!`,
    `I’m Paul, the founder of KrabiClaw. I wanted to reach out personally to welcome you and see how setup went.`,
    verticalPrompt,
    `Excited to have you on board,\n\n**Paul**  \nFounder, KrabiClaw`,
  ].join('\n\n')

  return {
    title: `Welcome to KrabiClaw — congrats on launching ${input.organizationName}!`,
    preheader: `Welcome to KrabiClaw — your site is live at ${input.siteUrl}`,
    hero: null,
    intro: `Hi ${greeting},`,
    body,
    facts: facts(
      fact('business', 'Business', input.organizationName, true),
      fact('site', 'Site', input.siteUrl, true),
    ),
    primaryAction: { url: input.dashboardUrl, label: 'Open your dashboard' },
    secondaryAction: { url: input.siteUrl, label: 'View your site' },
    finePrint: 'You can reply directly to this email to reach me.',
    category: 'organization_and_billing',
    emailPurpose: 'transactional',
    emailReason: `You received this email because you launched ${input.organizationName} on KrabiClaw.`,
  }
}

export interface TaskAlertInput {
  /** Someone gave the reader this task, or its window starts today. */
  kind: 'assigned' | 'starting'
  /** Who gave it; null when the business's own records did. */
  actorName: string | null
  /** As the task reads on Today: kind and time, the place or person, one line of context. */
  task: { eyebrow: string; title: string; detail: string | null }
  organizationName: string
  taskUrl: string
}

/** A task the reader now has, or one whose window starts today. */
export function taskAlertMessage(input: TaskAlertInput): MemberAlertMessage {
  const assigned = input.kind === 'assigned'
  const what = `${input.task.eyebrow} · ${input.task.title}`
  return {
    title: assigned ? `${input.actorName ? firstName(input.actorName) : 'Someone'} gave you a task: ${input.task.title}` : `Today: ${input.task.title}`,
    preheader: [input.task.eyebrow, input.task.detail].filter(Boolean).join(' · ').slice(0, 120),
    hero: null,
    facts: facts(
      fact('guestName', assigned ? 'From' : 'Business', assigned ? input.actorName ?? input.organizationName : input.organizationName, true),
      fact('subject', 'Task', what, true),
      fact('message', 'Details', input.task.detail ?? input.task.title, true),
    ),
    primaryAction: { url: input.taskUrl, label: 'Open task' },
    category: 'tasks',
    emailPurpose: 'transactional',
    emailReason: `You received this email because you are assigned work at ${input.organizationName}.`,
    organizationName: input.organizationName,
  }
}

