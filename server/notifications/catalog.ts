import type { WhatsAppTemplate } from '~/server/utils/whatsapp'
import { reviewEditorPath } from '~/server/utils/dashboard-links'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type { NotificationMessage } from './messages'
import { guestPaymentMessage, ownerPaymentMessage } from './payment-events'
import type { GuestPaymentNotificationEvent, PaymentNotificationEvent } from './payment-events'
import {
  bookingCancelledMessage,
  calendarSyncMessage,
  bookingChangeMessage,
  bookingCreatedMessage,
  contactReceivedMessage,
  stayBookedMessage,
  stayCancelledMessage,
  stayTurnoverAlert,
  domainUpdateMessage,
  onboardingCompletedMessage,
  contentReportedMessage,
  guestReplyMessage,
  teamMessage,
  reservationCancelledMessage,
  reservationCreatedMessage,
  reviewReceivedMessage,
} from './events'
import {
  articleAnnouncementMessage,
  bookingChangeProposalMessage,
  guestBookingCancelledMessage,
  guestBookingReceivedMessage,
  guestContactReceivedMessage,
  guestReservationCancelledMessage,
  guestReservationReceivedMessage,
  guestStayConfirmedMessage,
  guestThreadReplyMessage,
  guestThreadStatusMessage,
  organizationInviteMessage,
  resetPasswordMessage,
  reviewRequestMessage,
  signInCodeMessage,
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

const reservation = {
  guestName: 'Alex Carter',
  guestEmail: 'alex@example.com',
  guestPhone: '+1 555 123 4567',
  date: 'Tue, Jul 14, 2026',
  time: '7:00 PM',
  partySize: '2 guests',
  locationName: 'Main Dining Room',
  organizationName: restaurant,
  notes: 'Window seat, celebrating an anniversary.',
  heroImageUrl: null,
  replyUrl: inbox,
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
  checkIn: 'Fri, Nov 6, 2026 · from 15:00', checkOut: 'Mon, Nov 9, 2026 · by 11:00', arrival: '6:00 PM', nights: '3', guests: '2 adults',
  organizationName: 'Pinecone Stays', heroImageUrl: null, replyUrl: 'https://demo.krabiclaw.com/dashboard/pinecone-stays/messages/preview-1',
}
const stayBooked = { ...stay, total: '$645.00', notes: 'We will bring our dog if that is fine.' }
const stayCancelled = { ...stay, refund: '$322.50' }
// A member looking after the home opens the stay itself.
const stayPreviewUrl = 'https://demo.krabiclaw.com/dashboard/pinecone-stays/bookings/stay/preview-1'

const booking = {
  ...reservation,
  heroImageUrl: sampleCover,
  organizationLogoUrl: sampleLogo,
  guestName: 'Mina Park',
  guestEmail: 'mina@example.com',
  guestPhone: '+66 76 000 0002',
  organizationName: studio,
  productTitle: 'Pottery Wheel Class',
  presentation: resolveBookingPresentation('booking', 'experience'),
  date: 'Mon, Jul 20, 2026',
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
  receiptUrl: 'https://demo.krabiclaw.com/reservations/confirmed?id=preview',
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
  { id: 'team-message', audience: 'owner', title: 'Team — new message', whatsappTemplate: 'guest_thread_reply_whatsapp', message: ownerAlert(teamMessage({ senderName: 'Alex Carter', preview: 'The home is ready for check-in.', organizationName: studio, replyUrl: inbox })) },
  // Owner alerts — both channels.
  { id: 'reservation-created', audience: 'owner', title: 'Owner — new reservation', whatsappTemplate: 'new_reservation', message: ownerAlert(reservationCreatedMessage(reservation)) },
  { id: 'reservation-cancelled', audience: 'owner', title: 'Owner — reservation cancelled', whatsappTemplate: 'reservation_cancelled', message: ownerAlert(reservationCancelledMessage({ ...reservation, wasConfirmed: true })) },
  { id: 'booking-created', audience: 'owner', title: 'Owner — new experience booking', whatsappTemplate: 'new_reservation', message: ownerAlert(bookingCreatedMessage(booking)) },
  { id: 'booking-cancelled', audience: 'owner', title: 'Owner — booking cancelled', whatsappTemplate: 'reservation_cancelled', message: ownerAlert(bookingCancelledMessage({ ...booking, wasConfirmed: false })) },
  { id: 'calendar-event-deleted', audience: 'owner', title: 'Owner — booking event deleted in Google Calendar', message: ownerAlert(calendarSyncMessage({ kind: 'event_deleted', recordKind: 'consultation', guestName: 'Mina Park', whenLabel: 'Mon, Jul 20, 2026, 10:00 AM', reason: null, replyUrl: 'https://demo.krabiclaw.com/dashboard/demo/bookings/booking/preview-1', organizationName: studio })) },
  { id: 'calendar-move-refused', audience: 'owner', title: 'Owner — booking could not follow its Google Calendar event', message: ownerAlert(calendarSyncMessage({ kind: 'move_refused', recordKind: 'consultation', guestName: 'Mina Park', whenLabel: 'Mon, Jul 20, 2026, 10:00 AM', reason: 'That time is outside Elena’s working hours', replyUrl: 'https://demo.krabiclaw.com/dashboard/demo/bookings/booking/preview-1', organizationName: studio })) },
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
    message: ownerAlert(stayBookedMessage(stayTurnoverAlert(stayBooked, stayPreviewUrl))),
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
    message: ownerAlert(stayCancelledMessage(stayTurnoverAlert(stayCancelled, stayPreviewUrl))),
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
    message: ownerAlert(guestReplyMessage({
      guestName: 'Jordan Lee', guestEmail: 'jordan@example.com', inboundChannel: 'email',
      messagePreview: 'Thanks! One more thing — is the terrace covered if it rains?',
      organizationName: restaurant, replyUrl: inbox,
    })),
  },
  {
    id: 'guest-reply-web',
    audience: 'owner',
    title: 'Owner — guest replied in Messages',
    whatsappTemplate: 'guest_thread_reply_whatsapp',
    message: ownerAlert(guestReplyMessage({
      guestName: 'Jordan Lee', guestEmail: 'jordan@example.com', inboundChannel: 'web',
      messagePreview: 'Thanks! See you tomorrow.',
      organizationName: restaurant, replyUrl: inbox,
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
    id: 'booking-change',
    audience: 'owner',
    title: 'Owner — booking change decided',
    whatsappTemplate: 'booking_change_update',
    message: ownerAlert(bookingChangeMessage({
      recordKind: 'booking', guestName: 'Mina Park', status: 'accepted', location: 'Main Studio',
      date: 'Jul 21, 2026', time: '2:00 PM', whenLabel: 'Tue, Jul 21, 2026 at 2:00 PM',
      partySize: '2 guests', summary: 'The guest accepted. The updated details are now confirmed.',
      assignment: { beforeMemberId: 'previous-preview-member', beforeName: 'Priya Shah', afterMemberId: 'next-preview-member', afterName: 'Sam Rivera', label: 'Host' },
      replyUrl: inbox, organizationName: studio,
    })),
  },
  {
    id: 'domain-update',
    audience: 'owner',
    title: 'Owner — custom domain updated',
    whatsappTemplate: 'domain_update',
    message: domainUpdateMessage({
      headline: 'emberslice.com is live', message: 'Your custom domain is verified and serving traffic.',
      domain: 'emberslice.com', status: 'active',
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
    id: 'content-reported',
    audience: 'owner',
    title: 'Operator — a member reported or blocked someone',
    message: contentReportedMessage({
      organizationName: 'Pinecone Stays', reporter: 'Priya Shah (priya@example.com)', subject: 'guest_thread', blocked: true,
      reason: 'Harassing messages', excerpt: 'You will regret this. I know where you live.',
      reviewUrl: 'https://krabiclaw.com/dashboard/krabiclaw/platform-reports',
    }),
  },

  // Guest and account mail — email only.
  { id: 'auth-verify', audience: 'guest', title: 'Sign-up — verify your email', message: verifyEmailMessage({ verificationUrl: 'https://krabiclaw.com/api/auth/verify-email?token=preview' }) },
  { id: 'auth-sign-in-code', audience: 'guest', title: 'Sign-in — email code', message: signInCodeMessage({ code: '482913' }) },
  { id: 'auth-reset', audience: 'guest', title: 'Sign-in — reset your password', message: resetPasswordMessage({ resetUrl: 'https://krabiclaw.com/reset-password?token=preview' }) },
  { id: 'organization-invite', audience: 'guest', title: 'Invitee — organization invitation', message: organizationInviteMessage({ organizationName: studio, inviterName: 'Priya Shah', role: 'Admin', inviteUrl: 'https://demo.krabiclaw.com/accept-invitation/preview' }) },
  { id: 'guest-reservation-received', audience: 'guest', title: 'Guest — reservation confirmed', message: guestReservationReceivedMessage(guestVisit) },
  { id: 'guest-reservation-cancelled', audience: 'guest', title: 'Guest — reservation cancelled', message: guestReservationCancelledMessage({ ...guestVisit, wasConfirmed: true }) },
  { id: 'guest-booking-received', audience: 'guest', title: 'Guest — booking request sent', message: guestBookingReceivedMessage({ ...guestVisit, guestName: 'Mina Park', organizationName: studio, productTitle: 'Pottery Wheel Class', date: 'Mon, Jul 20, 2026', time: '10:00 AM' }) },
  { id: 'guest-stay-confirmed', audience: 'guest', title: 'Guest — stay confirmed', message: guestStayConfirmedMessage({ guestName: 'Mina Park', organizationName: 'Pinecone Stays', organizationLogoUrl: sampleLogo, homeName: 'Cedar Loft', heroImageUrl: sampleCover, checkIn: 'Fri, Nov 6, 2026 · from 15:00', checkOut: 'Mon, Nov 9, 2026 · by 11:00', nights: '3', guests: '2 adults', total: '$645.00', receiptUrl: 'https://demo.krabiclaw.com/bookings/stay?id=preview', checkInInstructions: 'The lockbox is to the left of the front door. Your code arrives the morning of check-in.', contactPhone: '+1 415 555 0100', contactEmail: 'hello@example.com' }) },
  { id: 'guest-booking-cancelled', audience: 'guest', title: 'Guest — booking cancelled', message: guestBookingCancelledMessage({ ...guestVisit, guestName: 'Mina Park', organizationName: studio, productTitle: 'Pottery Wheel Class', date: 'Mon, Jul 20, 2026', time: '10:00 AM', wasConfirmed: false }) },
  { id: 'guest-contact-received', audience: 'guest', title: 'Guest — message sent', message: guestContactReceivedMessage({ guestName: 'Jordan Lee', organizationName: restaurant, organizationLogoUrl: sampleLogo, subject: 'General', productTitle: 'Pottery Wheel Class', message: 'Hi, do you have vegan options and parking nearby?', consentAcknowledged: true }) },
  { id: 'guest-thread-reply', audience: 'guest', title: 'Guest — a reply from the business', message: guestThreadReplyMessage({ organizationName: restaurant, organizationLogoUrl: sampleLogo, body: 'Hi Jordan,\n\nYes — we have a full vegan menu, and there is street parking on Soi 3 right outside. See you Tuesday!' }) },
  { id: 'guest-thread-status', audience: 'guest', title: 'Guest — reservation status changed', message: guestThreadStatusMessage({ organizationName: restaurant, organizationLogoUrl: sampleLogo, heading: `Your reservation at ${restaurant} is confirmed`, body: 'Your reservation is confirmed: Tue, Jul 14, 2026 at 7:00 PM for 2 guests.', actionUrl: guestVisit.receiptUrl, actionLabel: 'Manage your reservation' }) },
  { id: 'guest-booking-change-proposal', audience: 'guest', title: 'Guest — booking change proposed', message: bookingChangeProposalMessage({ guestName: 'Mina Park', organizationName: studio, organizationLogoUrl: sampleLogo, heading: 'Please review changes to your booking', intro: 'Your host has requested changes. Your booking stays exactly as it is until you accept, and the link below expires in 7 days.', rows: [['Location', 'Main Studio'], ['When', 'Tue, Jul 21, 2026 at 2:00 PM'], ['Guests', '2']], actionUrl: 'https://demo.krabiclaw.com/booking-changes/preview', actionLabel: 'Review the changes' }) },
  { id: 'guest-review-request', audience: 'guest', title: 'Guest — review request', message: reviewRequestMessage({ guestName: 'Alex Carter', organizationName: restaurant, locationName: 'Main Dining Room', visitAt: 'Tue, Jul 14, 2026 at 7:00 PM', partySize: '2 guests', reviewUrl: 'https://demo.krabiclaw.com/review-submit?token=preview', organizationLogoUrl: sampleLogo }) },
  { id: 'article-announcement', audience: 'owner', title: 'KrabiClaw news — new article', message: articleAnnouncementMessage({ title: 'Turning walk-ins into repeat guests', summary: 'Three things the best-performing KrabiClaw sites do after a guest leaves.', bodyMarkdown: '## Say thank you the same day\n\nA short note while the meal is still fresh brings guests back more often than any discount.\n\n## Ask for the review\n\n- Send the link once\n- Make it one tap\n\n## Invite them back\n\nTell them what is new next month, and [show them the menu](https://krabiclaw.com).', coverImageUrl: null, articleUrl: 'https://krabiclaw.com/blog/operations/preview' }) },
  ...ownerPayments.map(event => ({ id: `owner-${event.kind}`, audience: 'owner' as const, title: `Owner — ${ownerPaymentMessage(event).title}`, message: ownerPaymentMessage(event) })),
  ...guestPayments.map(event => ({ id: `guest-${event.kind}`, audience: 'guest' as const, title: `Guest — ${guestPaymentMessage(event).title}`, message: guestPaymentMessage(event) })),
]
