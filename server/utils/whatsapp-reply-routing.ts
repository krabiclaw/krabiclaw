export interface DisambiguationCandidate {
  threadId: string
  organizationId: string
  locationId: string | null
  label: string
}

export type PendingWhatsAppReplyState =
  | {
      kind: 'confirm_send'
      threadId: string
      organizationId: string
      locationId: string | null
      replyBody: string
      guestEmailMasked: string
    }
  | {
      kind: 'disambiguate'
      candidates: DisambiguationCandidate[]
    }
  | {
      kind: 'collect_reply'
      threadId: string
      organizationId: string
      locationId: string | null
      guestEmailMasked: string
    }

export interface RoutingDecisionInput {
  /** message.context?.id was present on the inbound message. */
  hasQuotedContext: boolean
  quotedDeliveryMatch: 'authorized_thread_found' | 'unmatched' | null
  /** Existing multi-turn state for this user's whatsapp channel, if any. */
  pendingState: PendingWhatsAppReplyState | null
  recentDeliveryCount: number
  /** Raw trimmed inbound message text. */
  text: string
}

export type RoutingDecision =
  // Fresh dispatch (no pending state), tiers 1-3:
  | { action: 'start_confirm_send' }
  | { action: 'start_disambiguation' }
  | { action: 'prompt_quote_notification' }
  // Resuming a pending confirm_send:
  | { action: 'confirm_send_execute' }
  | { action: 'confirm_send_cancel_and_redispatch' }
  // Resuming a pending disambiguate:
  | { action: 'disambiguation_pick'; index: number }
  | { action: 'disambiguation_cancel_and_redispatch' }
  // Resuming a pending collect_reply — any text becomes the reply body:
  | { action: 'collect_reply_body' }

const AFFIRMATIVE_PHRASES = new Set([
  'yes', 'y', 'yep', 'yeah', 'yup', 'confirm', 'confirmed', 'send', 'send it', 'ok', 'okay',
  'sure', 'go', 'go ahead', 'yes send', 'yes confirm', 'yes confirmed', 'yes please',
  'confirm send', 'send yes', 'ok send', 'ok confirm',
])

/**
 * Bounded affirmative matcher for the "reply YES to send" confirmation step. The FULL
 * normalized message must exactly match a known affirmative phrase — not just its first
 * word — so contradictory replies like "yes but change the date to Friday instead", "yes
 * no", or "sure don't" are never treated as confirmation. This intentionally does not try
 * to be a general sentiment classifier; it only needs to recognize the manager confirming
 * the exact prompt this flow just sent them.
 */
export function isAffirmativeReply(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  return AFFIRMATIVE_PHRASES.has(normalized)
}

/**
 * Parses a 1-based numeric selection against a candidate list, e.g. for picking one of
 * up to 5 disambiguation options. Returns null for anything that isn't a bare in-range
 * integer — out-of-range or non-numeric text is never guessed at, per issue #293's "never
 * silently route ambiguous text" rule.
 */
export function parseNumericSelection(text: string, candidateCount: number): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number(trimmed)
  if (n < 1 || n > candidateCount) return null
  return n
}

/**
 * Masked email for the manager-facing pre-send disclosure (issue #293: "identify the
 * destination address in masked form"). Deliberately local to this file rather than
 * reusing utils/phone.ts's formatForDisplay, which masks phone numbers, not emails.
 */
export function maskEmailForDisplay(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return email
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  return `${local.slice(0, 1)}***@${domain}`
}

export function buildDisambiguationPrompt(candidates: DisambiguationCandidate[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.label}`)
  return [
    'Reply to which?',
    ...lines,
    'Reply with a number to select, or quote a notification to reply directly.',
  ].join('\n')
}

export function buildConfirmSendPrompt(guestEmailMasked: string): string {
  return `This reply will be emailed to ${guestEmailMasked}. Reply YES to send.`
}

export const REPLY_SENT_CONFIRMATION = 'Reply sent by email.'

export function buildReplyFailedMessage(error: string): string {
  return `Reply failed to send by email: ${error}`
}

export const PROMPT_QUOTE_NOTIFICATION_MESSAGE =
  'To reply to a guest, please quote their notification message. To manage your site, please open your KrabiClaw dashboard.'

export function buildCollectReplyPrompt(guestEmailMasked: string): string {
  return `Type your reply now — it will be emailed to ${guestEmailMasked}.`
}

/**
 * The pure three-tier + pending-state decision tree. All I/O (notification/thread
 * lookups, authorization, sends, state persistence) happens in the caller; this
 * function only decides *what should happen* given the resolved inputs.
 */
export function decideWhatsAppReplyRouting(input: RoutingDecisionInput): RoutingDecision {
  const { pendingState, text } = input

  if (pendingState) {
    if (pendingState.kind === 'confirm_send') {
      return isAffirmativeReply(text)
        ? { action: 'confirm_send_execute' }
        : { action: 'confirm_send_cancel_and_redispatch' }
    }
    if (pendingState.kind === 'disambiguate') {
      const index = parseNumericSelection(text, pendingState.candidates.length)
      return index !== null
        ? { action: 'disambiguation_pick', index }
        : { action: 'disambiguation_cancel_and_redispatch' }
    }
    // collect_reply: any non-empty text becomes the reply body and moves to confirm_send.
    return { action: 'collect_reply_body' }
  }

  if (input.hasQuotedContext && input.quotedDeliveryMatch === 'authorized_thread_found') {
    return { action: 'start_confirm_send' }
  }

  if (input.recentDeliveryCount > 0) {
    return { action: 'start_disambiguation' }
  }

  return { action: 'prompt_quote_notification' }
}
