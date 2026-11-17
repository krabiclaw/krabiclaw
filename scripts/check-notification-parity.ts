#!/usr/bin/env node
// Runs every dual-channel catalog message through the real WhatsApp send path:
// the mapping refuses a fact the template cannot carry, and the payload refuses
// a missing slot. Each is rendered as sampled and with optional facts removed,
// because real data is full of nulls.

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

  // A declared exemption the template now carries would hide the fact going
  // missing again later.
  for (const key of Object.keys(mapping.cannotCarry ?? {})) {
    if (Object.values(mapping.facts).includes(key)) {
      failures.push(`${template}: cannotCarry names "${key}", but the template carries it — drop the exemption`)
    }
  }

  // A variant Meta has not approved yet is refused at send, which is expected
  // here; any other refusal is a failure.
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

// A declared shortfall no event sharing the template has any more is stale
// documentation. One event may lack a row another has — a stay has nights, a
// class booking an assignee — so this reads the template's events together.
for (const [template, mapping] of Object.entries(WHATSAPP_MAPPINGS)) {
  const keys = new Set(dualChannel.filter(entry => entry.whatsappTemplate === template).flatMap(entry => entry.message.facts.map(fact => fact.key)))
  for (const key of Object.keys(mapping.cannotCarry ?? {})) {
    if (!keys.has(key)) failures.push(`${template}: cannotCarry names "${key}", which no ${template} event has any more`)
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure)
  process.exit(1)
}

console.log(`Notification parity passed: ${dualChannel.length} dual-channel events, every lead fact reaches both channels`)
