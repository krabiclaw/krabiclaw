import { defineHandler } from 'nitro'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { recordUsageEvent } from '~/server/utils/usage-metering'

export interface DashboardTelemetryInput {
  action: 'today_view' | 'today_range_switch' | 'today_card_click' | 'today_filter_change'
  surface?: string
  range?: string
  cardId?: string
  cardPriority?: string
  cardKind?: string
  targetPath?: string
  locationId?: string
  metadata?: Record<string, unknown>
}

const ALLOWED_ACTIONS = new Set([
  'today_view',
  'today_range_switch',
  'today_card_click',
  'today_filter_change',
])

export function validateTelemetryInput(input: unknown): DashboardTelemetryInput | null {
  let parsed = input
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || !ALLOWED_ACTIONS.has((parsed as Record<string, unknown>).action as string)) {
    return null
  }
  return parsed as DashboardTelemetryInput
}

export default defineHandler(async (event) => {
  const { db, organization } = await getDashboardMemberContext(event, {})
  const rawBody = await readRequiredBody<unknown>(event)
  const body = validateTelemetryInput(rawBody)

  if (!body) {
    return jsonResponse({ ok: false, error: 'Invalid telemetry action' }, { status: 400 })
  }

  const idempotencyKey = crypto.randomUUID()
  await recordUsageEvent(db, {
    organizationId: organization.id,
    resource: 'dashboard_interaction',
    source: body.action,
    sessionId: organization.userId,
    quantity: 1,
    unit: 'interaction',
    metadata: {
      action: body.action,
      surface: body.surface ?? 'today',
      range: body.range ?? null,
      cardId: body.cardId ?? null,
      cardPriority: body.cardPriority ?? null,
      cardKind: body.cardKind ?? null,
      targetPath: body.targetPath ?? null,
      locationId: body.locationId ?? null,
      ...(body.metadata ?? {}),
    },
    idempotencyKey,
  })

  return jsonResponse({ ok: true })
})
