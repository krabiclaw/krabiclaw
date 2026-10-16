import type { WhatsAppTemplate } from '~/server/utils/whatsapp'
import type { NotificationMessage } from './messages'

/**
 * How one message becomes the vars of an approved WhatsApp template.
 *
 * Meta templates are pre-approved with fixed positional slots, so this cannot
 * invent structure — it selects. Declaring the selection in one place is what
 * replaced two hand-written descriptions of the same event, which had drifted:
 * a cancelled reservation told WhatsApp neither the guest's email nor whether
 * the reservation had been confirmed, and a new review never named its author.
 */
export interface WhatsAppMapping {
  /** vars key → the `key` of the fact that fills it. */
  facts: Record<string, string>
  /** vars filled from the message rather than from a fact. */
  derive?: (_message: NotificationMessage) => Record<string, string>
  /**
   * The vars key that carries the message's primary action URL for the
   * template's URL button; the template takes the part its approved prefix
   * does not already supply, and a message without one cannot use it.
   */
  button?: { key: string }
  /**
   * Fact keys this approved template has no slot for, and why.
   *
   * Only non-lead facts may appear here — a lead fact that cannot reach
   * WhatsApp fails the build, because the whole point is that the important
   * information cannot quietly stay behind in the email. Emptying this list
   * means asking Meta to approve a template with more slots.
   */
  cannotCarry?: Record<string, string>
}

export const WHATSAPP_MAPPINGS: Partial<Record<WhatsAppTemplate, WhatsAppMapping>> = {
  new_reservation: {
    button: { key: 'reply_path' },
    facts: {
      guest_name: 'guestName',
      date: 'date',
      time: 'time',
      guests: 'partySize',
      phone: 'guestPhone',
      email: 'guestEmail',
      context: 'context',
      requests: 'notes',
    },
  },
  reservation_cancelled: {
    button: { key: 'reply_path' },
    facts: {
      guest_name: 'guestName',
      date: 'date',
      time: 'time',
      guests: 'partySize',
      phone: 'guestPhone',
      context: 'context',
      requests: 'notes',
    },
    cannotCarry: {
      // The approved template has seven body slots and none for an address.
      // `context` already carries the venue and whether it was confirmed, which
      // is what decides how urgently an owner acts.
      guestEmail: 'reservation_cancelled has no email slot; the guest address is in the email only',
    },
  },
  new_contact_msg: {
    button: { key: 'reply_path' },
    facts: {
      guest_name: 'guestName',
      email: 'guestEmail',
      subject: 'subject',
      message_preview: 'message',
    },
    cannotCarry: {
      // Four body slots, all spoken for. Whether the guest ticked the privacy
      // notice is a record-keeping detail, not something an owner acts on from
      // their phone, so it stays in the email.
      consent: 'new_contact_msg has four body slots and none spare',
    },
  },
  guest_thread_reply_whatsapp: {
    button: { key: 'reply_path' },
    facts: {
      guest_name: 'guestName',
      email: 'guestEmail',
      subject: 'subject',
      message_preview: 'message',
    },
  },
  new_review: {
    button: { key: 'reviews_url' },
    facts: {
      rating: 'rating',
      excerpt: 'review',
    },
    derive: (message): Record<string, string> => (message.organizationName ? { organization_name: message.organizationName } : {}),
  },
  booking_change_update: {
    button: { key: 'reply_path' },
    facts: {
      booking_type: 'recordKind',
      guest_name: 'guestName',
      status: 'status',
      location: 'location',
      date: 'date',
      time: 'time',
      guests: 'partySize',
      message: 'summary',
    },
    cannotCarry: {
      // The combined label is the email's reading of the date and time slots;
      // the template carries those slots, or for a proposal that has only the
      // label, the variant without them.
      when: 'booking_change_update has date and time slots, not a combined label',
    },
  },
  domain_update: {
    button: { key: 'dashboard_url' },
    facts: {
      domain: 'domain',
      status: 'status',
    },
    cannotCarry: {
      headline: 'domain_update has a domain slot and a status slot and nothing else',
    },
  },
}

export interface WhatsAppMappingResult {
  vars: Record<string, string>
  /** Fact keys the template could not carry, for logging and for the guard. */
  omitted: string[]
}

/**
 * The same facts the email shows, in the slots the approved template offers.
 *
 * Facts are ordered by importance in the message, and this reads them by key,
 * so adding one to the email either lands in a slot or shows up here as
 * omitted — never as a silent difference between the two channels.
 */
export function toWhatsAppVars(
  message: NotificationMessage,
  template: WhatsAppTemplate,
  extra: Record<string, string> = {},
): WhatsAppMappingResult {
  const mapping = WHATSAPP_MAPPINGS[template]
  if (!mapping) throw new Error(`No WhatsApp mapping declared for ${template}`)

  const byKey = new Map(message.facts.map(fact => [fact.key, fact]))
  const vars: Record<string, string> = { ...mapping.derive?.(message), ...extra }

  const actionUrl = message.primaryAction?.url
  if (mapping.button && actionUrl && vars[mapping.button.key] === undefined) vars[mapping.button.key] = actionUrl

  for (const [varsKey, factKey] of Object.entries(mapping.facts)) {
    const fact = byKey.get(factKey)
    if (fact) vars[varsKey] = fact.value
  }

  const carried = new Set(Object.values(mapping.facts))
  const omitted = message.facts.filter(fact => !carried.has(fact.key)).map(fact => fact.key)
  return { vars, omitted }
}
