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
}

export interface NotificationAction {
  url: string
  label: string
}

export interface NotificationMessage {
  /** The guest's selected website language; owner alerts keep their existing locale. */
  locale?: string
  /** The email subject and the H1. One sentence; the body never restates it. */
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
  sections?: NotificationSection[]
  /** Photos the message itself carries — a reply's attachments — shown whole, uncropped. Email only. */
  photos?: Array<{ imageUrl: string; alt: string }>
  primaryAction?: NotificationAction
  secondaryAction?: NotificationAction
  /** Shown small, under the actions — cancellation windows, link expiry. */
  finePrint?: string
  /** Whose preference governs delivery, and which unsubscribe link applies. */
  category: NotificationCategory
  /** The tenant this is sent on behalf of, for the footer. Null for platform mail. */
  organizationName?: string | null
  /** The tenant's logo URL, rendered in the header avatar stack alongside KrabiClaw. */
  organizationLogoUrl?: string | null
}

export function leadFacts(message: NotificationMessage): NotificationFact[] {
  return message.facts.filter(fact => fact.lead)
}
