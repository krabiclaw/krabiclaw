import type { WhatsAppTemplate } from '~/server/utils/whatsapp'
import { reviewEditorPath } from '~/server/utils/dashboard-links'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type { NotificationMessage } from './messages'
import { guestPaymentMessage, ownerPaymentMessage, subscriptionPlanMessage } from './payment-events'
import type { GuestPaymentNotificationEvent, PaymentNotificationEvent } from './payment-events'
import {
  bookingCancelledMessage,
  bookingChangeMessage,
  bookingCreatedMessage,
  occurrenceChangeDifferences,
  stayChangeDifferences,
  contactReceivedMessage,
  stayBookedMessage,
  stayCancelledMessage,
  stayTurnoverAlert,
  domainUpdateMessage,
  onboardingCompletedMessage,
  ownerWelcomeMessage,
  contentReportedMessage,
  inquiryReceivedMessage,
  messageReceived,
  taskAlertMessage,
  reviewReceivedMessage,
} from './events'
import {
  articleAnnouncementMessage,
  bookingChangeProposalMessage,
  guestBookingCancelledMessage,
  guestBookingReceivedMessage,
  guestContactReceivedMessage,
  guestStayConfirmedMessage,
  guestThreadReplyMessage,
  guestThreadStatusMessage,
  organizationInviteMessage,
  resetPasswordMessage,
  reviewRequestMessage,
  verifyEmailMessage,
} from './guest-events'

/**
 * Every message the product sends, with sample data.
 *
 * One list, because the preview and the guards must be looking at the same
 * thing — a preview showing something no check covers is worth nothing, and a
 * check covering something nobody can see does not help anyone write copy.
 *
 * `whatsappTemplate` marks the events that also send over WhatsApp; those are
 * the ones lint:notification-parity holds to the rule that every lead fact
 * reaches both channels.
 */
export interface CatalogEntry {
  id: string
  audience: 'owner' | 'guest'
  title: string
  message: NotificationMessage
  whatsappTemplate?: WhatsAppTemplate
}

const restaurant = 'Ember & Slice'
const studio = 'Pottery House Krabi'
const inbox = 'https://demo.krabiclaw.com/dashboard/ember-slice/messages/preview-1'

// A restaurant's table booking: the booking messages in the reservation's words.
const reservation = {
  guestName: 'Alex Carter',
  guestEmail: 'alex@example.com',
  guestPhone: '+1 555 123 4567',
  date: 'Tue, Jul 14, 2026',
  day: 'Jul 14',
  time: '7:00 PM',
  partySize: '2 guests',
  locationName: 'Main Dining Room',
  organizationName: restaurant,
  notes: 'Window seat, celebrating an anniversary.',
  heroImageUrl: null,
  replyUrl: inbox,
  paid: '$20.00',
  productTitle: 'Main Dining Room table',
  presentation: resolveBookingPresentation('table', 'restaurant'),
}

// A real tenant asset, so the preview shows what a hero actually looks like
// rather than a message that happens to have none.
const sampleCover = 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/245066b6-926f-4dbb-e731-53ebb0e22700/public'
// A real tenant logo asset from D1, so the preview shows the tenant's mark in the header.
const sampleLogo = 'https://imagedelivery.net/Frxyb2_d_vGyiaXhS5xqCg/881bb3e2-b2eb-47e0-9e05-152bfa0f1dba/thumbnail'

// Owner alerts leave the event builders without a mark; notifyOwner adds the
// organization's logo before rendering, and the preview shows what it sends.
const ownerAlert = (message: NotificationMessage): NotificationMessage => ({ ...message, organizationLogoUrl: sampleLogo })

const stay = {
  guestName: 'Mina', guestEmail: 'mina@example.com', guestPhone: '+1 415 555 0134', homeName: 'Cedar Loft',
  checkIn: 'Fri, Nov 6, 2026 · from 15:00', checkOut: 'Mon, Nov 9, 2026 · by 11:00', stayDates: { checkIn: '2026-11-06', checkOut: '2026-11-09' },
  arrival: '6:00 PM', nights: '3', guests: '2 adults',
  organizationName: 'Pinecone Stays', heroImageUrl: null, replyUrl: 'https://demo.krabiclaw.com/dashboard/pinecone-stays/messages/preview-1',
  channel: null,
}
const stayBooked = { ...stay, total: '$645.00', paid: '$645.00', balance: null, overlap: false, notes: 'We will bring our dog if that is fine.' }
const stayCancelled = { ...stay, refund: '$322.50' }
// A member looking after the home opens the stay itself.
const stayPreviewUrl = 'https://demo.krabiclaw.com/dashboard/pinecone-stays/bookings/preview-1'
// A stay Airbnb sent opens the stay: it has a conversation only once the guest writes.
const airbnbStay = { ...stay, guestName: 'Jamie Rivera', guestEmail: null, guestPhone: null, channel: 'Airbnb', replyUrl: stayPreviewUrl }
const airbnbBooked = { ...airbnbStay, total: '$1,284.00', paid: null, balance: null, overlap: false, notes: null }

const booking = {
  ...reservation,
  heroImageUrl: sampleCover,
  organizationLogoUrl: sampleLogo,
  guestName: 'Mina Park',
  guestEmail: 'mina@example.com',
  guestPhone: '+66 76 000 0002',
  organizationName: studio,
  productTitle: 'Pottery Wheel Class',
  presentation: resolveBookingPresentation('experience', 'experience'),
  // The studio's own question, answered as the guest read it.
  answers: [{ question_id: 'experience_level', label: 'Have you thrown on a wheel before?', type: 'yes_no' as const, help_text: null, value: false, selected_choices: [] }],
  date: 'Mon, Jul 20, 2026',
  day: 'Jul 20',
  time: '10:00 AM',
  locationName: 'Main Studio',
  notes: null,
}

const guestVisit = {
  guestName: 'Alex Carter',
  organizationName: restaurant,
  organizationLogoUrl: sampleLogo,
  date: 'Tue, Jul 14, 2026',
  time: '7:00 PM',
  partySize: '2 guests',
  locationName: 'Main Dining Room',
  notes: 'Window seat.',
  contactPhone: '+1 555 000 0000',
  contactEmail: 'hello@emberslice.example',
  receiptUrl: 'https://demo.krabiclaw.com/bookings/confirmed?id=preview',
  heroImageUrl: sampleCover,
}

const payment = {
  organizationName: studio,
  organizationLogoUrl: sampleLogo,
  amount: 10000,
  currency: 'USD' as const,
  productTitle: 'Pottery Wheel Class',
  action: { url: 'https://demo.krabiclaw.com/dashboard/pottery-house/earnings', label: 'View payment' },
}

// Preview data only: these show native statuses, not qualified financial sends.
const ownerPayments: PaymentNotificationEvent[] = [
  { ...payment, kind: 'payment_captured' },
  { ...payment, kind: 'payment_failed' },
  { ...payment, kind: 'refund_pending', amount: 5000 },
  { ...payment, kind: 'refund_succeeded', amount: 5000 },
  { ...payment, kind: 'refund_failed', amount: 5000 },
  { ...payment, kind: 'refund_canceled', amount: 5000 },
  { ...payment, kind: 'dispute_needs_response', responseDueBy: 'Oct 12, 2026 at 5:00 PM UTC' },
  { ...payment, kind: 'dispute_won' },
  { ...payment, kind: 'dispute_lost' },
  { ...payment, kind: 'dispute_closed' },
  { ...payment, kind: 'payout_paid', amount: 25000, productTitle: null, arrivalDate: 'Oct 7, 2026', action: { ...payment.action, label: 'View payout' } },
  { ...payment, kind: 'payout_failed', amount: 25000, productTitle: null, action: { ...payment.action, label: 'View payout' } },
]

const guestPayments: GuestPaymentNotificationEvent[] = [
  { ...payment, kind: 'payment_captured', action: { url: 'https://pay.stripe.com/receipts/preview', label: 'View receipt' } },
  ...(['payment_failed', 'refund_pending', 'refund_succeeded', 'refund_failed', 'refund_canceled'] as const).map(kind => ({
    ...payment, kind, amount: kind === 'payment_failed' ? payment.amount : 5000,
    action: { url: 'https://demo.krabiclaw.com/account', label: 'View purchase' },
  })),
]

export const NOTIFICATION_CATALOG: CatalogEntry[] = [
  { id: 'team-message', audience: 'owner', title: 'Team — new message', whatsappTemplate: 'guest_thread_reply_whatsapp', message: ownerAlert(messageReceived({ sender: { kind: 'person', name: 'Alex Carter', email: null }, conversationLabel: 'Team', about: null, messagePreview: 'The home is ready for check-in.', body: 'The home is ready for check-in.', photos: [], history: [], translation: null, record: null, organizationName: studio, replyUrl: inbox })) },
  { id: 'task-assigned', audience: 'owner', title: 'Tasks — assigned to you', whatsappTemplate: 'guest_thread_reply_whatsapp', message: ownerAlert(taskAlertMessage({ kind: 'assigned', actorName: 'Alex Carter', task: { eyebrow: 'Turnover · 11:00 AM – 3:00 PM', title: '70 2B', detail: 'Next guests arrive 3:00 PM · 2 guests' }, organizationName: studio, taskUrl: inbox })) },
  { id: 'task-starting', audience: 'owner', title: 'Tasks — turnover starts today', whatsappTemplate: 'guest_thread_reply_whatsapp', message: ownerAlert(taskAlertMessage({ kind: 'starting', actorName: null, task: { eyebrow: '11:00 AM – 3:00 PM', title: '70 2B', detail: 'Next guests arrive 3:00 PM · 2 guests' }, organizationName: studio, taskUrl: inbox })) },
  // Owner alerts — both channels.
  { id: 'reservation-created', audience: 'owner', title: 'Owner — new table reservation', whatsappTemplate: 'new_reservation', message: ownerAlert(bookingCreatedMessage({ ...reservation, status: 'confirmed' })) },
  { id: 'reservation-cancelled', audience: 'owner', title: 'Owner — table reservation cancelled', whatsappTemplate: 'reservation_cancelled', message: ownerAlert(bookingCancelledMessage({ ...reservation, wasConfirmed: true })) },
  { id: 'booking-created', audience: 'owner', title: 'Owner — new experience booking request', whatsappTemplate: 'new_reservation', message: ownerAlert(bookingCreatedMessage({ ...booking, status: 'pending' })) },
  { id: 'booking-cancelled', audience: 'owner', title: 'Owner — booking cancelled', whatsappTemplate: 'reservation_cancelled', message: ownerAlert(bookingCancelledMessage({ ...booking, wasConfirmed: false })) },
  {
    id: 'stay-booked',
    audience: 'owner',
    title: 'Owner — new stay booked on the site',
    message: ownerAlert(stayBookedMessage(stayBooked)),
  },
  {
    id: 'stay-booked-member',
    audience: 'owner',
    title: 'Member looking after the home — new stay booked on the site',
    message: ownerAlert(stayBookedMessage(stayTurnoverAlert(stayBooked, stayPreviewUrl, 'Mina'))),
  },
  {
    id: 'channel-stay-booked',
    audience: 'owner',
    title: 'Owner — new Airbnb stay',
    message: ownerAlert(stayBookedMessage(airbnbBooked)),
  },
  {
    id: 'channel-stay-overlap',
    audience: 'owner',
    title: 'Owner — Airbnb stay landed on nights another stay holds',
    message: ownerAlert(stayBookedMessage({ ...airbnbBooked, overlap: true })),
  },
  {
    id: 'channel-stay-cancelled',
    audience: 'owner',
    title: 'Owner — Airbnb stay cancelled',
    message: ownerAlert(stayCancelledMessage({ ...airbnbStay, refund: null })),
  },
  {
    id: 'channel-stay-changed',
    audience: 'owner',
    title: 'Owner — Airbnb stay changed',
    whatsappTemplate: 'booking_change_update',
    message: ownerAlert(bookingChangeMessage({
      recordKind: 'stay', channel: 'Airbnb', guestName: 'Jamie Rivera', requestedBy: { kind: 'guest' }, status: 'changed', locationLabel: 'Home',
      current: { date: 'Fri, Nov 6, 2026 – Mon, Nov 9, 2026', time: null, nights: 3, partySize: '2 adults', location: 'Cedar Loft', total: '$1,284.00', assignee: null },
      requested: { date: 'Fri, Nov 6, 2026 – Tue, Nov 10, 2026', time: null, nights: 4, partySize: '2 adults', location: 'Cedar Loft', total: '$1,712.00', assignee: null },
      differences: stayChangeDifferences({ checkIn: '2026-11-06', checkOut: '2026-11-09', guests: 2, infants: 0, totalMinor: 128400 }, { checkIn: '2026-11-06', checkOut: '2026-11-10', guests: 2, infants: 0, totalMinor: 171200 }, minor => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`),
      counterpartyLabel: 'Guest', partyLabel: 'Guests',
      replyUrl: stayPreviewUrl, organizationName: 'Pinecone Stays',
    })),
  },
  {
    id: 'stay-cancelled',
    audience: 'owner',
    title: 'Owner — stay cancelled by its guest',
    message: ownerAlert(stayCancelledMessage(stayCancelled)),
  },
  {
    id: 'stay-cancelled-member',
    audience: 'owner',
    title: 'Member looking after the home — stay cancelled by its guest',
    message: ownerAlert(stayCancelledMessage(stayTurnoverAlert(stayCancelled, stayPreviewUrl, 'Mina'))),
  },
  {
    id: 'contact-received',
    audience: 'owner',
    title: 'Owner — new contact message',
    whatsappTemplate: 'new_contact_msg',
    message: ownerAlert(contactReceivedMessage({
      guestName: 'Jordan Lee', guestEmail: 'jordan@example.com', subject: 'General',
      message: 'Hi, do you have vegan options and parking nearby?',
      productTitle: 'Pottery Wheel Class', organizationName: restaurant, consentAcknowledged: true, replyUrl: inbox,
    })),
  },
  {
    id: 'guest-reply',
    audience: 'owner',
    title: 'Owner — guest replied',
    whatsappTemplate: 'guest_thread_reply_whatsapp',
    message: ownerAlert(messageReceived({
      sender: { kind: 'person', name: 'Jordan Lee', email: 'jordan@example.com' }, conversationLabel: 'Email reply', about: 'Main Dining Room',
      messagePreview: 'Thanks! One more thing — is the terrace covered if it rains?', body: 'Thanks! One more thing — is the terrace covered if it rains?', photos: [],
      history: [{ author: 'Jordan', text: 'Do you have a table for four on Friday at 7?' }, { author: restaurant, text: 'Yes, we have you down for 7pm on the terrace.' }],
      translation: null, record: null,
      organizationName: restaurant, replyUrl: inbox,
    })),
  },
  {
    id: 'guest-reply-web',
    audience: 'owner',
    title: 'Owner — guest replied in Messages',
    whatsappTemplate: 'guest_thread_reply_whatsapp',
    message: ownerAlert(messageReceived({
      sender: { kind: 'person', name: 'Jordan Lee', email: 'jordan@example.com' }, conversationLabel: 'Website reply', about: 'Main Dining Room',
      messagePreview: 'Thanks! See you tomorrow.', body: 'Thanks! See you tomorrow.', photos: [], history: [], translation: null, record: null,
      organizationName: restaurant, replyUrl: inbox,
    })),
  },
  {
    id: 'airbnb-inquiry',
    audience: 'owner',
    title: 'Owner — Airbnb guest asked about dates',
    whatsappTemplate: 'guest_thread_reply_whatsapp',
    message: ownerAlert(inquiryReceivedMessage({
      guestName: 'Derek', translation: null, photos: [],
      message: 'Hi! I’m interested in your property for a long-term stay beginning November 7. I’ll also be traveling with Sirius, my well-trained black Labrador Retriever.',
      record: { image: { imageUrl: sampleCover, alt: 'Cedar Loft' }, homeName: 'Cedar Loft', checkIn: '2026-11-07', checkOut: '2026-12-05', guests: '1 adult, 1 pet', replyBy: 'Nov 6, 8:13 AM MST' },
      organizationName: 'Pinecone Stays', replyUrl: stay.replyUrl,
    })),
  },
  {
    id: 'airbnb-message',
    audience: 'owner',
    title: 'Owner — Airbnb guest sent a message',
    whatsappTemplate: 'guest_thread_reply_whatsapp',
    message: ownerAlert(messageReceived({
      sender: { kind: 'person', name: 'Mililani', email: null }, conversationLabel: 'Airbnb message', about: 'Cedar Loft',
      messagePreview: 'La lavadora y secadora están compartidas ?', body: 'La lavadora y secadora están compartidas ?', translation: { by: 'Airbnb', text: 'Are the washing machine and dryer shared?' },
      photos: [{ imageUrl: sampleCover, alt: 'Photo from Mililani' }],
      history: [{ author: 'Mililani', text: 'Hola, llegamos el jueves.' }, { author: 'Pinecone Stays', text: 'Welcome! Check-in is from 4pm.' }],
      record: { image: { imageUrl: sampleCover, alt: 'Cedar Loft' }, homeName: 'Cedar Loft', checkIn: '2026-10-30', checkOut: '2026-11-20', guests: '2 adults', replyBy: null },
      organizationName: 'Pinecone Stays', replyUrl: stay.replyUrl,
    })),
  },
  {
    id: 'airbnb-support-message',
    audience: 'owner',
    title: 'Owner — Airbnb Support wrote about a case',
    whatsappTemplate: 'guest_thread_reply_whatsapp',
    message: ownerAlert(messageReceived({
      sender: { kind: 'support' }, conversationLabel: 'Airbnb message', about: 'Cedar Loft',
      messagePreview: 'This is a final decision. We’ve issued the refund, and I’m closing this thread for now if there’s nothing else.', body: 'This is a final decision. We’ve issued the refund, and I’m closing this thread for now if there’s nothing else.', photos: [], history: [], translation: null, record: null,
      organizationName: 'Pinecone Stays', replyUrl: stay.replyUrl,
    })),
  },
  {
    id: 'review-received',
    audience: 'owner',
    title: 'Owner — new review',
    whatsappTemplate: 'new_review',
    message: ownerAlert(reviewReceivedMessage({
      authorName: 'Alex Carter', rating: 5,
      content: 'The wood-fired pizza was outstanding and the team could not have been kinder.',
      organizationName: restaurant, reviewsUrl: `https://demo.krabiclaw.com${reviewEditorPath('ember-slice', 'review-ember-alex')}`,
    })),
  },
  {
    id: 'stay-change-request',
    audience: 'owner',
    title: 'Owner — Airbnb guest asked to change their stay',
    whatsappTemplate: 'booking_change_update',
    message: ownerAlert(bookingChangeMessage({
      recordKind: 'stay', channel: 'Airbnb', guestName: 'Jamie Rivera', requestedBy: { kind: 'guest' }, status: 'requested', locationLabel: 'Home',
      current: { date: 'Nov 15, 2026 – Feb 14, 2027', time: null, nights: 91, partySize: '1 adult', location: 'Cedar Loft', total: '$4,237.63', assignee: null },
      requested: { date: 'Nov 14, 2026 – Feb 14, 2027', time: null, nights: 92, partySize: '1 adult', location: 'Cedar Loft', total: '$4,283.64', assignee: null },
      differences: stayChangeDifferences({ checkIn: '2026-11-15', checkOut: '2027-02-14', guests: 1, infants: 0, totalMinor: 423763 }, { checkIn: '2026-11-14', checkOut: '2027-02-14', guests: 1, infants: 0, totalMinor: 428364 }, minor => `$${(minor / 100).toFixed(2)}`),
      counterpartyLabel: 'Guest', partyLabel: 'Guests',
      replyUrl: stay.replyUrl, organizationName: 'Pinecone Stays',
    })),
  },
  {
    id: 'booking-change',
    audience: 'owner',
    title: 'Owner — guest accepted a booking change',
    whatsappTemplate: 'booking_change_update',
    message: ownerAlert(bookingChangeMessage(((current, requested) => ({
      recordKind: 'booking', offering: 'Pottery Wheel Class', channel: null, guestName: 'Mina Park', requestedBy: { kind: 'business' as const, name: 'Priya Shah' }, status: 'accepted' as const,
      assigneeLabel: 'Host', current, requested,
      differences: occurrenceChangeDifferences(current, requested, { party: 'Party size', assignee: 'Host' }),
      replyUrl: inbox, organizationName: studio,
    }))(
      { date: 'Jul 21, 2026', time: '2:00 PM', nights: null, partySize: '2 guests', location: 'Main Studio', total: null, assignee: 'Priya Shah' },
      { date: 'Jul 22, 2026', time: '2:00 PM', nights: null, partySize: '3 guests', location: 'Main Studio', total: null, assignee: 'Sam Rivera' },
    ))),
  },
  {
    id: 'domain-update',
    audience: 'owner',
    title: 'Owner — custom domain updated',
    whatsappTemplate: 'domain_update',
    message: domainUpdateMessage({
      event: 'synced', domain: 'www.emberslice.com', status: 'active', error: null, records: [], apexNote: null,
      dashboardUrl: 'https://demo.krabiclaw.com/dashboard/ember-slice/website/domains',
    }),
  },
  {
    id: 'domain-added',
    audience: 'owner',
    title: 'Owner — custom domain needs DNS records',
    whatsappTemplate: 'domain_update',
    message: domainUpdateMessage({
      event: 'added', domain: 'www.emberslice.com', status: 'pending', error: null, apexNote: 'Forward emberslice.com to https://www.emberslice.com',
      records: [
        { type: 'TXT', name: '_cf-custom-hostname.www.emberslice.com', value: '6f1c2a9e-preview-ownership', purpose: 'ownership' },
        { type: 'CNAME', name: 'www', value: 'sites.krabiclaw.com', purpose: 'traffic' },
      ],
      dashboardUrl: 'https://demo.krabiclaw.com/dashboard/ember-slice/website/domains',
    }),
  },
  {
    id: 'domain-failed',
    audience: 'owner',
    title: 'Owner — custom domain could not be set up',
    whatsappTemplate: 'domain_update',
    message: domainUpdateMessage({
      event: 'synced', domain: 'www.emberslice.com', status: 'failed', apexNote: null,
      error: 'The CNAME record for www.emberslice.com points to another provider.',
      records: [{ type: 'CNAME', name: 'www', value: 'sites.krabiclaw.com', purpose: 'traffic' }],
      dashboardUrl: 'https://demo.krabiclaw.com/dashboard/ember-slice/website/domains',
    }),
  },

  {
    id: 'onboarding-completed',
    audience: 'owner',
    title: 'Operator — a business finished onboarding',
    message: onboardingCompletedMessage({
      organizationName: studio, ownerName: 'Priya Shah', ownerEmail: 'priya@example.com',
      siteUrl: 'https://pottery-house.krabiclaw.com/',
      viewCustomerUrl: 'https://krabiclaw.com/dashboard/krabiclaw/platform-accounts?user=preview-user&organization=preview-organization',
    }),
  },

  {
    id: 'owner-welcome-experience',
    audience: 'owner',
    title: 'Owner — founder welcome (Experience)',
    message: ownerWelcomeMessage({
      organizationName: studio,
      ownerName: 'Priya Shah',
      siteUrl: 'https://pottery-house.krabiclaw.com/',
      dashboardUrl: 'https://krabiclaw.com/dashboard/pottery-house',
      vertical: 'experience',
    }),
  },

  {
    id: 'owner-welcome-restaurant',
    audience: 'owner',
    title: 'Owner — founder welcome (Restaurant)',
    message: ownerWelcomeMessage({
      organizationName: 'The Olive Branch',
      ownerName: 'Marco Rossi',
      siteUrl: 'https://olive-branch.krabiclaw.com/',
      dashboardUrl: 'https://krabiclaw.com/dashboard/olive-branch',
      vertical: 'restaurant',
    }),
  },

  {
    id: 'owner-welcome-lodging',
    audience: 'owner',
    title: 'Owner — founder welcome (Lodging)',
    message: ownerWelcomeMessage({
      organizationName: 'Pinecone Stays',
      ownerName: 'Sarah Jenkins',
      siteUrl: 'https://pinecone-stays.krabiclaw.com/',
      dashboardUrl: 'https://krabiclaw.com/dashboard/pinecone-stays',
      vertical: 'lodging',
    }),
  },

  {
    id: 'owner-welcome-service',
    audience: 'owner',
    title: 'Owner — founder welcome (Legal Services)',
    message: ownerWelcomeMessage({
      organizationName: 'North Carolina Legal Services',
      ownerName: 'Robert Vance',
      siteUrl: 'https://nclegal.krabiclaw.com/',
      dashboardUrl: 'https://krabiclaw.com/dashboard/nclegal',
      vertical: 'service',
    }),
  },

  {
    id: 'content-reported',
    audience: 'owner',
    title: 'Operator — a member reported or blocked someone',
    message: contentReportedMessage({
      organizationName: 'Pinecone Stays', reporter: 'Priya Shah (priya@example.com)', subject: 'conversation', blocked: true,
      reason: 'Harassing messages', excerpt: 'You will regret this. I know where you live.',
      reviewUrl: 'https://krabiclaw.com/dashboard/krabiclaw/platform-reports',
    }),
  },

  // Guest and account mail — email only.
  { id: 'auth-verify', audience: 'guest', title: 'Sign-up — verify your email', message: verifyEmailMessage({ verificationUrl: 'https://krabiclaw.com/api/auth/verify-email?token=preview' }) },
  { id: 'auth-reset', audience: 'guest', title: 'Sign-in — reset your password', message: resetPasswordMessage({ resetUrl: 'https://krabiclaw.com/reset-password?token=preview' }) },
  { id: 'organization-invite', audience: 'guest', title: 'Invitee — organization invitation', message: organizationInviteMessage({ organizationName: studio, inviterName: 'Priya Shah', role: 'Admin', inviteUrl: 'https://demo.krabiclaw.com/accept-invitation/preview', expires: 'Nov 8, 2026, 2:00 PM UTC' }) },
  { id: 'guest-reservation-received', audience: 'guest', title: 'Guest — table reservation confirmed', message: guestBookingReceivedMessage({ ...guestVisit, productTitle: 'Main Dining Room table', status: 'confirmed', wording: 'reservation' }) },
  { id: 'guest-reservation-cancelled', audience: 'guest', title: 'Guest — table reservation cancelled', message: guestBookingCancelledMessage({ ...guestVisit, productTitle: 'Main Dining Room table', wasConfirmed: true, wording: 'reservation' }) },
  { id: 'guest-booking-received', audience: 'guest', title: 'Guest — booking request sent', message: guestBookingReceivedMessage({ ...guestVisit, guestName: 'Mina Park', organizationName: studio, productTitle: 'Pottery Wheel Class', date: 'Mon, Jul 20, 2026', time: '10:00 AM', status: 'pending', wording: 'booking' }) },
  { id: 'guest-stay-confirmed', audience: 'guest', title: 'Guest — stay confirmed', message: guestStayConfirmedMessage({ guestName: 'Mina Park', organizationName: 'Pinecone Stays', organizationLogoUrl: sampleLogo, homeName: 'Cedar Loft', heroImageUrl: sampleCover, checkIn: 'Fri, Nov 6, 2026 · from 15:00', checkOut: 'Mon, Nov 9, 2026 · by 11:00', nights: '3', guests: '2 adults', total: '$645.00', receiptUrl: 'https://demo.krabiclaw.com/bookings/stay?id=preview', checkInInstructions: 'The lockbox is to the left of the front door. Your code arrives the morning of check-in.', contactPhone: '+1 415 555 0100', contactEmail: 'hello@example.com' }) },
  { id: 'guest-booking-cancelled', audience: 'guest', title: 'Guest — booking cancelled', message: guestBookingCancelledMessage({ ...guestVisit, guestName: 'Mina Park', organizationName: studio, productTitle: 'Pottery Wheel Class', date: 'Mon, Jul 20, 2026', time: '10:00 AM', wasConfirmed: false, wording: 'booking' }) },
  { id: 'guest-contact-received', audience: 'guest', title: 'Guest — message sent', message: guestContactReceivedMessage({ guestName: 'Jordan Lee', organizationName: restaurant, organizationLogoUrl: sampleLogo, subject: 'General', productTitle: 'Pottery Wheel Class', message: 'Hi, do you have vegan options and parking nearby?', consentAcknowledged: true }) },
  { id: 'guest-thread-reply', audience: 'guest', title: 'Guest — a reply from the business', message: guestThreadReplyMessage({ organizationName: restaurant, organizationLogoUrl: sampleLogo, body: 'Hi Jordan,\n\nYes — we have a full vegan menu, and there is street parking on Soi 3 right outside. See you Tuesday!' }) },
  { id: 'guest-thread-status', audience: 'guest', title: 'Guest — reservation status changed', message: guestThreadStatusMessage({ organizationName: restaurant, organizationLogoUrl: sampleLogo, heading: `Your reservation at ${restaurant} is confirmed`, body: 'Your reservation is confirmed: Tue, Jul 14, 2026 at 7:00 PM for 2 guests.', actionUrl: guestVisit.receiptUrl, actionLabel: 'Manage your reservation' }) },
  { id: 'guest-booking-change-proposal', audience: 'guest', title: 'Guest — booking change proposed', message: bookingChangeProposalMessage({ guestName: 'Mina Park', organizationName: studio, organizationLogoUrl: sampleLogo, heading: 'Please review changes to your booking', intro: 'Your host has requested changes. Your booking stays exactly as it is until you accept, and the link below expires in 7 days.', rows: [['Location', 'Main Studio'], ['When', 'Tue, Jul 21, 2026 at 2:00 PM'], ['Guests', '2']], actionUrl: 'https://demo.krabiclaw.com/booking-changes/preview', actionLabel: 'Review the changes' }) },
  { id: 'guest-review-request', audience: 'guest', title: 'Guest — review request', message: reviewRequestMessage({ guestName: 'Alex Carter', organizationName: restaurant, locationName: 'Main Dining Room', visitAt: 'Tue, Jul 14, 2026 at 7:00 PM', partySize: '2 guests', reviewUrl: 'https://demo.krabiclaw.com/review-submit?token=preview', organizationLogoUrl: sampleLogo }) },
  { id: 'article-announcement', audience: 'owner', title: 'KrabiClaw news — new article', message: articleAnnouncementMessage({ title: 'Turning walk-ins into repeat guests', summary: 'Three things the best-performing KrabiClaw sites do after a guest leaves.', bodyMarkdown: '## Say thank you the same day\n\nA short note while the meal is still fresh brings guests back more often than any discount.\n\n## Ask for the review\n\n- Send the link once\n- Make it one tap\n\n## Invite them back\n\nTell them what is new next month, and [show them the menu](https://krabiclaw.com).', coverImageUrl: null, articleUrl: 'https://krabiclaw.com/blog/operations/preview' }) },
  ...ownerPayments.map((event) => {
    const message = ownerPaymentMessage({ ...event, action: event.action ?? payment.action })
    return { id: `owner-${event.kind}`, audience: 'owner' as const, title: `Owner — ${message.title}`, message }
  }),
  ...guestPayments.map(event => ({ id: `guest-${event.kind}`, audience: 'guest' as const, title: `Guest — ${guestPaymentMessage(event).title}`, message: guestPaymentMessage(event) })),
  ...([
    { kind: 'started', plan: 'Business', date: 'Nov 24, 2026' },
    { kind: 'changed', plan: 'Business', previousPlan: 'Growth' },
    { kind: 'ending', plan: 'Business', date: 'Dec 10, 2026' },
  ] as const).map((input) => {
    const message = ownerAlert(subscriptionPlanMessage({ ...input, organizationName: studio, action: { url: 'https://demo.krabiclaw.com/dashboard/pottery-house/billing', label: 'Open Plan and billing' } }))
    return { id: `owner-plan-${input.kind}`, audience: 'owner' as const, title: `Owner — ${message.title}`, message }
  }),
]
