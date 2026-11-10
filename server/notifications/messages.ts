import type { NotificationCategory } from '~/shared/notification-categories'

/**
 * One notification, described once, rendered to email and to WhatsApp.
 *
 * Before this, every event was written twice — as email template props and as a
 * hand-written `vars` object for the approved WhatsApp template — and the two
 * drifted: a cancelled reservation told WhatsApp neither the guest's email nor
 * whether the reservation had been confirmed, and a new review never named its
 * author. Neither renderer invents content; both read this.
 */
export interface NotificationFact {
  /**
   * A stable identity for the fact, independent of its display label. The
   * WhatsApp mapping keys off this, so translating a label cannot silently
   * unmap a slot.
   */
  key: string
  label: string
  value: string
  /**
   * Facts are ordered by importance, because WhatsApp has fixed, pre-approved
   * slots and takes what fits, in order. `lead` marks the ones a message is
   * useless without — the build fails if one cannot reach WhatsApp.
   */
  lead?: boolean
}

export interface NotificationSection {
  title: string
  body?: string
  facts?: NotificationFact[]
  /** The picture the section is about — the home a reservation's details describe — shown above its title. */
  image?: { imageUrl: string; alt: string } | null
}

/** Someone's own words, the thing the email is about. */
export interface NotificationQuote {
  /** Who wrote them, as the reader knows them: a first name, a business, or "Airbnb Support". */
  author: string
  /** The words as written; empty when the message is only photos. */
  body: string
  /** The channel's translation into the reader's language, when it made one, and the channel that made it. */
  translation: { by: string; text: string } | null
  /** Photos the message carries, shown whole, uncropped. */
  photos: Array<{ imageUrl: string; alt: string }>
}

/** Earlier messages of a conversation, shown quietly under the new one: who wrote, and what. */
export type NotificationHistory = Array<{ author: string; text: string }>

export interface NotificationAction {
  url: string
  label: string
}

export type NotificationEmailPurpose = 'transactional' | 'subscribed' | 'promotional'

export interface NotificationMessage {
  /** Message purpose is independent of the recipient's channel preferences. */
  emailPurpose: NotificationEmailPurpose
  /** The actual event or relationship that explains why this email was sent. */
  emailReason: string
  /** The guest's selected website language; owner alerts keep their existing locale. */
  locale?: string
  /** The event headline and initial subject; replies retain the email conversation's subject. */
  title: string
  /** The line a client shows beside the subject. */
  preheader: string
  /**
   * Leads the email where the subject has a picture. Null renders nothing —
   * never a placeholder, because invented imagery on a tenant's mail is the
   * client-site integrity rule, not a styling choice. WhatsApp ignores it: no
   * approved template declares a media header.
   */
  hero: { imageUrl: string; alt: string } | null
  /** An optional sentence under the title, where one genuinely adds something. */
  intro?: string
  /** Markdown read in full under the intro — an article's own text. Email only. */
  body?: string
  facts: NotificationFact[]
  /**
   * The message the email is about, as a card in place of the fact grid. Email
   * only: the facts still carry the same words to WhatsApp and the in-app
   * notification.
   */
  quote?: NotificationQuote
  /** The conversation's last messages before the quoted one, oldest first, as context. Email only. */
  history?: NotificationHistory
  sections?: NotificationSection[]
  primaryAction?: NotificationAction
  secondaryAction?: NotificationAction
  /** Shown small, under the actions — cancellation windows, link expiry, where a reply goes. */
  finePrint?: string
  /** Which notification preference governs delivery, independently of email purpose. */
  category: NotificationCategory
  /** The tenant this is sent on behalf of, for the footer. Null for platform mail. */
  organizationName?: string | null
  /** The tenant's logo URL, rendered in the header avatar stack alongside KrabiClaw. */
  organizationLogoUrl?: string | null
}

/**
 * An alert to a member of the business. It always opens the thing it is
 * about: the email's button, WhatsApp's button and a push all go to this one
 * destination, and an alert that cannot name it is not sent.
 */
export type MemberAlertMessage = NotificationMessage & { primaryAction: NotificationAction }

export function leadFacts(message: NotificationMessage): NotificationFact[] {
  return message.facts.filter(fact => fact.lead)
}
