#!/usr/bin/env node
// Every fact the email leads with must reach WhatsApp.
//
// Each event used to be written twice — once as email props, once as WhatsApp
// vars — and the two drifted without anyone noticing: a cancelled reservation
// told WhatsApp neither the guest's email nor whether it had been confirmed,
// and a new review never named its author. This is what stops that happening
// again: a `lead` fact with nowhere to go is a build failure, and a non-lead
// fact a template genuinely cannot carry has to be declared in `cannotCarry`
// with a reason.

import { WHATSAPP_MAPPINGS, toWhatsAppVars } from '~/server/notifications/whatsapp-mapping'
import { buildWhatsAppTemplatePayload, WhatsAppTemplateRefusal, type WhatsAppTemplate } from '~/server/utils/whatsapp'
import { NOTIFICATION_CATALOG } from '~/server/notifications/catalog'
import type { NotificationMessage } from '~/server/notifications/messages'

/**
 * Words a slot must never render. Each is the name of the thing the slot is
 * for, which is what a guest saw when a template fell back to its own
 * placeholder instead of the real value.
 */
const FIELD_NAME_PLACEHOLDERS = new Set(['date', 'time', 'location', 'guest', 'email', 'phone', 'status', 'subject', 'rating'])

const failures: string[] = []

const dualChannel = NOTIFICATION_CATALOG.filter(entry => entry.whatsappTemplate)

for (const entry of dualChannel) {
  const template = entry.whatsappTemplate!
  const message = entry.message
  const mapping = WHATSAPP_MAPPINGS[template as WhatsAppTemplate]
  if (!mapping) {
    failures.push(`${template}: no WhatsApp mapping declared`)
    continue
  }

  const { omitted } = toWhatsAppVars(message, template as WhatsAppTemplate)

  for (const key of omitted) {
    const fact = message.facts.find(entry => entry.key === key)!
    if (fact.lead) {
      failures.push(`${template}: lead fact "${key}" (${fact.label}) reaches the email but not WhatsApp`)
    } else if (!mapping.cannotCarry?.[key]) {
      failures.push(`${template}: fact "${key}" is unmapped and undeclared — map it or record why the template cannot carry it in cannotCarry`)
    }
  }

  // A declared shortfall that no longer exists is stale documentation, and one
  // that is now mapped is worse: it leaves an exemption standing that would
  // hide the fact going missing again later.
  for (const key of Object.keys(mapping.cannotCarry ?? {})) {
    if (!message.facts.some(entry => entry.key === key)) {
      failures.push(`${template}: cannotCarry names "${key}", which this message no longer has`)
    } else if (!omitted.includes(key)) {
      failures.push(`${template}: cannotCarry names "${key}", but the template now carries it — drop the exemption`)
    }
  }

  // The slots must actually fill, with the event's own facts. Checked twice —
  // once with the sample as written (which may itself lack optional facts, as
  // the booking sample has no notes), and once with every optional fact
  // removed. Real data is full of nulls (a reservation with no phone), and no
  // slot is ever filled with stand-in text for one: an absent optional fact
  // selects the template variant without that slot. A variant Meta has not
  // approved yet is refused at send, which is expected here; a slot that cannot
  // fill because its fact is absent and not declared optional is a failure.
  const stripped: NotificationMessage = { ...message, facts: message.facts.filter(entry => entry.lead) }
  for (const [label, candidate] of [['as sampled', message], ['with optional facts removed', stripped]] as const) {
    let payload: ReturnType<typeof buildWhatsAppTemplatePayload>
    try {
      payload = buildWhatsAppTemplatePayload(template as WhatsAppTemplate, toWhatsAppVars(candidate, template as WhatsAppTemplate).vars)
    } catch (error) {
      if (!(error instanceof WhatsAppTemplateRefusal)) throw error
      if (error.code !== 'WHATSAPP_TEMPLATE_NOT_APPROVED') failures.push(`${template} (${label}): ${error.message}`)
      continue
    }
    for (const component of payload.components) {
      component.parameters.forEach((parameter, index) => {
        if (FIELD_NAME_PLACEHOLDERS.has(parameter.text.trim().toLowerCase())) {
          failures.push(`${template} (${label}): ${component.type} slot ${index + 1} renders "${parameter.text}" — a field name, not a value`)
        }
      })
    }
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

console.log(`Notification parity passed: ${dualChannel.length} dual-channel events, every lead fact reaches both channels`)
