import type { NotificationFact, NotificationMessage } from './messages'
import { formatPhone } from '~/utils/phone'
import type { BookingPresentation } from '~/utils/booking-presentation'

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
 */

// A fact the event has is stated as it is; one the event genuinely lacks is
// null and is left out. Nothing here writes in text for a fact that is absent:
// a WhatsApp template whose slot it would have filled fails the send instead.
function fact(key: string, label: string, value: string | null, lead = false): NotificationFact | null {
  return value === null ? null : { key, label, value: value.trim(), lead }
}

function facts(...entries: Array<NotificationFact | null>): NotificationFact[] {
  return entries.filter((entry): entry is NotificationFact => entry !== null)
}

export interface ReservationEventInput {
  guestName: string
  guestEmail: string
  guestPhone: string | null
  date: string
  time: string
  partySize: string
  locationName: string | null
  organizationName: string
  notes: string | null
  heroImageUrl: string | null
  replyUrl: string | null
}

export function reservationCreatedMessage(input: ReservationEventInput): NotificationMessage {
  return {
    title: `New confirmed reservation from ${input.guestName}`,
    preheader: `${input.date} at ${input.time} · ${input.partySize}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: '' } : null,
    facts: facts(
      fact('guestName', 'Guest', input.guestName, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', 'Party size', input.partySize, true),
      fact('context', 'Location', input.locationName),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('notes', 'Special requests', input.notes),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Reply in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

export function reservationCancelledMessage(input: ReservationEventInput & { wasConfirmed: boolean }): NotificationMessage {
  // Whether it was confirmed decides how urgently an owner acts, and the
  // approved template has no slot of its own for it — so it leads the venue
  // fact, which WhatsApp does carry, instead of living only in the subject.
  const standing = input.wasConfirmed ? 'Confirmed reservation' : 'Reservation request'
  const venue = [standing, input.locationName].filter(Boolean).join(' · ')
  return {
    title: `${standing} cancelled by ${input.guestName}`,
    preheader: `${input.date} at ${input.time} · ${input.partySize}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: '' } : null,
    facts: facts(
      fact('guestName', 'Guest', input.guestName, true),
      fact('context', 'What was cancelled', venue, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', 'Party size', input.partySize, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail),
      fact('notes', 'Special requests', input.notes),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Open in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

/** A stay a guest booked and paid for on the site. */
export interface StayEventInput {
  guestName: string
  guestEmail: string
  guestPhone: string | null
  homeName: string
  checkIn: string
  checkOut: string
  nights: string
  guests: string
  total: string
  notes: string | null
  organizationName: string
  heroImageUrl: string | null
  replyUrl: string | null
}

export function stayBookedMessage(input: StayEventInput): NotificationMessage {
  return {
    title: `New stay booked by ${input.guestName}`,
    preheader: `${input.homeName} · ${input.checkIn} – ${input.checkOut}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.homeName } : null,
    facts: facts(
      fact('context', 'Place to stay', input.homeName, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('checkIn', 'Check-in', input.checkIn, true),
      fact('checkOut', 'Check-out', input.checkOut, true),
      fact('nights', 'Nights', input.nights, true),
      fact('partySize', 'Guests', input.guests, true),
      fact('total', 'Paid', input.total, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('notes', 'Message from the guest', input.notes),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Reply in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

/** A guest cancelled their stay on the site; the refund is what their booked policy returned. */
export function stayCancelledMessage(input: Omit<StayEventInput, 'notes' | 'total'> & { refund: string }): NotificationMessage {
  return {
    title: `Stay cancelled by ${input.guestName}`,
    preheader: `${input.homeName} · ${input.checkIn} – ${input.checkOut}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.homeName } : null,
    facts: facts(
      fact('context', 'Place to stay', input.homeName, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('checkIn', 'Check-in', input.checkIn, true),
      fact('checkOut', 'Check-out', input.checkOut, true),
      fact('nights', 'Nights', input.nights, true),
      fact('partySize', 'Guests', input.guests, true),
      fact('refund', 'Refunded by your cancellation policy', input.refund, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Open in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

export interface BookingEventInput extends ReservationEventInput {
  productTitle: string
  presentation: BookingPresentation
}

export function bookingCreatedMessage(input: BookingEventInput): NotificationMessage {
  return {
    title: `New ${input.presentation.noun} request from ${input.guestName}`,
    preheader: `${input.productTitle} · ${input.date} at ${input.time}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.productTitle } : null,
    facts: facts(
      fact('context', input.presentation.label, input.productTitle, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', 'Party size', input.partySize, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('notes', 'Special requests', input.notes),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Reply in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

export function bookingCancelledMessage(input: BookingEventInput & { wasConfirmed: boolean }): NotificationMessage {
  const standing = input.wasConfirmed ? `Confirmed ${input.presentation.noun}` : `${input.presentation.label} request`
  return {
    title: `${standing} cancelled by ${input.guestName}`,
    preheader: `${input.productTitle} · ${input.date} at ${input.time}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.productTitle } : null,
    facts: facts(
      fact('context', 'What was cancelled', `${standing} · ${input.productTitle}`, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', 'Party size', input.partySize, true),
      fact('guestPhone', 'Phone', input.guestPhone && formatPhone(input.guestPhone)),
      fact('guestEmail', 'Email', input.guestEmail),
      fact('notes', 'Special requests', input.notes),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Open in dashboard' } : undefined,
    category: 'reservations_bookings',
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
  replyUrl: string | null
}

export function contactReceivedMessage(input: ContactEventInput): NotificationMessage {
  // The product a guest is asking about is the whole point of the message, and
  // the approved template has no slot for it — so it rides in the subject,
  // which does have one, rather than staying in the email alone.
  const subject = [input.subject, input.productTitle].filter(Boolean).join(' · ')
  return {
    title: `New website message from ${input.guestName}`,
    preheader: subject,
    hero: null,
    facts: facts(
      fact('guestName', 'From', input.guestName, true),
      fact('subject', 'About', subject, true),
      fact('guestEmail', 'Email', input.guestEmail, true),
      fact('message', 'Message', input.message, true),
      input.consentAcknowledged ? fact('consent', 'Contact/privacy notice', 'Acknowledged') : null,
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Reply in dashboard' } : undefined,
    category: 'guest_messages',
    organizationName: input.organizationName,
  }
}

export interface GuestReplyEventInput {
  guestName: string
  guestEmail: string | null
  inboundChannel: 'email' | 'whatsapp' | 'web'
  messagePreview: string
  organizationName: string | null
  replyUrl: string | null
}

export function guestReplyMessage(input: GuestReplyEventInput): NotificationMessage {
  // The site name has no slot of its own, so it rides in the subject alongside
  // how the guest wrote in. An owner with several sites needs to know which.
  const subject = [input.inboundChannel === 'whatsapp' ? 'WhatsApp reply' : input.inboundChannel==='web'?'Website reply':'Email reply', input.organizationName].filter(Boolean).join(' · ')
  return {
    title: `New guest reply from ${input.guestName}`,
    preheader: input.messagePreview.slice(0, 120),
    hero: null,
    facts: facts(
      fact('guestName', 'From', input.guestName, true),
      fact('subject', 'Conversation', subject, true),
      fact('guestEmail', 'Email', input.guestEmail),
      fact('message', 'Message', input.messagePreview, true),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Open thread in dashboard' } : undefined,
    category: 'guest_messages',
    organizationName: input.organizationName,
  }
}

export interface ReviewEventInput {
  authorName: string
  rating: number
  content: string
  organizationName: string
  reviewsUrl: string | null
}

export function reviewReceivedMessage(input: ReviewEventInput): NotificationMessage {
  // The approved template has a rating slot and an excerpt slot and no author
  // slot, so the author leads the excerpt — the email's own headline is
  // "New review from {author}", and WhatsApp used to name nobody at all.
  const excerpt = input.content.trim() ? `${input.authorName}: ${input.content.trim()}` : `${input.authorName} left a rating.`
  return {
    title: `New ${input.rating}-star review from ${input.authorName}`,
    preheader: input.content.slice(0, 120) || `${input.rating} out of 5`,
    hero: null,
    facts: facts(
      fact('rating', 'Rating', `${input.rating} / 5`, true),
      fact('review', 'Review', excerpt, true),
    ),
    primaryAction: input.reviewsUrl ? { url: input.reviewsUrl, label: 'View review' } : undefined,
    category: 'reviews',
    organizationName: input.organizationName,
  }
}

export interface BookingReassignedEventInput {
  guestName: string
  productTitle: string
  date: string
  time: string
  partySize: string
  fromName: string | null
  toName: string
  replyUrl: string | null
  organizationName: string
}

export function bookingReassignedMessage(input: BookingReassignedEventInput): NotificationMessage {
  return {
    title: `${input.guestName}’s booking is now with ${input.toName}`,
    preheader: `${input.productTitle} · ${input.date} at ${input.time}`,
    hero: null,
    facts: facts(
      fact('context', 'Booking', input.productTitle, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', 'Party size', input.partySize, true),
      fact('toName', 'Team member', input.toName, true),
      fact('fromName', 'Previously', input.fromName),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'Open in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

export interface BookingChangeEventInput {
  recordKind: string
  guestName: string
  status: 'requested' | 'accepted' | 'declined'
  location: string
  date: string | null
  time: string | null
  whenLabel: string
  partySize: string
  summary: string
  replyUrl: string | null
  organizationName: string
}

export function bookingChangeMessage(input: BookingChangeEventInput): NotificationMessage {
  return {
    title: input.status === 'requested'
      ? `Changes requested for ${input.guestName}'s ${input.recordKind}`
      : `${input.guestName} ${input.status} the ${input.recordKind} changes`,
    preheader: input.summary,
    hero: null,
    intro: input.summary,
    facts: facts(
      fact('recordKind', 'Type', input.recordKind, true),
      fact('guestName', 'Guest', input.guestName, true),
      fact('status', 'Decision', input.status, true),
      fact('location', 'Location', input.location, true),
      // A proposal recorded before the date and time were stored separately
      // has only the combined label. It is stated as itself, never put in the
      // date slot, and WhatsApp uses the template variant without date and time.
      fact('when', 'When', input.whenLabel),
      fact('date', 'Date', input.date, true),
      fact('time', 'Time', input.time, true),
      fact('partySize', 'Party size', input.partySize, true),
      fact('summary', 'Summary', input.summary, true),
    ),
    primaryAction: input.replyUrl ? { url: input.replyUrl, label: 'View in dashboard' } : undefined,
    category: 'reservations_bookings',
    organizationName: input.organizationName,
  }
}

export interface DomainEventInput {
  headline: string
  message: string
  domain: string
  status: string
  dashboardUrl: string
}

export function domainUpdateMessage(input: DomainEventInput): NotificationMessage {
  return {
    title: input.headline,
    preheader: `${input.domain} · ${input.status}`,
    hero: null,
    intro: input.message,
    facts: facts(
      fact('domain', 'Domain', input.domain, true),
      fact('status', 'Status', input.status, true),
      fact('headline', 'Update', input.headline),
    ),
    primaryAction: { url: input.dashboardUrl, label: 'Open domain settings' },
    category: 'organization_and_billing',
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
  subject: 'guest_thread' | 'team_message'
  blocked: boolean
  reason: string
  excerpt: string
  reviewUrl: string
}

/** A member reported a guest or a teammate; KrabiClaw acts on it within 24 hours. */
export function contentReportedMessage(input: ContentReportedInput): NotificationMessage {
  const what = input.subject === 'guest_thread' ? 'a guest conversation' : 'a team message'
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
  }
}

export function onboardingCompletedMessage(input: OnboardingCompletedInput): NotificationMessage {
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
  }
}
