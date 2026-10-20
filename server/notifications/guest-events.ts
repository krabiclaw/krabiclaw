import type { NotificationFact, NotificationMessage } from './messages'
import { platformLocale } from '~/shared/platform-locales'

/**
 * Guest-facing and account mail. Email only: a guest has no account, no
 * preference and no WhatsApp number we are allowed to message unprompted.
 *
 * These carry `category: 'account_security'` where they are transactional and
 * must arrive — a booking confirmation or a password reset is not something a
 * preference switches off.
 */

// A fact the message has is stated as it is; one it genuinely lacks is null and
// left out. Nothing is dropped for being blank or written in for being absent.
function fact(key: string, label: string, value: string | null): NotificationFact | null {
  return value === null ? null : { key, label, value: value.trim() }
}

function facts(...entries: Array<NotificationFact | null>): NotificationFact[] {
  return entries.filter((entry): entry is NotificationFact => entry !== null)
}

export function verifyEmailMessage(input: { verificationUrl: string }): NotificationMessage {
  return {
    title: 'Verify your email',
    preheader: 'Confirm your address to finish setting up your KrabiClaw account.',
    hero: null,
    intro: 'Confirm your email address to finish setting up your account and keep your sign-in secure.',
    facts: [],
    primaryAction: { url: input.verificationUrl, label: 'Verify email' },
    finePrint: 'If you did not create this account, you can ignore this email.',
    category: 'account_security',
  }
}

export function resetPasswordMessage(input: { resetUrl: string }): NotificationMessage {
  return {
    title: 'Reset your password',
    preheader: 'Choose a new KrabiClaw password.',
    hero: null,
    intro: 'We received a request to reset your password. The link below is secure and single-use.',
    facts: [],
    primaryAction: { url: input.resetUrl, label: 'Choose a new password' },
    finePrint: 'If you did not request this, you can ignore this email — your password stays as it is.',
    category: 'account_security',
  }
}

export function organizationInviteMessage(input: {
  organizationName: string
  inviterName: string
  role: string
  inviteUrl: string
}): NotificationMessage {
  return {
    title: `You're invited to ${input.organizationName}`,
    preheader: `${input.inviterName} invited you to join ${input.organizationName} on KrabiClaw.`,
    hero: null,
    facts: facts(
      fact('invitedBy', 'Invited by', input.inviterName),
      fact('organization', 'Organization', input.organizationName),
      fact('role', 'Role', input.role),
    ),
    primaryAction: { url: input.inviteUrl, label: 'Accept invitation' },
    finePrint: 'Not expecting this? You can ignore it — the invitation simply expires.',
    category: 'account_security',
  }
}

export interface GuestBookingInput {
  locale?: string
  guestName: string
  organizationName: string
  organizationLogoUrl?: string | null
  productTitle?: string | null
  date: string
  time: string
  partySize: string
  locationName?: string | null
  notes?: string | null
  contactPhone?: string | null
  contactEmail?: string | null
  cancelUrl?: string | null
  heroImageUrl?: string | null
  /** The platform sign-up the guest's email joins this booking to. */
  accountUrl?: string | null
}

function guestLocale(input: { locale?: string }) {
  const locale = platformLocale(input.locale ?? 'en')
  if (!locale) throw new Error('Guest email language is not supported')
  return locale
}

const accountAction = (url: string | null | undefined, locale?: string) => url ? { url, label: guestLocale({ locale }).messages['guest_account.create']! } : undefined

function guestVisitFacts(input: GuestBookingInput): NotificationFact[] {
  const labels = guestLocale(input).messages
  return facts(
    fact('what', labels[input.productTitle ? 'booking.receipt' : 'site.experience_detail.meeting_point']!, input.productTitle ?? input.locationName ?? null),
    input.productTitle ? fact('location', labels['site.experience_detail.meeting_point']!, input.locationName ?? null) : null,
    fact('date', labels['site.reservation_cancel.date']!, input.date),
    fact('time', labels['site.reservation_cancel.time']!, input.time),
    fact('partySize', labels['site.experience_detail.party_size']!, input.partySize),
    fact('notes', labels['site.experience_detail.special_requests']!, input.notes ?? null),
  )
}

function contactSection(input: GuestBookingInput) {
  const details = [input.contactPhone, input.contactEmail].filter(Boolean).join(' · ')
  return details
    ? [{ title: guestLocale(input).messages['site.contact_page.contact_us']!, body: details }]
    : []
}

export function guestReservationReceivedMessage(input: GuestBookingInput): NotificationMessage {
  const locale = guestLocale(input)
  return {
    locale: locale.locale,
    title: locale.messages['reservations.confirmed']!,
    preheader: `${input.organizationName} · ${input.date} · ${input.time}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.organizationName } : null,
    facts: guestVisitFacts(input),
    primaryAction: input.cancelUrl ? { url: input.cancelUrl, label: locale.messages['booking.receipt']! } : undefined,
    secondaryAction: accountAction(input.accountUrl, locale.locale),
    sections: contactSection(input),
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function guestReservationCancelledMessage(input: GuestBookingInput & { wasConfirmed: boolean }): NotificationMessage {
  const locale = guestLocale(input)
  return {
    locale: locale.locale,
    title: locale.messages['site.reservation_cancel.cancelled_title']!,
    preheader: `${input.organizationName} · ${input.date} · ${input.time}`,
    hero: null,
    facts: guestVisitFacts(input),
    sections: contactSection(input),
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function guestBookingReceivedMessage(input: GuestBookingInput & { productTitle: string; status?: 'pending' | 'confirmed' }): NotificationMessage {
  const locale = guestLocale(input)
  return {
    locale: locale.locale,
    title: locale.messages[input.status === 'pending' ? 'booking.request_received' : 'booking.confirmed']!,
    preheader: `${input.productTitle} · ${input.date} · ${input.time}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.productTitle ?? '' } : null,
    intro: input.status === 'pending' ? locale.messages['booking.pending_message']! : undefined,
    facts: guestVisitFacts(input),
    primaryAction: input.cancelUrl ? { url: input.cancelUrl, label: locale.messages['booking.receipt']! } : undefined,
    secondaryAction: accountAction(input.accountUrl, locale.locale),
    sections: contactSection(input),
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export interface GuestStayInput {
  locale?: string
  guestName: string
  organizationName: string
  organizationLogoUrl: string | null
  homeName: string
  checkIn: string
  checkOut: string
  nights: string
  guests: string
  total: string
  checkInInstructions: string | null
  contactPhone: string | null
  contactEmail: string | null
  heroImageUrl: string | null
  accountUrl: string | null
}

/** The guest's confirmation of a stay they booked and paid for on the site. */
export function guestStayConfirmedMessage(input: GuestStayInput): NotificationMessage {
  const locale = guestLocale(input)
  const labels = locale.messages
  return {
    locale: locale.locale,
    title: labels['stay.confirmed_title']!,
    preheader: `${input.homeName} · ${input.checkIn} – ${input.checkOut}`,
    hero: input.heroImageUrl ? { imageUrl: input.heroImageUrl, alt: input.homeName } : null,
    facts: facts(
      fact('what', labels['stay.your_stay']!, input.homeName),
      fact('checkIn', labels['stay.check_in']!, input.checkIn),
      fact('checkOut', labels['stay.check_out']!, input.checkOut),
      fact('nights', labels['stay.nights']!, input.nights),
      fact('partySize', labels['stay.guests']!, input.guests),
      fact('total', labels['stay.paid_total']!, input.total),
    ),
    secondaryAction: accountAction(input.accountUrl, locale.locale),
    sections: [
      ...(input.checkInInstructions ? [{ title: labels['stay.check_in_instructions']!, body: input.checkInInstructions }] : []),
      ...contactSection({ ...input, date: input.checkIn, time: '', partySize: input.guests }),
    ],
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function guestBookingCancelledMessage(input: GuestBookingInput & { productTitle: string; wasConfirmed: boolean }): NotificationMessage {
  const locale = guestLocale(input)
  return {
    locale: locale.locale,
    title: locale.messages['site.experience_cancel.cancelled_title']!,
    preheader: `${input.productTitle} · ${input.date} · ${input.time}`,
    hero: null,
    facts: guestVisitFacts(input),
    sections: contactSection(input),
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function guestContactReceivedMessage(input: {
  locale?: string
  guestName: string
  organizationName: string
  organizationLogoUrl: string | null
  subject: string | null
  productTitle: string | null
  message: string
  consentAcknowledged: boolean
  accountUrl?: string | null
}): NotificationMessage {
  const locale = guestLocale(input)
  const labels = locale.messages
  return {
    locale: locale.locale,
    title: labels['site.contact_page.confirmed_title']!,
    preheader: input.organizationName,
    hero: null,
    facts: facts(
      fact('subject', labels['site.contact_page.what_about']!, input.subject),
      fact('productTitle', labels['booking.service']!, input.productTitle),
      input.consentAcknowledged ? fact('consent', labels['legal.privacy']!, '✓') : null,
    ),
    primaryAction: accountAction(input.accountUrl, locale.locale),
    sections: [{ title: labels['site.contact_page.your_message']!, body: input.message }],
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function guestThreadReplyMessage(input: {
  organizationName: string
  organizationLogoUrl: string | null
  body: string
  photos?: Array<{ imageUrl: string; alt: string }>
}): NotificationMessage {
  const photos = input.photos ?? []
  return {
    title: `Reply from ${input.organizationName}`,
    preheader: input.body ? input.body.slice(0, 120) : `${input.organizationName} sent ${photos.length === 1 ? 'a photo' : `${photos.length} photos`}`,
    hero: null,
    facts: [],
    sections: input.body ? [{ title: '', body: input.body }] : [],
    photos,
    finePrint: 'Reply to this email and your message goes straight back to the same conversation.',
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function guestThreadStatusMessage(input: {
  locale?: string
  organizationName: string
  organizationLogoUrl: string | null
  heading: string
  body: string
  actionUrl?: string | null
  actionLabel?: string | null
}): NotificationMessage {
  return {
    locale: input.locale,
    title: input.heading,
    preheader: input.body.slice(0, 120),
    hero: null,
    intro: input.body,
    facts: [],
    primaryAction: input.actionUrl && input.actionLabel ? { url: input.actionUrl, label: input.actionLabel } : undefined,
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function bookingChangeProposalMessage(input: {
  locale?: string
  guestName: string
  organizationName: string
  organizationLogoUrl: string | null
  heading: string
  intro: string
  rows: Array<[string, string]>
  actionUrl?: string | null
  actionLabel?: string | null
}): NotificationMessage {
  return {
    locale: input.locale,
    title: input.heading,
    preheader: input.intro.slice(0, 120),
    hero: null,
    intro: input.intro,
    facts: input.rows.map(([label, value], index) => ({ key: `row-${index}`, label, value })),
    primaryAction: input.actionUrl && input.actionLabel ? { url: input.actionUrl, label: input.actionLabel } : undefined,
    category: 'account_security',
    organizationName: input.organizationName,
    organizationLogoUrl: input.organizationLogoUrl,
  }
}

export function reviewRequestMessage(input: {
  guestName: string
  organizationName: string
  locationName: string | null
  visitAt: string
  partySize: string
  reviewUrl: string
  organizationLogoUrl?: string | null
}): NotificationMessage {
  return {
    title: `Thanks for visiting ${input.organizationName}`,
    preheader: `${input.organizationName} would love to hear how everything went.`,
    hero: null,
    organizationLogoUrl: input.organizationLogoUrl,
    intro: `Thanks for visiting, ${input.guestName}. A couple of lines helps other guests know what to expect.`,
    facts: facts(
      fact('visitAt', 'Visit', input.visitAt),
      fact('partySize', 'Party size', input.partySize),
      fact('location', 'Location', input.locationName),
    ),
    primaryAction: { url: input.reviewUrl, label: 'Leave a review' },
    category: 'review_requests',
    organizationName: input.organizationName,
  }
}

export function articleAnnouncementMessage(input: {
  title: string
  summary: string | null
  bodyMarkdown: string
  coverImageUrl: string | null
  articleUrl: string
}): NotificationMessage {
  return {
    title: input.title,
    preheader: input.summary ?? input.title,
    hero: input.coverImageUrl ? { imageUrl: input.coverImageUrl, alt: '' } : null,
    intro: input.summary ?? undefined,
    body: input.bodyMarkdown,
    facts: [],
    primaryAction: { url: input.articleUrl, label: 'Read the article' },
    category: 'product_news',
  }
}
